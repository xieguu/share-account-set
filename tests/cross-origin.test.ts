import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { ConnectionTickets } from '../src/connection-auth.js';
import { startLab } from '../src/lab.js';

test('frontend configuration accepts exact origins and rejects ambiguous addresses', () => {
  const previous = { ...process.env };
  try {
    process.env.RELAY_ADMIN_PASSWORD = 'config-test-password-123';
    process.env.RELAY_ORIGIN = 'http://127.0.0.1:3410';
    process.env.RELAY_FRONTEND_ORIGINS = 'https://xieguu.github.io, https://portal.example';
    assert.deepEqual(loadConfig().frontendOrigins, ['https://xieguu.github.io', 'https://portal.example']);
    for (const value of ['*', 'https://*.example', 'https://portal.example/path', 'https://portal.example/',
      'https://portal.example?x=1', 'https://portal.example#x', 'https://user:pass@portal.example', 'file:///tmp',
      'https://portal.example,']) {
      process.env.RELAY_FRONTEND_ORIGINS = value;
      assert.throws(loadConfig, undefined, value);
    }
    process.env.RELAY_FRONTEND_ORIGINS = '';
    assert.deepEqual(loadConfig().frontendOrigins, []);
    delete process.env.RELAY_FRONTEND_ORIGINS;
    assert.equal(loadConfig().frontendOrigins, undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('connection ticket storage bounds, expiry and one-use binding', () => {
  const tickets = new ConnectionTickets();
  const binding = { token: 'login', sessionId: 'session', mode: 'view' as const, origin: 'https://portal.example' };
  for (let index = 0; index < 4; index++) tickets.issue(binding);
  assert.throws(() => tickets.issue(binding), /上限/);
  tickets.clear();
  for (let index = 0; index < 2048; index++) tickets.issue({ ...binding, sessionId: `session-${index}` });
  assert.throws(() => tickets.issue({ ...binding, sessionId: 'another' }), /服务上限/);
  tickets.revokeToken('login');
  const issued = tickets.issue(binding);
  assert.equal(tickets.consume(issued.ticket, binding), 'login');
  assert.throws(() => tickets.consume(issued.ticket, binding), /已使用/);
});

test('cross-origin API and one-use WebSocket tickets with real Chromium', { timeout: 120_000 }, async t => {
  mkdirSync('test-results', { recursive: true });
  const lab = await startLab(0);
  const labOrigin = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const frontendOrigin = 'https://xieguu.github.io';
  const otherFrontendOrigin = 'https://portal.example';
  const config: Config = {
    host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410',
    frontendOrigins: [frontendOrigin, otherFrontendOrigin], dataDir: mkdtempSync(resolve('test-results/cross-origin-')),
    adminUser: 'admin', adminPassword: 'cross-origin-password-123', headless: true,
    idleMs: 60_000, maxContexts: 2, lab: false, labPort: 3411,
  };
  config.trustedNetworkOrigins = [labOrigin];
  const runtime = createApp(config);
  const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  runtime.attach(server);
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    await runtime.close();
    await Promise.all([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => lab.close(() => resolve())),
    ]);
  });
  async function request(path: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string | null; authorization?: string } = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? frontendOrigin);
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.authorization !== undefined) headers.set('Authorization', options.authorization);
    if (options.cookie) headers.set('Cookie', options.cookie);
    const response = await fetch(`${config.origin}/api${path}`, {
      method: options.method || 'GET', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const credentials = { username: 'admin', password: config.adminPassword };
  async function tokenLogin(username = credentials.username, password = credentials.password) {
    const response = await request('/login', { method: 'POST', body: { username, password, authMode: 'token' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.body.token, /^[\w-]{43}$/);
    return response.body.token as string;
  }
  async function issue(sessionId: string, token: string, mode: 'control' | 'view' = 'view') {
    const response = await request(`/sessions/${sessionId}/ticket`, { method: 'POST', token, body: { mode } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.expiresAt > Date.now() && response.body.expiresAt <= Date.now() + 30_000);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.body.ticket as string;
  }
  function socket(sessionId: string, options: { ticket?: string; origin?: string; cookie?: string; mode?: string } = {}) {
    const query = new URLSearchParams({ mode: options.mode ?? 'view' });
    if (options.ticket !== undefined) query.set('ticket', options.ticket);
    const ws = new WebSocket(`${config.origin.replace('http:', 'ws:')}/ws/sessions/${sessionId}?${query}`, {
      headers: { Origin: options.origin ?? frontendOrigin, ...(options.cookie ? { Cookie: options.cookie } : {}) },
    });
    sockets.push(ws);
    ws.on('error', () => {});
    return ws;
  }
  async function refused(sessionId: string, expected: number, options: Parameters<typeof socket>[1] = {}) {
    const ws = socket(sessionId, options);
    await new Promise<void>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume(); ws.terminate();
        try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
      });
      ws.once('open', () => { ws.terminate(); reject(new Error('Rejected handshake unexpectedly opened')); });
      ws.once('error', error => { if (!String(error.message).includes('closed before')) reject(error); });
    });
  }
  async function connect(sessionId: string, options: Parameters<typeof socket>[1] = {}) {
    const ws = socket(sessionId, options);
    const messages: Record<string, unknown>[] = [];
    let sequence = 0;
    ws.on('message', (data, binary) => {
      if (binary) ws.send(JSON.stringify({ type: 'frame_ack', sequence }));
      else {
        const message = JSON.parse(data.toString()); messages.push(message);
        if (message.type === 'frame') sequence = message.sequence;
      }
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, messages };
  }
  async function waitFor(check: () => boolean, label: string) {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  let adminToken = '', adminCookie = '', envId = '', adminSessionId = '', memberToken = '', memberId = '', memberSessionId = '';
  await t.test('CORS allows exact configured origins without enabling cross-site cookies', async () => {
    const preflight = await fetch(`${config.origin}/api/login`, { method: 'OPTIONS', headers: {
      Origin: frontendOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), frontendOrigin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/);
    assert.match(preflight.headers.get('vary')!, /Origin/);
    for (const origin of ['https://evil.example', `${frontendOrigin}.evil.example`, 'null']) {
      assert.equal((await request('/health', { origin })).status, 403);
      assert.equal((await fetch(`${config.origin}/api/login`, { method: 'OPTIONS', headers: { Origin: origin } })).status, 403);
    }
    assert.equal((await request('/login', { method: 'POST', body: { ...credentials, authMode: 'token' }, origin: null })).status, 403);
    assert.equal((await request('/login', { method: 'POST', body: credentials })).status, 400);
    adminToken = await tokenLogin();
    const login = await request('/login', { method: 'POST', body: credentials, origin: config.origin });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/i);
    assert.equal(login.body.token, undefined);
    adminCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  await t.test('Bearer authentication is explicit and never falls back to a cookie', async () => {
    assert.equal((await request('/me', { token: adminToken })).status, 200);
    assert.equal((await request('/me', { cookie: adminCookie })).status, 401);
    assert.equal((await request('/me')).status, 401);
    assert.equal((await request('/me', { cookie: adminCookie, authorization: 'Bearer invalid', origin: config.origin })).status, 401);
    assert.equal((await request('/me', { cookie: adminCookie, authorization: `Bearer ${'A'.repeat(43)}`, origin: config.origin })).status, 401);
    assert.equal((await request('/me', { cookie: adminCookie, origin: config.origin })).status, 200);
    assert.equal((await request('/me', { token: adminToken, origin: 'https://evil.example' })).status, 403);
    const denial = await request('/me');
    assert.equal(denial.headers.get('access-control-allow-origin'), frontendOrigin);
    assert.match(denial.body.error, /Bearer/);
  });
  await t.test('remote environments exclude every portal origin and keep current member authorization', async () => {
    for (const origin of [config.origin, frontendOrigin, otherFrontendOrigin]) {
      const response = await request('/admin/environments', { method: 'POST', token: adminToken,
        body: { name: 'Forbidden portal', startUrl: origin, allowedOrigins: [origin] } });
      assert.equal(response.status, 400);
    }
    const env = await request('/admin/environments', { method: 'POST', token: adminToken,
      body: { name: 'Cross-origin lab', startUrl: `${labOrigin}/`, allowedOrigins: [labOrigin] } });
    assert.equal(env.status, 201); envId = env.body.environment.id;
    assert.equal((await request(`/admin/environments/${envId}`, { method: 'PUT', token: adminToken,
      body: { name: 'Forbidden edit', startUrl: frontendOrigin, allowedOrigins: [frontendOrigin] } })).status, 400);
    const member = await request('/admin/users', { method: 'POST', token: adminToken,
      body: { username: 'member', password: 'cross-member-password-123', environmentIds: [envId] } });
    assert.equal(member.status, 201); memberId = member.body.user.id;
    memberToken = await tokenLogin('member', 'cross-member-password-123');
    const adminSession = await request('/sessions', { method: 'POST', token: adminToken, body: { environmentId: envId } });
    assert.equal(adminSession.status, 201); adminSessionId = adminSession.body.session.id;
    const memberSession = await request('/sessions', { method: 'POST', token: memberToken, body: { environmentId: envId } });
    assert.equal(memberSession.status, 201); memberSessionId = memberSession.body.session.id;
    assert.equal((await request(`/sessions/${adminSessionId}/ticket`, { method: 'POST', token: memberToken, body: { mode: 'view' } })).status, 404);
    assert.equal((await request(`/sessions/${memberSessionId}/ticket`, { method: 'POST', token: memberToken, body: { mode: 'invalid' } })).status, 400);
  });
  await t.test('ticket connects across origins while cookie-only cross-origin WebSockets are refused', async () => {
    await refused(adminSessionId, 401);
    await refused(adminSessionId, 401, { cookie: adminCookie });
    await refused(adminSessionId, 403, { cookie: adminCookie, origin: 'https://evil.example' });
    const sameOrigin = await connect(adminSessionId, { cookie: adminCookie, origin: config.origin });
    sameOrigin.ws.close();
    const ticket = await issue(adminSessionId, adminToken, 'control');
    const controller = await connect(adminSessionId, { ticket, mode: 'control' });
    controller.ws.send(JSON.stringify({ type: 'ping', at: 123 }));
    await waitFor(() => controller.messages.some(message => message.type === 'pong' && message.at === 123), 'ticket controller ping');
    assert.equal((await request(`/sessions/${adminSessionId}/ticket`, { method: 'POST', token: adminToken, body: { mode: 'control' } })).status, 409);
    await refused(adminSessionId, 401, { ticket, mode: 'control' });
    controller.ws.close();
    await waitFor(() => !runtime.browsers.sessions.get(adminSessionId)?.controller, 'controller detach');
  });
  await t.test('tickets are bound to Origin, session and mode, and failed presentation consumes them', async () => {
    const wrongOrigin = await issue(adminSessionId, adminToken);
    await refused(adminSessionId, 403, { ticket: wrongOrigin, origin: otherFrontendOrigin });
    await refused(adminSessionId, 401, { ticket: wrongOrigin });
    const wrongMode = await issue(adminSessionId, adminToken);
    await refused(adminSessionId, 403, { ticket: wrongMode, mode: 'control' });
    const wrongSession = await issue(adminSessionId, adminToken);
    await refused(randomUUID(), 403, { ticket: wrongSession });
    await refused(adminSessionId, 401, { ticket: 'invalid', cookie: adminCookie, origin: config.origin });
    await refused(adminSessionId, 400, { mode: 'invalid', cookie: adminCookie, origin: config.origin });
  });
  await t.test('expired tickets are refused and pending ticket limits recover after consumption', async () => {
    const expired = await issue(adminSessionId, adminToken);
    const now = Date.now();
    const date = t.mock.method(Date, 'now', () => now + 30_001);
    try { await refused(adminSessionId, 401, { ticket: expired }); } finally { date.mock.restore(); }
    const pending = [];
    for (let index = 0; index < 4; index++) pending.push(await issue(adminSessionId, adminToken));
    assert.equal((await request(`/sessions/${adminSessionId}/ticket`, { method: 'POST', token: adminToken, body: { mode: 'view' } })).status, 429);
    for (const ticket of pending) {
      const client = await connect(adminSessionId, { ticket });
      client.ws.close();
    }
    const available = await issue(adminSessionId, adminToken);
    const client = await connect(adminSessionId, { ticket: available }); client.ws.close();
  });
  await t.test('logout invalidates outstanding tickets and only closes its own login connections', async () => {
    const secondLogin = await tokenLogin();
    const client = await connect(adminSessionId, { ticket: await issue(adminSessionId, secondLogin) });
    const pending = await issue(adminSessionId, secondLogin);
    const response = await request('/logout', { method: 'POST', token: secondLogin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    await waitFor(() => client.ws.readyState === WebSocket.CLOSED, 'logout closes matching ticket connection');
    await refused(adminSessionId, 401, { ticket: pending });
    assert.equal((await request('/me', { token: secondLogin })).status, 401);
    assert.equal((await request('/me', { token: adminToken })).status, 200);
  });
  await t.test('grant revocation and member disable are rechecked when consuming tickets', async () => {
    const ticket = await issue(memberSessionId, memberToken);
    assert.equal((await request(`/admin/users/${memberId}/grants/${envId}`, { method: 'DELETE', token: adminToken })).status, 200);
    await refused(memberSessionId, 404, { ticket });
    assert.equal((await request(`/sessions/${memberSessionId}/ticket`, { method: 'POST', token: memberToken, body: { mode: 'view' } })).status, 404);
    assert.equal((await request(`/admin/users/${memberId}/grants/${envId}`, { method: 'PUT', token: adminToken })).status, 200);
    const replacement = await request('/sessions', { method: 'POST', token: memberToken, body: { environmentId: envId } });
    assert.equal(replacement.status, 201); memberSessionId = replacement.body.session.id;
    const disabledTicket = await issue(memberSessionId, memberToken);
    assert.equal((await request(`/admin/users/${memberId}/disable`, { method: 'POST', token: adminToken })).status, 200);
    await refused(memberSessionId, 401, { ticket: disabledTicket });
    assert.equal((await request('/me', { token: memberToken })).status, 401);
  });
});
