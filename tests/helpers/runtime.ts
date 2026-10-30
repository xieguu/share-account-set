import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../../src/app.js';
import { startLab } from '../../src/lab.js';
import type { Config } from '../../src/config.js';

export async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error(`Timeout: ${message}`);
}
export async function fixture(t: TestContext, tls?: { private: string; cert: string }) {
  mkdirSync('test-results', { recursive: true });
  const lab = await startLab(0);
  const labOrigin = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const config: Config = { host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410',
    dataDir: mkdtempSync(resolve('test-results/member-')), adminUser: 'admin', adminPassword: 'integration-admin-password',
    headless: true, idleMs: 60_000, maxContexts: 6, lab: false, labPort: 3411, trustedNetworkOrigins: [labOrigin] };
  const runtime = createApp(config);
  const server = (tls ? serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0,
    createServer: createHttpsServer, serverOptions: { key: tls.private, cert: tls.cert } })
    : serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 })) as Server;
  runtime.attach(server);
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
  config.origin = `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach(ws => ws.terminate()); await runtime.close();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => lab.close(() => r()))]);
  });
  async function request(path: string, token = '', method = 'GET', body?: unknown) {
    const response = await runtime.app.request(`${config.origin}/api${path}`, { method,
      headers: { Origin: config.origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function login(username: string, password = 'integration-member-password') {
    const result = await request('/login', '', 'POST', { username, password, authMode: 'token' });
    assert.equal(result.status, 200); return result.body.token as string;
  }
  const admin = await login('admin', config.adminPassword);
  const ownerUser = runtime.store.addUser('owner', 'integration-member-password', 'member');
  const guestUser = runtime.store.addUser('guest', 'integration-member-password', 'member');
  const otherUser = runtime.store.addUser('other', 'integration-member-password', 'member');
  const owner = await login('owner'), guest = await login('guest'), other = await login('other');
  async function connect(sessionId: string, token: string, mode = 'control') {
    const ticket = await request(`/sessions/${sessionId}/ticket`, token, 'POST', { mode });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const ws = new WebSocket(`${config.origin.replace(/^http/, 'ws')}/ws/sessions/${sessionId}?mode=${mode}&ticket=${ticket.body.ticket}`,
      { headers: { Origin: config.origin }, ...(tls ? { ca: tls.cert } : {}) });
    sockets.push(ws);
    const messages: any[] = [], frames: Buffer[] = [];
    let sequence = 0;
    ws.on('message', (data, binary) => {
      if (binary) { frames.push(Buffer.from(data as Buffer)); if (frames.length > 20) frames.shift(); ws.send(JSON.stringify({ type: 'frame_ack', sequence })); }
      else { const message = JSON.parse(data.toString()); messages.push(message); if (message.type === 'frame') sequence = message.sequence; }
    });
    await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); });
    await until(() => messages.some(message => message.type === 'state'), 'initial state');
    return { ws, messages, frames, send: (value: unknown) => ws.send(JSON.stringify(value)) };
  }
  return { runtime, config, labOrigin, request, login, connect, admin, owner, guest, other, ownerUser, guestUser, otherUser,
    input: { name: 'Member environment', startUrl: `${labOrigin}/`, allowedOrigins: [labOrigin], maxSessions: 3 } };
}
