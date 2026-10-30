import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import type { Peer } from './peer.js';
import type { Config } from './config.js';
import type { Environment, User } from './store.js';
import { AppError, allowedUrl, type Command } from './protocol.js';
import { dispatchCdpKeyEvent, dispatchCdpMouseEvent } from './vendor/remotebrowser/cdp.js';
import { FrameStream } from './frame-stream.js';
import { NetworkPolicy } from './network-policy.js';
import type { StorageState } from './storage-state.js';

type Tab = { id: string; page: Page; cdp: CDPSession };
type Runtime = { context: BrowserContext; lastUsed: number };
export class RemoteSession {
  readonly id: string;
  readonly createdAt = Date.now();
  lastUsed = Date.now();
  readonly tabs = new Map<string, Tab>();
  readonly sockets = new Set<Peer>();
  controller?: Peer;
  activeTabId?: string;
  private closed = false;
  private releasingControl = false;
  private readonly stream = new FrameStream(error => this.report(error));
  private operations: Promise<unknown> = Promise.resolve();
  private readonly heldKeys = new Map<string, Extract<Command, {type:'key'}>>();
  private heldMouse?: Extract<Command, {type:'mouse'}>;
  private pendingTabs = 0;
  onClosed?: () => void;

  constructor(readonly env: Environment, readonly user: User, private context: BrowserContext, id: string = randomUUID()) { this.id = id; }

  async initialize() {
    const tab = await this.createTab();
    await tab.page.goto(this.env.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  private async createTab() {
    this.checkTabLimit();
    this.pendingTabs++;
    try { return await this.adopt(await this.context.newPage()); }
    finally { this.pendingTabs--; }
  }
  private checkTabLimit() {
    if (this.closed) throw new AppError(410, '窗口已关闭');
    if (this.tabs.size + this.pendingTabs >= 5) throw new AppError(409, '每个窗口最多 5 个标签页');
  }
  private async adopt(page: Page): Promise<Tab> {
    if (this.closed) { await page.close(); throw new AppError(410, '窗口已关闭'); }
    const tab: Tab = { id: randomUUID(), page, cdp: await this.context.newCDPSession(page) };
    await page.setViewportSize({ width: 1280, height: 800 });
    await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (this.activeTabId) await this.releaseInput();
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    page.on('popup', popup => {
      this.handlePopup(popup).catch(error => this.report(error));
    });
    page.on('dialog', dialog => {
      this.broadcast({ type: 'notice', message: `网页弹窗：${dialog.message()}` });
      dialog.dismiss().catch(error => this.report(error));
    });
    page.on('download', download => {
      download.cancel().catch(error => this.report(error));
      this.broadcast({ type: 'notice', message: '当前版本未接入文件下载通道' });
    });
    page.on('filechooser', () => this.broadcast({ type: 'notice', message: '当前版本未接入文件上传通道' }));
    page.on('domcontentloaded', () => this.publish());
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.publish(); });
    page.on('close', () => {
      this.tabs.delete(tab.id);
      if (this.activeTabId === tab.id) this.activeTabId = this.tabs.keys().next().value;
      if (!this.closed && !this.tabs.size) void this.close('最后一个标签页已关闭');
      else this.publish();
    });
    this.publish();
    return tab;
  }
  private async handlePopup(page: Page) {
    try { this.checkTabLimit(); }
    catch (error) { await page.close(); throw error; }
    this.pendingTabs++;
    try { await this.enqueue(() => this.adopt(page)); }
    finally { this.pendingTabs--; }
  }

  summary() {
    const stream = this.stream.snapshot();
    return { id: this.id, environmentId: this.env.id, environmentName: this.env.name,
      userId: this.user.id, username: this.user.username, createdAt: this.createdAt,
      clients: this.sockets.size, controlled: !!this.controller, tabs: this.tabs.size,
      frames: stream.transmitted, captureFailures: stream.failures, streamFailed: stream.failed, stream };
  }
  state() {
    return { type: 'state', session: this.summary(), activeTabId: this.activeTabId,
      viewport: { width: 1280, height: 800 },
      tabs: [...this.tabs.values()].map(tab => ({ id: tab.id, url: tab.page.url() })) };
  }
  private broadcast(message: unknown) {
    const text = JSON.stringify(message);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
  publish() {
    this.stream.select(this.activeTabId ? this.tabs.get(this.activeTabId) : undefined);
    if (!this.closed) this.broadcast(this.state());
  }
  private report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[browser:${this.id}] ${message}`);
    this.broadcast({ type: 'error', message });
  }
  attach(ws: Peer, control: boolean) {
    if (this.closed) throw new AppError(410, '窗口已关闭');
    if (control && (this.controller || this.releasingControl)) throw new AppError(409, '此窗口已有操控连接，请先关闭原连接');
    if (control) this.controller = ws;
    this.sockets.add(ws);
    this.lastUsed = Date.now();
    ws.send(JSON.stringify({ ...this.state(), control }));
    this.stream.add(ws);
    this.publish();
  }
  async detach(ws: Peer) {
    if (this.controller === ws) {
      // Do not accept a new controller until all pressed keys/buttons are released.
      this.controller = undefined;
      this.releasingControl = true;
      try { await this.enqueue(() => this.releaseInput()); }
      finally { this.releasingControl = false; }
    }
    this.sockets.delete(ws);
    this.stream.remove(ws);
    this.lastUsed = Date.now();
    this.publish();
  }
  async revokeControl() {
    const ws = this.controller;
    if (ws) { await this.detach(ws); ws.close(4001, '管理员已收回操控权'); }
  }
  private activeTab() {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (!tab) throw new AppError(410, '标签页已关闭');
    return tab;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    // Keep ordering after an error while returning that error to the original caller.
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private async releaseInput() {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (tab && !tab.page.isClosed()) {
      for (const key of this.heldKeys.values()) {
        await dispatchCdpKeyEvent(tab.page, tab.cdp, { ...key, event: 'up' });
      }
      if (this.heldMouse) await dispatchCdpMouseEvent(tab.cdp, { ...this.heldMouse, event: 'up' });
    }
    this.heldKeys.clear();
    this.heldMouse = undefined;
  }
  async command(ws: Peer, command: Command) {
    if (!this.sockets.has(ws) || this.closed) throw new AppError(410, '连接已关闭');
    if (command.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: command.at }));
      return;
    }
    if (command.type === 'frame_ack') { this.stream.acknowledge(ws, command.sequence); return; }
    if (command.type === 'visibility') { this.stream.visible(ws, command.visible); return; }
    await this.enqueue(() => this.execute(ws, command));
  }
  private async execute(ws: Peer, command: Command) {
    if (this.closed || !this.sockets.has(ws)) throw new AppError(410, '连接已关闭');
    if (ws !== this.controller) throw new AppError(403, '当前连接为只读观察模式');
    if ((command.type === 'mouse' || command.type === 'key') && command.targetId && command.targetId !== this.activeTabId) {
      throw new AppError(409, '页面已切换，请等待新画面后操作');
    }
    this.lastUsed = Date.now();
    const tab = this.activeTab();
    switch (command.type) {
      case 'mouse':
        await dispatchCdpMouseEvent(tab.cdp, command);
        if (command.event === 'down') this.heldMouse = command;
        if (command.event === 'up') this.heldMouse = undefined;
        return;
      case 'key':
        await dispatchCdpKeyEvent(tab.page, tab.cdp, command);
        if (command.event === 'down') this.heldKeys.set(command.code || command.key, command);
        if (command.event === 'up') this.heldKeys.delete(command.code || command.key);
        return;
      case 'stream':
        this.stream.configure(command.profile);
        break;
      case 'navigate':
        await this.releaseInput();
        await tab.page.goto(allowedUrl(command.url, this.env.allowedOrigins), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      case 'nav':
        await this.releaseInput();
        if (command.action === 'back') await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (command.action === 'forward') await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (command.action === 'reload') await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      case 'tab':
        await this.releaseInput();
        if (command.action === 'new') {
          const newTab = await this.createTab();
          await newTab.page.goto(this.env.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } else {
          const target = command.tabId && this.tabs.get(command.tabId);
          if (!target) throw new AppError(404, '标签页不属于此窗口');
          if (command.action === 'switch') this.activeTabId = target.id;
          else await target.page.close();
        }
        break;
    }
    this.publish();
  }
  async close(reason = '窗口已释放') {
    if (this.closed) return;
    this.closed = true;
    this.stream.close();
    for (const ws of this.sockets) ws.close(4000, reason);
    this.sockets.clear();
    const results = await Promise.allSettled([...this.tabs.values()].map(tab => tab.page.close()));
    results.forEach(result => { if (result.status === 'rejected') console.error(result.reason); });
    this.tabs.clear();
    this.onClosed?.();
  }
  // Runtime integration tests inspect only the dedicated local test browser.
  testPage() { return this.activeTab().page; }
}

export class BrowserService {
  readonly sessions = new Map<string, RemoteSession>();
  private readonly runtimes = new Map<string, Promise<Runtime>>();
  private readonly pending = new Map<string, number>();
  private readonly stopping = new Set<string>();
  private readonly reaper: NodeJS.Timeout;
  private closed = false;

  constructor(private config: Config) {
    this.reaper = setInterval(() => {
      this.cleanup().catch(error => console.error('[cleanup]', error));
    }, Math.min(30_000, config.idleMs));
    this.reaper.unref();
  }
  private runtime(env: Environment): Promise<Runtime> {
    const existing = this.runtimes.get(env.id);
    if (existing) return existing;
    if (this.runtimes.size >= this.config.maxContexts) throw new AppError(409, '运行中的账号环境已达到上限');
    const promise = this.launch(env);
    this.runtimes.set(env.id, promise);
    void promise.catch(() => { if (this.runtimes.get(env.id) === promise) this.runtimes.delete(env.id); });
    return promise;
  }
  private async launch(env: Environment): Promise<Runtime> {
    const path = join(this.config.dataDir, 'profiles', env.id);
    mkdirSync(path, { recursive: true });
    const proxy = await new NetworkPolicy(this.config.trustedNetworkOrigins).proxy(env.allowedOrigins);
    let context: BrowserContext;
    try { context = await chromium.launchPersistentContext(path, {
      headless: this.config.headless, channel: this.config.channel,
      viewport: { width: 1280, height: 800 }, acceptDownloads: false,
      serviceWorkers: 'block',
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }); } catch (error) { await proxy.close(); throw error; }
    context.on('close', () => void proxy.close().catch(error => console.error('[proxy.close]', error)));
    try {
      await context.route('**/*', async route => {
        let permitted = false;
        try { allowedUrl(route.request().url(), env.allowedOrigins); permitted = true; } catch { /* Deny by policy. */ }
        if (permitted) await route.continue();
        else await route.abort('blockedbyclient');
      });
      // WebSockets bypass HTTP routing, so enforce the same exact-origin policy explicitly.
      await context.routeWebSocket('**/*', ws => {
        const httpUrl = ws.url().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
        try { allowedUrl(httpUrl, env.allowedOrigins); ws.connectToServer(); }
        catch { ws.close({ code: 1008, reason: 'Origin is not allowed' }); }
      });
      for (const page of context.pages()) await page.close();
      const runtime = { context, lastUsed: Date.now() };
      context.on('close', () => {
        this.runtimes.delete(env.id);
        for (const session of this.sessions.values()) if (session.env.id === env.id) void session.close('账号环境已停止');
      });
      return runtime;
    } catch (error) { await context.close(); throw error; }
  }
  async create(env: Environment, user: User, sessionId?: string) {
    if (env.paused) throw new AppError(409, '环境已暂停共享');
    if (this.closed || this.stopping.has(env.id)) throw new AppError(409, '账号环境正在停止');
    const used = [...this.sessions.values()].filter(session => session.env.id === env.id).length;
    const pending = this.pending.get(env.id) || 0;
    if (used + pending >= env.maxSessions) throw new AppError(409, '此账号环境的并发窗口已满');
    const owned = [...this.sessions.values()].find(session => session.env.id === env.id && session.user.id === user.id);
    if (owned) throw new AppError(409, '此账号环境已有你的窗口，请连接现有窗口');
    const pendingKey = `${env.id}:${user.id}`;
    if (this.pending.has(pendingKey)) throw new AppError(409, '你的窗口正在创建');
    this.pending.set(pendingKey, 1);
    this.pending.set(env.id, pending + 1);
    let session: RemoteSession | undefined;
    try {
      const runtime = await this.runtime(env);
      if (this.closed || this.stopping.has(env.id)) throw new AppError(409, '账号环境正在停止');
      session = new RemoteSession(env, user, runtime.context, sessionId);
      const id = session.id;
      session.onClosed = () => { this.sessions.delete(id); runtime.lastUsed = Date.now(); };
      await session.initialize();
      this.sessions.set(id, session);
      return session;
    } catch (error) { if (session) await session.close('创建窗口失败'); throw error; }
    finally {
      this.pending.delete(pendingKey);
      const count = (this.pending.get(env.id) || 1) - 1;
      if (count) this.pending.set(env.id, count); else this.pending.delete(env.id);
    }
  }
  get(id: string, user: User) {
    const session = this.sessions.get(id);
    if (!session || (user.role !== 'admin' && session.user.id !== user.id && session.env.ownerId !== user.id)) throw new AppError(404, '窗口不存在');
    return session;
  }
  async importState(env: Environment, state: StorageState) {
    if (this.runtimes.has(env.id)) throw new AppError(409, '只能导入到全新的环境');
    try {
      const runtime = await this.runtime(env);
      // Playwright 1.61 restores structured data, including its IndexedDB serialization, itself.
      await runtime.context.setStorageState(state);
    } catch (error) { await this.stopEnvironment(env.id); throw error; }
  }
  discardNewProfile(id: string) {
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(id)) throw new Error('Invalid environment ID');
    const root = resolve(this.config.dataDir, 'profiles');
    const path = resolve(root, id);
    if (!path.startsWith(root + sep)) throw new Error('Profile path outside data directory');
    rmSync(path, { recursive: true, force: true });
  }
  status(envId: string) { return this.runtimes.has(envId) ? 'running' : 'stopped'; }
  async stopEnvironment(envId: string) {
    if (this.stopping.has(envId)) throw new AppError(409, '账号环境正在停止');
    this.stopping.add(envId);
    try {
      for (const session of [...this.sessions.values()]) if (session.env.id === envId) await session.close('管理员停止了账号环境');
      const runtime = this.runtimes.get(envId);
      if (runtime) await (await runtime).context.close();
    } finally { this.stopping.delete(envId); }
  }
  async cleanup() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.sockets.size && now - session.lastUsed > this.config.idleMs) await session.close('闲置窗口已自动释放');
    }
    for (const [id, promise] of this.runtimes) {
      if (this.pending.get(id) || this.stopping.has(id)) continue;
      const runtime = await promise;
      if (![...this.sessions.values()].some(session => session.env.id === id) && now - runtime.lastUsed > this.config.idleMs) {
        await this.stopEnvironment(id);
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.reaper);
    const results = await Promise.allSettled([...this.runtimes.keys()].map(id => this.stopEnvironment(id)));
    results.forEach(result => { if (result.status === 'rejected') console.error(result.reason); });
  }
}
