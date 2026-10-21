import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { chromium, type Page } from 'playwright';
import { createApp } from '../src/app.js';
import { startLab } from '../src/lab.js';
import type { Config } from '../src/config.js';

test('connection lifecycle across a separate frontend and two real backends', { timeout: 60_000 }, async t => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs']);
  mkdirSync('test-results', { recursive: true });
  const lab = await startLab(0);
  const labOrigin = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const staticApp = new Hono();
  staticApp.use('/share-account-set/*', serveStatic({ root: './.pages', index: 'index.html',
    rewriteRequestPath: path => path.replace('/share-account-set/', '/') }));
  const frontend = serve({ fetch: staticApp.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await new Promise<void>(done => frontend.listening ? done() : frontend.once('listening', done));
  const frontendOrigin = `http://localhost:${(frontend.address() as AddressInfo).port}`;
  const workspaceUrl = `${frontendOrigin}/share-account-set/app/`;
  const backends: { runtime: ReturnType<typeof createApp>; server: Server; config: Config }[] = [];
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    for (const { runtime } of backends) await runtime.close();
    await Promise.all([frontend, lab, ...backends.map(item => item.server)]
      .map(server => new Promise<void>(done => server.close(() => done()))));
  });
  for (let index = 0; index < 2; index++) {
    const config: Config = { host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410',
      frontendOrigins: [frontendOrigin], dataDir: mkdtempSync(resolve('test-results/connection-')),
      adminUser: 'admin', adminPassword: 'connection-admin-password-123', headless: true,
      idleMs: 60_000, maxContexts: 2, lab: false, labPort: 3411 };
    const runtime = createApp(config);
    const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    runtime.attach(server);
    backends.push({ runtime, server, config });
    await new Promise<void>(done => server.listening ? done() : server.once('listening', done));
    config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    runtime.store.addEnvironment({ name: `Backend ${index + 1}`, startUrl: `${labOrigin}/`, allowedOrigins: [labOrigin], maxSessions: 3 });
  }
  const first = backends[0]!, second = backends[1]!;
  const errors: string[] = [];
  async function portal(clockSkew = false) {
    const context = await browser.newContext();
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    if (clockSkew) await context.addInitScript('const actualNow = Date.now; Date.now = () => actualNow() + 300000;');
    const page = await context.newPage();
    await page.goto(workspaceUrl);
    await page.locator('#backend-config-button:not([disabled])').click();
    await page.locator('#backend-address').fill(first.config.origin);
    await page.locator('#backend-save').click();
    await page.locator('#backend-dialog').waitFor({ state: 'hidden' });
    await signIn(page);
    return { context, page };
  }
  async function signIn(page: Page) {
    await page.locator('#login-form [name=username]').fill('admin');
    await page.locator('#login-form [name=password]').fill(first.config.adminPassword);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#environments-view [data-action=start]').waitFor();
  }
  async function authentication(page: Page) {
    return page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.endsWith(':auth'));
      return key ? JSON.parse(sessionStorage.getItem(key)!) as { backend: string; token: string } : null;
    });
  }
  await t.test('expired login can exit immediately and sign in again', async () => {
    const { context, page } = await portal();
    try {
      const auth = await authentication(page); assert.ok(auth);
      first.runtime.store.db.prepare('UPDATE logins SET expires=? WHERE token=?')
        .run(Date.now() - 1, createHash('sha256').update(auth.token).digest('hex'));
      assert.equal(first.runtime.store.authenticate(auth.token), undefined);
      await page.locator('#logout').click();
      await page.locator('#login-screen').waitFor({ state: 'visible', timeout: 1500 });
      assert.equal(await authentication(page), null);
      await signIn(page);
      assert.ok(first.runtime.store.authenticate((await authentication(page))!.token));
    } finally { await context.close(); }
  });
  await t.test('closing backend settings cancels a pending check without logging out or changing service', async () => {
    const { context, page } = await portal();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let reached!: () => void;
    const started = new Promise<void>(done => { reached = done; });
    const healthUrl = `${second.config.origin}/api/health`;
    await page.route(healthUrl, async route => { reached(); await gate; await route.continue(); });
    try {
      const auth = await authentication(page); assert.ok(auth);
      await page.locator('#workspace-backend-button').click();
      await page.locator('#backend-address').fill(second.config.origin);
      await page.locator('#backend-save').click();
      await started;
      const cancelled = page.waitForEvent('requestfailed', { predicate: request => request.url() === healthUrl, timeout: 1500 });
      await page.locator('#backend-dialog .dialog-close').click();
      try { await cancelled; } finally { release(); }
      assert.equal(await page.locator('#workspace').isVisible(), true);
      assert.deepEqual(await authentication(page), auth);
      assert.ok(first.runtime.store.authenticate(auth.token));
      await page.locator('#workspace-backend-button').click();
      assert.equal(await page.locator('#backend-address').inputValue(), first.config.origin);
    } finally { release(); await context.close(); }
  });
  await t.test('failed logout blocks backend replacement and preserves the current login', async () => {
    const { context, page } = await portal();
    try {
      const auth = await authentication(page); assert.ok(auth);
      await page.route(`${first.config.origin}/api/logout`, route => route.abort('failed'));
      await page.locator('#workspace-backend-button').click();
      await page.locator('#backend-address').fill(second.config.origin);
      await page.locator('#backend-save').click();
      await page.locator('#backend-error').filter({ hasText: '无法连接' }).waitFor();
      assert.deepEqual(await authentication(page), auth);
      assert.ok(first.runtime.store.authenticate(auth.token));
      assert.equal(await page.locator('#workspace').isVisible(), true);
    } finally { await context.close(); }
  });
  await t.test('valid backend replacement revokes the previous login before saving the new address', async () => {
    const { context, page } = await portal();
    try {
      const auth = await authentication(page); assert.ok(auth);
      await page.locator('#workspace-backend-button').click();
      await page.locator('#backend-address').fill(second.config.origin);
      await page.locator('#backend-save').click();
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      assert.equal(first.runtime.store.authenticate(auth.token), undefined);
      assert.equal(await authentication(page), null);
      assert.equal(await page.locator('#connection-target').innerText(), second.config.origin);
      await signIn(page);
      assert.ok(second.runtime.store.authenticate((await authentication(page))!.token));
      await page.getByRole('heading', { name: 'Backend 2', exact: true }).waitFor();
    } finally { await context.close(); }
  });
  await t.test('remote connection accepts valid server tickets when the client clock is five minutes ahead', async () => {
    const { context, page } = await portal(true);
    try {
      const popup = page.waitForEvent('popup');
      await page.locator('[data-action=start]').click();
      const viewer = await popup;
      await viewer.waitForURL('**/viewer.html?session=*');
      await viewer.locator('#placeholder').waitFor({ state: 'hidden', timeout: 4000 });
      const sessionId = new URL(viewer.url()).searchParams.get('session')!;
      assert.ok(first.runtime.browsers.sessions.get(sessionId)?.controller);
      const old = first.runtime.browsers.sessions.get(sessionId)!.controller;
      old!.terminate();
      await viewer.locator('#placeholder').waitFor({ state: 'visible' });
      await viewer.locator('#placeholder').waitFor({ state: 'hidden', timeout: 4000 });
      assert.notEqual(first.runtime.browsers.sessions.get(sessionId)!.controller, old);
    } finally { await context.close(); }
  });
  assert.deepEqual(errors, []);
});
