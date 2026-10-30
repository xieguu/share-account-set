import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers/runtime.js';

test('members own private persistent environments and explicitly grant, revoke and pause access', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.request('/environments', f.owner, 'POST', { ...f.input, ownerId: f.otherUser.id });
  assert.equal(created.status, 201);
  const env = created.body.environment;
  assert.equal(env.ownerId, f.ownerUser.id); assert.equal(env.kind, 'server');
  assert.equal((await f.request('/environments', f.guest)).body.environments.length, 0);
  for (const path of [`/environments/${env.id}/grants`, `/environments/${env.id}/audit`]) assert.equal((await f.request(path, f.guest)).status, 404);
  for (const path of [`/environments/${env.id}`, `/environments/${env.id}/grants/${f.otherUser.id}`]) assert.equal((await f.request(path, f.guest, 'PUT', f.input)).status, 404);
  assert.equal((await f.request('/sessions', f.guest, 'POST', { environmentId: env.id })).status, 404);
  assert.equal((await f.request('/admin/environments', f.owner, 'POST', f.input)).status, 403);
  for (const url of ['http://127.0.0.1:9999', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://0x7f000001:9999']) {
    const response = await f.request('/environments', f.owner, 'POST', { ...f.input, startUrl: url, allowedOrigins: [url] });
    assert.equal(response.status, 400, url);
  }
  const first = await f.request('/sessions', f.owner, 'POST', { environmentId: env.id });
  assert.equal(first.status, 201);
  const ownerSession = f.runtime.browsers.server.sessions.get(first.body.session.id)!;
  await ownerSession.testPage().locator('#login').click();
  await ownerSession.testPage().locator('#account').getByText('已登录 · demo-admin').waitFor();
  assert.equal((await f.request(`/environments/${env.id}/grants/${f.guestUser.id}`, f.owner, 'PUT')).status, 200);
  const second = await f.request('/sessions', f.guest, 'POST', { environmentId: env.id });
  assert.equal(second.status, 201);
  const guestSession = f.runtime.browsers.server.sessions.get(second.body.session.id)!;
  assert.match(await guestSession.testPage().locator('#account').innerText(), /已登录/);
  const connection = await f.connect(guestSession.id, f.guest);
  await until(() => connection.frames.length > 0, 'real member frame');
  assert.equal((await f.request('/sessions', f.owner)).body.sessions.length, 2);
  assert.equal((await f.request(`/sessions/${ownerSession.id}`, f.guest)).status, 404);
  assert.equal((await f.request(`/environments/${env.id}/agent-key`, f.guest, 'POST')).status, 404);
  for (const path of [`/environments/${env.id}/cookies`, `/environments/${env.id}/export`, `/environments/${env.id}/profile`]) assert.equal((await f.request(path, f.guest)).status, 404);
  assert.equal((await f.request(`/sessions/${guestSession.id}/revoke-control`, f.owner, 'POST')).status, 200);
  await until(() => connection.ws.readyState === 3, 'owner revokes control');
  await f.connect(guestSession.id, f.guest);
  await f.request(`/environments/${env.id}/grants/${f.guestUser.id}`, f.owner, 'DELETE');
  assert.equal(f.runtime.browsers.sessions.has(guestSession.id), false);
  assert.equal((await f.request(`/sessions/${guestSession.id}/ticket`, f.guest, 'POST', { mode: 'control' })).status, 404);
  await f.request(`/environments/${env.id}/pause`, f.owner, 'POST', { paused: true });
  assert.equal(f.runtime.browsers.sessions.size, 0);
  assert.equal((await f.request('/sessions', f.owner, 'POST', { environmentId: env.id })).status, 409);
  await f.request(`/environments/${env.id}/pause`, f.admin, 'POST', { paused: false });
  const resumed = await f.request('/sessions', f.owner, 'POST', { environmentId: env.id });
  assert.equal(resumed.status, 201);
  assert.match(await f.runtime.browsers.server.sessions.get(resumed.body.session.id)!.testPage().locator('#account').innerText(), /已登录/);
  assert.ok(existsSync(join(f.config.dataDir, 'profiles', env.id)));
  const audit = (await f.request(`/environments/${env.id}/audit`, f.owner)).body.entries;
  for (const action of ['environment.create', 'grant.add', 'grant.revoke', 'control.revoke', 'environment.pause', 'environment.resume']) assert.ok(audit.some((entry: any) => entry.action === action), action);
  await f.request(`/admin/users/${f.ownerUser.id}/disable`, f.admin, 'POST');
  assert.equal(f.runtime.browsers.sessions.size, 0);
});

test('storageState import restores cookies, LocalStorage and IndexedDB into a fresh private profile', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const source = f.runtime.store.addEnvironment({ ...f.input, ownerId: f.ownerUser.id });
  const session = await f.runtime.browsers.server.create(source, f.ownerUser);
  await session.testPage().locator('#login').click();
  await session.testPage().locator('#account').getByText('已登录 · demo-admin').waitFor();
  await session.testPage().evaluate(async () => {
    localStorage.setItem('login-note', 'shared-local-storage');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('login-state', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('tokens');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('tokens', 'readwrite');
        tx.objectStore('tokens').put({ token: 'integration-token', at: new Date('2025-01-01') }, 'account');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
  });
  const state = await session.testPage().context().storageState({ indexedDB: true });
  state.cookies.push({ name: 'session-only', value: 'present-after-import', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' });
  await f.runtime.browsers.stopEnvironment(source.id);
  const payload = { environment: { ...f.input, name: 'Imported state' }, storageState: state, confirmSharedIdentity: true };
  assert.equal((await f.request('/environments/import', f.owner, 'POST', { ...payload, confirmSharedIdentity: false })).status, 400);
  const imported = await f.request('/environments/import', f.owner, 'POST', payload);
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const env = imported.body.environment;
  assert.notEqual(env.id, source.id); assert.equal(env.ownerId, f.ownerUser.id);
  assert.equal((await f.request('/environments', f.guest)).body.environments.length, 0);
  await f.request(`/environments/${env.id}/grants/${f.guestUser.id}`, f.owner, 'PUT');
  for (const token of [f.owner, f.guest]) {
    const created = await f.request('/sessions', token, 'POST', { environmentId: env.id });
    assert.equal(created.status, 201);
    const page = f.runtime.browsers.server.sessions.get(created.body.session.id)!.testPage();
    assert.match(await page.locator('#account').innerText(), /已登录/);
    assert.equal(await page.evaluate(() => localStorage.getItem('login-note')), 'shared-local-storage');
    assert.ok((await page.context().cookies()).some(cookie => cookie.name === 'session-only'));
    const tokenState = await page.evaluate(() => new Promise<any>((resolve, reject) => {
      const request = indexedDB.open('login-state');
      request.onsuccess = () => {
        const db = request.result, query = db.transaction('tokens').objectStore('tokens').get('account');
        query.onsuccess = () => { db.close(); resolve({ token: query.result.token, date: query.result.at.toISOString() }); };
        query.onerror = () => reject(query.error);
      }; request.onerror = () => reject(request.error);
    }));
    assert.deepEqual(tokenState, { token: 'integration-token', date: '2025-01-01T00:00:00.000Z' });
  }
  const before = f.runtime.store.environments().length;
  for (const invalid of [ { ...state, script: 'process.exit()' }, { ...state, origins: [{ origin: 'http://169.254.169.254', localStorage: [] }] },
    { ...state, cookies: [{ ...state.cookies[0], domain: '.other.test' }] }, 'C:/Users/profile', { cookies: [], origins: [], path: '../profile' },
    { cookies: [], origins: [{ origin: f.labOrigin, localStorage: [], indexedDB: [{ name: 'bad', version: 1,
      stores: [{ name: 'records', autoIncrement: false, records: [{ value: 'missing primary key' }], indexes: [] }] }] }] } ]) {
    assert.equal((await f.request('/environments/import', f.owner, 'POST', { ...payload, storageState: invalid })).status, 400);
    assert.equal(f.runtime.store.environments().length, before);
  }
  assert.equal((await f.request('/environments/import', f.owner, 'POST', { ...payload, padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  const audits = JSON.stringify(f.runtime.store.audits());
  assert.equal(audits.includes('integration-token'), false); assert.equal(audits.includes('shared-local-storage'), false);
});
