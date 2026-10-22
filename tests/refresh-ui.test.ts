import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { chromium, type Page } from 'playwright';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';

test('workspace refresh stays current without overlapping or hidden polling', { timeout: 60_000 }, async t => {
  mkdirSync('test-results', { recursive: true });
  const config: Config = { host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410',
    dataDir: mkdtempSync(resolve('test-results/refresh-')), adminUser: 'admin', adminPassword: 'refresh-admin-password-123',
    headless: true, idleMs: 60_000, maxContexts: 2, lab: false, labPort: 3411 };
  const runtime = createApp(config);
  const env = runtime.store.addEnvironment({ name: 'Refresh fixture', startUrl: 'https://example.com/',
    allowedOrigins: ['https://example.com'], maxSessions: 3 });
  const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  runtime.attach(server);
  await new Promise<void>(done => server.listening ? done() : server.once('listening', done));
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  const errors: string[] = [];
  t.after(async () => {
    await browser.close(); await runtime.close();
    await new Promise<void>(done => server.close(() => done()));
  });
  async function portal() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(config.origin);
    await page.locator('#login-form [name=username]').fill('admin');
    await page.locator('#login-form [name=password]').fill(config.adminPassword);
    return { context, page };
  }
  async function signIn(page: Page) {
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
  }
  async function ready(page: Page) {
    await page.locator('#environments-view [data-action=start]').waitFor();
    await page.locator('#refresh:not([disabled])').waitFor();
  }
  await t.test('slow reads do not accumulate timer-driven refreshes', async () => {
    const { context, page } = await portal();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let reached!: () => void;
    const started = new Promise<void>(done => { reached = done; });
    let requests = 0;
    try {
      await signIn(page); await ready(page);
      await page.route(`${config.origin}/api/environments`, async route => {
        requests++; reached(); await gate; await route.continue();
      });
      await page.locator('#refresh').click(); await started;
      await page.clock.runFor(21_000);
      assert.equal(requests, 1, 'the next poll must wait for the active read to settle');
      assert.equal(await page.locator('#refresh').isDisabled(), true);
      release();
      await page.locator('#refresh:not([disabled])').waitFor();
      assert.equal(await page.locator('#workspace-service-status.offline').count(), 0);
    } finally { release(); await context.close(); }
  });
  await t.test('initial data failure reports offline and recovers on the next poll', async () => {
    const { context, page } = await portal();
    let requests = 0;
    try {
      await page.route(`${config.origin}/api/environments`, route => {
        requests++;
        return requests === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture temporarily unavailable"}' }) : route.continue();
      });
      await signIn(page);
      await page.locator('#workspace-service-status.offline').waitFor();
      assert.equal(await page.locator('#environments-view article').count(), 0);
      await page.clock.runFor(7001);
      await page.locator('#environments-view [data-action=start]').waitFor({ timeout: 1500 });
      assert.equal(await page.locator('#workspace-service-status.offline').count(), 0);
      assert.equal(requests, 2);
    } finally { await context.close(); }
  });
  await t.test('navigation cancels an obsolete audit read and the next view loads independently', async () => {
    const { context, page } = await portal();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let reached!: () => void;
    const started = new Promise<void>(done => { reached = done; });
    const url = `${config.origin}/api/admin/audit`;
    try {
      await signIn(page); await ready(page);
      await page.route(url, async route => { reached(); await gate; await route.continue(); });
      await page.locator('[data-view=audit]').click(); await started;
      const cancelled = page.waitForEvent('requestfailed', { predicate: request => request.url() === url, timeout: 1500 });
      await page.locator('[data-view=members]').click();
      try { await cancelled; } finally { release(); }
      await page.locator('#members-view td').getByText('admin', { exact: true }).waitFor();
      assert.equal(await page.locator('#workspace-service-status.offline').count(), 0);
      assert.equal(await page.locator('#toast').isVisible(), false, 'cancelled reads do not display a network error');
    } finally { release(); await context.close(); }
  });
  await t.test('audit failure marks the snapshot offline without applying partial counts', async () => {
    const { context, page } = await portal();
    const extra = { name: 'Uncommitted snapshot', startUrl: 'https://example.com/', allowedOrigins: ['https://example.com'], maxSessions: 3 };
    let extraId: string | undefined;
    try {
      await signIn(page); await ready(page);
      const previous = await page.locator('#stat-environments').innerText();
      extraId = runtime.store.addEnvironment(extra).id;
      await page.route(`${config.origin}/api/admin/audit`, route => route.fulfill({ status: 503,
        contentType: 'application/json', body: '{"error":"audit temporarily unavailable"}' }));
      await page.locator('[data-view=audit]').click();
      await page.locator('#toast').filter({ hasText: 'audit temporarily unavailable' }).waitFor();
      assert.equal(await page.locator('#workspace-service-status.offline').count(), 1);
      assert.equal(await page.locator('#stat-environments').innerText(), previous);
    } finally {
      if (extraId) runtime.store.deleteEnvironment(extraId);
      await context.close();
    }
  });
  await t.test('hidden workspaces pause polling and refresh immediately when visible', async () => {
    const { context, page } = await portal();
    let requests = 0;
    try {
      await signIn(page); await ready(page);
      page.on('request', request => { if (request.url().endsWith('/api/environments')) requests++; });
      // Deterministic Page Visibility events; this does not emulate OS tab scheduling.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.runFor(21_000);
      assert.equal(requests, 0);
      runtime.store.updateEnvironment(env.id, { ...env, name: 'Updated while hidden' });
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.getByRole('heading', { name: 'Updated while hidden', exact: true }).waitFor({ timeout: 1500 });
      assert.equal(requests, 1);
    } finally { runtime.store.updateEnvironment(env.id, env); await context.close(); }
  });
  await t.test('revoked login stops polling and returns to the login form with a reason', async () => {
    const { context, page } = await portal();
    let requests = 0;
    try {
      await signIn(page); await ready(page);
      const cookie = (await context.cookies()).find(cookie => cookie.name === 'relayhub_session');
      assert.ok(cookie);
      runtime.store.logout(cookie.value);
      page.on('request', request => { if (request.url().endsWith('/api/environments')) requests++; });
      await page.locator('#refresh').click();
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      assert.match(await page.locator('#login-error').innerText(), /请先登录/);
      assert.equal(await page.locator('#login-form [type=submit]').isDisabled(), false);
      await page.clock.runFor(21_000);
      assert.equal(requests, 1);
      assert.equal(await page.locator('#environments-view article').count(), 0);
    } finally { await context.close(); }
  });
  assert.deepEqual(errors, []);
});
