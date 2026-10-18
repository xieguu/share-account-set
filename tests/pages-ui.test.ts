import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
import type { RemoteSession } from '../src/browser.js';

test('Pages artifact and cross-site workspace: two members share login with separate canvas control', { timeout: 120_000 }, async t => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs']);
  const files = readdirSync('.pages', { recursive: true }).map(String);
  assert.equal(files.some(file => /\.env|\.sqlite|profile|node_modules|src[\\/]/.test(file)), false);
  assert.deepEqual(JSON.parse(readFileSync('.pages/app/connection-config.json', 'utf8')), { requireBackend: true });
  mkdirSync('test-results', { recursive: true });
  const lab = await startLab(0);
  const labOrigin = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const config: Config = { host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410', frontendOrigins: [],
    dataDir: mkdtempSync(resolve('test-results/pages-')), adminUser: 'admin', adminPassword: 'pages-admin-password-123',
    headless: true, idleMs: 60_000, maxContexts: 2, lab: false, labPort: 3411 };
  const runtime = createApp(config);
  const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  runtime.attach(server);
  const staticApp = new Hono();
  staticApp.use('/share-account-set/*', serveStatic({ root: './.pages', index: 'index.html',
    rewriteRequestPath: path => path.replace('/share-account-set/', '/') }));
  const frontend = serve({ fetch: staticApp.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await Promise.all([server, frontend].map(service => new Promise<void>(done => service.listening ? done() : service.once('listening', done))));
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const frontendOrigin = `http://localhost:${(frontend.address() as AddressInfo).port}`;
  config.frontendOrigins = [frontendOrigin];
  const workspaceUrl = `${frontendOrigin}/share-account-set/app/`;
  const env = runtime.store.addEnvironment({ name: 'Pages 共享环境', startUrl: `${labOrigin}/`, allowedOrigins: [labOrigin], maxSessions: 3 });
  for (const username of ['member_a', 'member_b']) {
    const member = runtime.store.addUser(username, 'pages-member-password-123', 'member');
    runtime.store.grant(member.id, env.id);
  }
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close(); await runtime.close();
    await Promise.all([server, frontend, lab].map(service => new Promise<void>(done => service.close(() => done()))));
  });
  const errors: string[] = [], frontendApiRequests: string[] = [], socketUrls: string[] = [];
  async function portal() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('websocket', socket => socketUrls.push(socket.url()));
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === frontendOrigin && /\/(api|ws)(\/|$)/.test(url.pathname)) frontendApiRequests.push(url.href);
    });
    const page = await context.newPage();
    await page.goto(workspaceUrl);
    await page.locator('#backend-config-button:not([disabled])').waitFor();
    return { context, page };
  }
  async function configure(page: Page) {
    await page.locator('#backend-config-button').click();
    await page.locator('#backend-address').fill(config.origin);
    await page.locator('#backend-save').click();
    await page.locator('#backend-dialog').waitFor({ state: 'hidden' });
  }
  async function signIn(page: Page, username: string) {
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(username === 'admin' ? config.adminPassword : 'pages-member-password-123');
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('[data-action=start]').waitFor();
  }
  async function openViewer(page: Page) {
    const opened = page.waitForEvent('popup');
    await page.locator('[data-action=start]').click();
    const viewer = await opened;
    await viewer.waitForURL('**/share-account-set/app/viewer.html?session=*');
    await viewer.locator('#placeholder').waitFor({ state: 'hidden' });
    assert.equal(await viewer.evaluate(() => window.opener === null), true);
    assert.equal(new URL(viewer.url()).searchParams.size, 1);
    return viewer;
  }
  async function remoteClick(viewer: Page, session: RemoteSession, selector: string) {
    const target = await session.testPage().locator(selector).boundingBox();
    const canvas = await viewer.locator('#screen').boundingBox(); assert.ok(target); assert.ok(canvas);
    await viewer.mouse.click(canvas.x + (target.x + target.width / 2) * canvas.width / 1280,
      canvas.y + (target.y + target.height / 2) * canvas.height / 800);
  }
  async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
      await new Promise(done => setTimeout(done, 25));
    }
  }
  const admin = await portal();
  assert.equal(await admin.page.locator('#login-form [type=submit]').isDisabled(), true);
  await admin.page.locator('#backend-config-button').click();
  await admin.page.locator('#backend-address').fill(`${config.origin}/wrong-path`);
  await admin.page.locator('#backend-save').click();
  await admin.page.locator('#backend-error').filter({ hasText: '不包含' }).waitFor();
  assert.equal(await admin.page.locator('#login-form [type=submit]').isDisabled(), true);
  await admin.page.route(`${config.origin}/api/health`, route => route.abort('failed'));
  await admin.page.locator('#backend-address').fill(config.origin);
  await admin.page.locator('#backend-save').click();
  await admin.page.locator('#backend-error').filter({ hasText: '无法连接' }).waitFor();
  assert.equal(await admin.page.evaluate(() => sessionStorage.length), 0, 'failed health check does not save configuration');
  await admin.page.unroute(`${config.origin}/api/health`);
  await admin.page.locator('#backend-save').click();
  await admin.page.locator('#backend-dialog').waitFor({ state: 'hidden' });
  await signIn(admin.page, 'admin');
  const adminViewer = await openViewer(admin.page);
  const adminSession = [...runtime.browsers.sessions.values()].find(session => session.user.username === 'admin')!;
  await remoteClick(adminViewer, adminSession, '#login');
  await adminSession.testPage().locator('#account').getByText('已登录 · demo-admin').waitFor();

  const a = await portal(), b = await portal();
  await configure(a.page); await signIn(a.page, 'member_a');
  await configure(b.page); await signIn(b.page, 'member_b');
  const viewerA = await openViewer(a.page), viewerB = await openViewer(b.page);
  const sessionA = [...runtime.browsers.sessions.values()].find(session => session.user.username === 'member_a')!;
  const sessionB = [...runtime.browsers.sessions.values()].find(session => session.user.username === 'member_b')!;
  for (const session of [sessionA, sessionB]) assert.match(await session.testPage().locator('#account').innerText(), /demo-admin/);
  await remoteClick(viewerA, sessionA, '#text'); await viewerA.keyboard.insertText('成员 A 的独立输入');
  await remoteClick(viewerB, sessionB, '#text'); await viewerB.keyboard.insertText('成员 B 的独立输入');
  await sessionA.testPage().waitForFunction(() => (document.querySelector('#text') as HTMLInputElement).value === '成员 A 的独立输入');
  await sessionB.testPage().waitForFunction(() => (document.querySelector('#text') as HTMLInputElement).value === '成员 B 的独立输入');
  for (const item of [admin, a, b]) {
    assert.deepEqual(await item.context.cookies(), [], 'cross-site login works without cookies');
    assert.equal(await item.page.evaluate(() => localStorage.length), 0, 'no persistent token in localStorage');
    const keys = await item.page.evaluate(() => Object.keys(sessionStorage));
    assert.equal(keys.length, 2);
    assert.ok(keys.every(key => key.startsWith(`relayhub:${workspaceUrl}`)));
  }
  const rawAuth = await a.page.evaluate(() => sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.endsWith(':auth'))!)!);
  const token = JSON.parse(rawAuth).token as string;
  assert.ok(socketUrls.length >= 3);
  assert.ok(socketUrls.every(url => new URL(url).searchParams.has('ticket') && !url.includes(token)));
  const previous = sessionA.controller;
  await viewerA.reload();
  await until(() => !!sessionA.controller && sessionA.controller !== previous, 'viewer reload inherits saved session authentication');
  await viewerA.locator('#placeholder').waitFor({ state: 'hidden' });
  await a.page.reload();
  await a.page.locator('#workspace').waitFor({ state: 'visible' });
  await a.page.locator('#environments-view [data-action=connect]').waitFor();
  await a.page.screenshot({ path: 'test-results/pages-workspace.png', fullPage: true });
  await viewerA.screenshot({ path: 'test-results/pages-remote.png', fullPage: true });
  await a.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await a.page.screenshot({ path: 'test-results/pages-mobile.png', fullPage: true });
  await a.page.locator('#logout').click();
  await a.page.locator('#login-screen').waitFor({ state: 'visible' });
  await viewerA.getByText('远程连接已断开', { exact: true }).waitFor();
  assert.ok(sessionB.controller, 'other member retains control');
  const denied = await fetch(`${config.origin}/api/me`, { headers: { Origin: frontendOrigin, Authorization: `Bearer ${token}` } });
  assert.equal(denied.status, 401);
  await viewerA.reload();
  await viewerA.getByText('无法连接窗口', { exact: true }).waitFor();
  assert.equal(await viewerA.locator('#placeholder').isVisible(), true);
  await a.page.locator('#backend-config-button').click();
  await a.page.locator('#backend-reset').click();
  await a.page.locator('#backend-config-button:not([disabled])').waitFor();
  assert.equal(await a.page.evaluate(() => sessionStorage.length), 0);
  assert.equal(await a.page.locator('#login-form [type=submit]').isDisabled(), true);
  assert.deepEqual(frontendApiRequests, [], 'static origin never receives API or WebSocket requests');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});
