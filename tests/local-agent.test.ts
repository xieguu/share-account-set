import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { generate } from 'selfsigned';
import { fixture, until } from './helpers/runtime.js';
import { agentWebSocketUrl } from '../src/agent-protocol.js';

test('Local Agent rejects plaintext remote connections and ambiguous server URLs', () => {
  for (const url of ['http://example.com', 'http://localhost:3410', 'https://user:secret@example.com', 'https://example.com/other', 'https://example.com/?token=secret']) {
    assert.throws(() => agentWebSocketUrl(url, true), url);
  }
  assert.throws(() => agentWebSocketUrl('http://127.0.0.1:3410'));
  assert.equal(agentWebSocketUrl('http://127.0.0.1:3410', true), 'ws://127.0.0.1:3410/ws/agent');
  assert.equal(agentWebSocketUrl('https://relay.example.com'), 'wss://relay.example.com/ws/agent');
});

test('Windows-compatible Agent CLI over verified WSS: separate pages, shared identity, revoke, offline and local persistence', { timeout: 150_000 }, async t => {
  const tls = await generate([{ name: 'commonName', value: '127.0.0.1' }], { algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] });
  const f = await fixture(t, tls);
  const visits: { path: string; cookie: string }[] = [], records: { path: string; value: string; cookie: string }[] = [];
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://lab');
    if (url.pathname === '/login') {
      res.writeHead(302, { 'Set-Cookie': 'device_identity=owner-login; HttpOnly; Path=/; Max-Age=3600', Location: '/' }); res.end(); return;
    }
    if (url.pathname === '/record') {
      records.push({ path: url.searchParams.get('path')!, value: url.searchParams.get('value')!, cookie: req.headers.cookie || '' }); res.end('ok'); return;
    }
    visits.push({ path: url.pathname, cookie: req.headers.cookie || '' });
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body style="background:#fff"><a href="/login" style="position:absolute;left:20px;top:20px;width:180px;height:50px">Login</a>
      <input id="value" style="position:absolute;left:20px;top:120px;width:260px;height:40px">
      <button id="save" style="position:absolute;left:20px;top:200px;width:160px;height:45px">Record</button>
      <script>document.querySelector('#save').onclick=()=>fetch('/record?path='+encodeURIComponent(location.pathname)+'&value='+encodeURIComponent(document.querySelector('#value').value));</script>`);
  });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  f.config.trustedNetworkOrigins!.push(origin);
  const created = await f.request('/environments', f.owner, 'POST', { ...f.input, name: 'My device', kind: 'local', startUrl: `${origin}/`, allowedOrigins: [origin] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const env = created.body.environment;
  assert.equal((await f.request('/environments', f.owner)).body.environments[0].status, 'offline');
  assert.equal((await f.request('/sessions', f.owner, 'POST', { environmentId: env.id })).status, 409);
  assert.equal((await f.request(`/environments/${env.id}/agent-key`, f.guest, 'POST')).status, 404);
  const registration = await f.request(`/environments/${env.id}/agent-key`, f.owner, 'POST');
  assert.equal(registration.status, 200);
  assert.equal(JSON.stringify(f.runtime.store.db.prepare('SELECT * FROM agent_keys').all()).includes(registration.body.token), false);
  const directory = mkdtempSync(resolve('test-results/device-')), profileRoot = join(directory, 'data');
  mkdirSync(profileRoot);
  const configFile = join(directory, 'device.json'), caFile = join(directory, 'ca.pem');
  writeFileSync(configFile, JSON.stringify(registration.body), { mode: 0o600 }); writeFileSync(caFile, tls.cert);
  let child: ChildProcess | undefined;
  let output = '';
  function start() {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/agent-cli.ts', '--config', configFile, '--data-dir', profileRoot,
      '--headless', '--trusted-origin', origin], { cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', data => { output += data.toString(); }); child.stderr!.on('data', data => { output += data.toString(); });
  }
  async function stopChild() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const process = child;
      await new Promise<void>(r => { process.once('exit', () => r()); process.kill(); });
    }
  }
  t.after(async () => { await stopChild(); await new Promise<void>(r => site.close(() => r())); });
  async function create(token: string) {
    const response = await f.request('/sessions', token, 'POST', { environmentId: env.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.session.id as string, client: await f.connect(response.body.session.id, token) };
  }
  start();
  await until(() => f.runtime.browsers.agents.status(env.id) === 'online', 'device ready with certificate validation', 30_000);
  const owner = await create(f.owner);
  await until(() => owner.client.frames.length > 0, 'real device JPEG');
  owner.client.send({ type: 'mouse', event: 'click', x: 50, y: 40, button: 'left' });
  await until(() => visits.some(visit => visit.cookie.includes('device_identity=owner-login')), 'device browser login');
  for (const member of [f.guestUser, f.otherUser]) await f.request(`/environments/${env.id}/grants/${member.id}`, f.owner, 'PUT');
  const a = await create(f.guest), b = await create(f.other);
  assert.equal((await f.request('/sessions', f.admin, 'POST', { environmentId: env.id })).status, 409);
  const command = (client: typeof a.client, path: string, value: string) => {
    client.send({ type: 'navigate', url: `${origin}${path}` });
    client.send({ type: 'mouse', event: 'click', x: 60, y: 140, button: 'left' });
    client.send({ type: 'key', event: 'text', key: '', text: value });
    client.send({ type: 'mouse', event: 'click', x: 60, y: 220, button: 'left' });
  };
  command(a.client, '/a', 'member A 中文'); command(b.client, '/b', 'member B');
  await until(() => records.length === 2, 'independent device input');
  assert.deepEqual(records.map(record => [record.path, record.value]).sort(), [['/a', 'member A 中文'], ['/b', 'member B']]);
  assert.ok(records.every(record => record.cookie.includes('device_identity=owner-login')));
  await until(() => a.client.frames.length > 0 && b.client.frames.length > 0, 'two independent streams');
  assert.ok(a.client.messages.some(message => message.type === 'state' && message.tabs.some((tab: any) => tab.url === `${origin}/a`)));
  assert.equal(a.client.messages.some(message => message.type === 'state' && message.tabs.some((tab: any) => tab.url === `${origin}/b`)), false);
  const observer = await f.connect(b.id, f.owner, 'view');
  observer.send({ type: 'key', event: 'text', key: '', text: 'unauthorized' });
  await until(() => observer.messages.some(message => message.type === 'error'), 'observer input denied');
  b.client.send({ type: 'evaluate', script: 'process.exit()' });
  await until(() => b.client.messages.some(message => message.type === 'error'), 'script command rejected');
  assert.equal((await f.request(`/sessions/${a.id}`, f.other)).status, 404);
  await f.request(`/sessions/${b.id}/revoke-control`, f.owner, 'POST');
  await until(() => b.client.ws.readyState === 3, 'device control revoked');
  await f.request(`/environments/${env.id}/grants/${f.guestUser.id}`, f.owner, 'DELETE');
  await until(() => a.client.ws.readyState === 3, 'grant removal closes device page');
  assert.equal((await f.request('/sessions', f.guest, 'POST', { environmentId: env.id })).status, 404);
  await f.request(`/environments/${env.id}/pause`, f.owner, 'POST', { paused: true });
  assert.equal(f.runtime.browsers.sessions.size, 0);
  assert.equal((await f.request('/environments', f.owner)).body.environments[0].status, 'paused');
  assert.equal((await f.request('/sessions', f.other, 'POST', { environmentId: env.id })).status, 409);
  await f.request(`/environments/${env.id}/pause`, f.owner, 'POST', { paused: false });
  await create(f.owner);
  assert.ok(visits.at(-1)!.cookie.includes('device_identity=owner-login'), 'local profile persisted after pause');
  await stopChild();
  await until(() => f.runtime.browsers.agents.status(env.id) === 'offline', 'offline state');
  assert.equal(f.runtime.browsers.sessions.size, 0);
  assert.equal(existsSync(join(f.config.dataDir, 'profiles', env.id)), false, 'never copied device profile to server');
  assert.ok(existsSync(join(profileRoot, 'profiles', env.id)));
  start(); await until(() => f.runtime.browsers.agents.status(env.id) === 'online', 'device reconnect', 30_000);
  await create(f.owner);
  assert.ok(visits.at(-1)!.cookie.includes('device_identity=owner-login'));
  await f.request(`/environments/${env.id}/agent-key`, f.owner, 'DELETE');
  await until(() => f.runtime.browsers.agents.status(env.id) === 'offline', 'device key revoked');
  await new Promise<void>((r, reject) => {
    const ws = new WebSocket(`${f.config.origin.replace('https:', 'wss:')}/ws/agent`, { ca: tls.cert, headers: { Authorization: `Bearer ${registration.body.token}` } });
    ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); r(); });
    ws.on('open', () => { ws.terminate(); reject(new Error('revoked key accepted')); }); ws.on('error', () => {});
  });
  assert.equal(output.includes(registration.body.token), false);
  const audit = (await f.request(`/environments/${env.id}/audit`, f.owner)).body.entries;
  for (const action of ['agent.online', 'agent.offline', 'agent.key.rotate', 'agent.key.revoke']) assert.ok(audit.some((entry: any) => entry.action === action));
  writeFileSync(join(directory, 'agent-log.txt'), output);
});
