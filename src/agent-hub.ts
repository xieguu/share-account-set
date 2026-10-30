import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { agentEventSchema, type AgentOperation } from './agent-protocol.js';
import { AppError, type Command } from './protocol.js';
import type { Environment, Store, User } from './store.js';
import type { Peer } from './peer.js';

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
class Device {
  ready = false;
  alive = true;
  readonly pending = new Map<string, Pending>();
  constructor(readonly ws: WebSocket, readonly token: string, readonly environmentId: string) {}
  request(operation: AgentOperation) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new AppError(409, '本地设备离线'));
    if (this.pending.size >= 128 || this.ws.bufferedAmount > 2_000_000) return Promise.reject(new AppError(429, '设备操作队列已满'));
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Cancel the device connection rather than leave a timed-out create running invisibly.
        this.ws.terminate();
        reject(new AppError(504, '本地设备响应超时，连接已关闭'));
      }, operation.operation === 'create' ? 90_000 : 45_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'request', id, ...operation }));
    });
  }
  dispose() {
    this.ready = false;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new AppError(409, '本地设备离线')); }
    this.pending.clear();
  }
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const streamSchema = z.object({ profile: z.enum(['economy', 'balanced', 'smooth']), fps: count, quality: count,
  captured: count, transmitted: count, suppressed: count, bytesSent: count, failures: count, failed: z.boolean(), visibleViewers: count });
const stateSchema = z.object({ type: z.literal('state'), activeTabId: z.string().uuid().optional(),
  session: z.object({ stream: streamSchema }),
  tabs: z.array(z.object({ id: z.string().uuid(), url: z.string().max(4096) })).max(5), control: z.boolean().optional() });
const otherEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('frame'), tabId: z.string().uuid(), sequence: z.number().int().positive(), bytes: z.number().int().min(0).max(1_500_000) }),
  z.object({ type: z.literal('pong'), at: z.number() }),
  z.object({ type: z.enum(['error', 'notice']), message: z.string().max(16000) }),
]);

export class AgentSession {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  lastUsed = Date.now();
  readonly sockets = new Set<Peer>();
  controller?: Peer;
  private peers = new Map<Peer, { id: string; attached: Promise<void> }>();
  private tabCount = 0;
  private stream: z.infer<typeof streamSchema> = { profile: 'balanced', fps: 8, quality: 70, captured: 0,
    transmitted: 0, suppressed: 0, bytesSent: 0, failures: 0, failed: false, visibleViewers: 0 };
  private closed = false;
  constructor(readonly env: Environment, readonly user: User, private device: Device, private onClosed: () => void) {}
  summary() {
    return { id: this.id, environmentId: this.env.id, environmentName: this.env.name, userId: this.user.id,
      username: this.user.username, createdAt: this.createdAt, clients: this.sockets.size, controlled: !!this.controller,
      tabs: this.tabCount, frames: this.stream.transmitted, captureFailures: this.stream.failures, streamFailed: this.stream.failed, stream: this.stream };
  }
  async initialize() {
    await this.device.request({ operation: 'create', sessionId: this.id, environment: { ...this.env, kind: 'local' }, user: { ...this.user, enabled: 1 } });
    // A revoke can arrive while Chromium is still creating the page. Close it after creation too.
    if (this.closed) {
      if (this.device.ready) await this.device.request({ operation: 'close', sessionId: this.id });
      throw new AppError(410, '创建期间窗口权限已撤销');
    }
  }
  attach(ws: Peer, control: boolean) {
    if (this.closed) throw new AppError(410, '窗口已关闭');
    if (control && this.controller) throw new AppError(409, '窗口已有操控连接');
    if (control) this.controller = ws;
    this.sockets.add(ws);
    this.lastUsed = Date.now();
    const id = randomUUID();
    const attached = this.device.request({ operation: 'attach', sessionId: this.id, peerId: id, control });
    this.peers.set(ws, { id, attached });
    void attached.catch(() => { ws.close(4003, '设备连接失败'); });
  }
  async detach(ws: Peer) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws); this.sockets.delete(ws);
    this.lastUsed = Date.now();
    // Keep the controller reserved until the device has released its held keys.
    try {
      await peer.attached;
      if (!this.closed && this.device.ready) await this.device.request({ operation: 'detach', sessionId: this.id, peerId: peer.id });
    } finally { if (this.controller === ws) this.controller = undefined; }
  }
  async revokeControl() { const ws = this.controller; if (ws) { await this.detach(ws); ws.close(4001, '所有者收回操控权'); } }
  async command(ws: Peer, command: Command) {
    const peer = this.peers.get(ws);
    if (!peer || this.closed) throw new AppError(410, '连接已关闭');
    if (!['ping', 'frame_ack', 'visibility'].includes(command.type) && ws !== this.controller) throw new AppError(403, '当前连接为只读观察模式');
    await peer.attached;
    if (!this.peers.has(ws)) throw new AppError(410, '连接已关闭');
    this.lastUsed = Date.now();
    await this.device.request({ operation: 'command', sessionId: this.id, peerId: peer.id, command });
  }
  receive(peerId: string, data: string, binary: boolean) {
    const ws = [...this.peers].find(([, peer]) => peer.id === peerId)?.[0];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2_000_000) { ws.close(4008, '连接传输过慢'); return; }
    if (binary) {
      const frame = Buffer.from(data, 'base64');
      if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) throw new Error('Invalid JPEG');
      ws.send(frame, { binary: true }); return;
    }
    const value = JSON.parse(data);
    if (value.type === 'state') {
      const state = stateSchema.parse(value);
      this.stream = state.session.stream;
      this.tabCount = state.tabs.length;
      ws.send(JSON.stringify({ ...state, viewport: { width: 1280, height: 800 }, session: this.summary() }));
    } else ws.send(JSON.stringify(otherEventSchema.parse(value)));
  }
  peerClosed(peerId: string) {
    const ws = [...this.peers].find(([, peer]) => peer.id === peerId)?.[0];
    if (ws) { ws.close(4000, '设备已关闭连接'); void this.detach(ws).catch(() => {}); }
  }
  disconnected(reason = '本地设备离线') {
    if (this.closed) return;
    this.closed = true;
    for (const ws of this.sockets) ws.close(4000, reason);
    this.sockets.clear(); this.peers.clear(); this.controller = undefined; this.onClosed();
  }
  async close(reason = '窗口已释放') {
    if (this.closed) return;
    this.disconnected(reason);
    if (this.device.ready) await this.device.request({ operation: 'close', sessionId: this.id });
  }
}

export class AgentHub {
  readonly sessions = new Map<string, AgentSession>();
  private devices = new Map<string, Device>();
  private allocating = new Set<string>();
  private stopping = new Set<string>();
  private timer: NodeJS.Timeout;
  constructor(private store: Store, private idleMs: number) {
    this.timer = setInterval(() => {
      for (const [id, device] of this.devices) {
        if (!device.alive || this.store.authenticateAgent(device.token)?.id !== id) { device.ws.terminate(); continue; }
        device.alive = false; device.ws.ping();
      }
      void this.cleanup().catch(error => console.error('[agent.cleanup]', error));
    }, 15_000);
    this.timer.unref();
  }
  connected(id: string) { return this.devices.has(id); }
  status(id: string) { return this.devices.get(id)?.ready ? 'online' : 'offline'; }
  accept(ws: WebSocket, token: string, env: Environment) {
    const device = new Device(ws, token, env.id);
    this.devices.set(env.id, device);
    const readyTimer = setTimeout(() => { if (!device.ready) ws.terminate(); }, 10_000);
    readyTimer.unref();
    ws.on('pong', () => { device.alive = true; });
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Expected JSON');
        if (this.store.authenticateAgent(token)?.id !== env.id) { ws.close(4003, 'Device credential revoked'); return; }
        const message = agentEventSchema.parse(JSON.parse(data.toString()));
        if (message.type === 'ready') {
          if (device.ready) throw new Error('Duplicate handshake');
          device.ready = true; clearTimeout(readyTimer);
          this.store.audit(env.ownerId, 'agent.online', env.id, env.id); return;
        }
        if (!device.ready) throw new Error('Handshake required');
        if (message.type === 'response') {
          const pending = device.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); device.pending.delete(message.id);
          if (message.error) pending.reject(new AppError(409, message.error)); else pending.resolve();
        } else {
          const session = this.sessions.get(message.sessionId);
          if (!session || session.env.id !== env.id) return;
          if (message.type === 'data') session.receive(message.peerId, message.data, message.binary);
          if (message.type === 'peerClosed') session.peerClosed(message.peerId);
          if (message.type === 'sessionClosed') session.disconnected('本地窗口已关闭');
        }
      } catch { ws.close(1008, 'Invalid device message'); }
    });
    ws.on('error', () => {}); // close below owns cleanup, including pending requests.
    ws.on('close', () => {
      clearTimeout(readyTimer); device.dispose();
      if (this.devices.get(env.id) === device) this.devices.delete(env.id);
      for (const session of [...this.sessions.values()]) if (session.env.id === env.id) session.disconnected();
      this.store.audit(env.ownerId, 'agent.offline', env.id, env.id);
    });
  }
  disconnect(id: string) {
    const device = this.devices.get(id);
    if (device) { device.ready = false; device.ws.terminate(); }
    for (const session of [...this.sessions.values()]) if (session.env.id === id) session.disconnected();
  }
  async create(env: Environment, user: User) {
    const device = this.devices.get(env.id);
    if (!device?.ready) throw new AppError(409, '本地设备离线，请启动 Local Agent');
    if (env.paused || this.stopping.has(env.id)) throw new AppError(409, '环境已暂停或正在停止');
    const key = `${env.id}:${user.id}`;
    if (this.allocating.has(key) || [...this.sessions.values()].some(session => session.env.id === env.id && session.user.id === user.id)) throw new AppError(409, '你在此环境已有窗口或正在创建');
    if ([...this.sessions.values()].filter(session => session.env.id === env.id).length >= env.maxSessions) throw new AppError(409, '并发窗口已满');
    this.allocating.add(key);
    const session = new AgentSession(env, user, device, () => this.sessions.delete(session.id));
    this.sessions.set(session.id, session); // Reserve capacity before awaiting the device.
    try { await session.initialize(); return session; }
    catch (error) { session.disconnected('创建失败'); throw error; }
    finally { this.allocating.delete(key); }
  }
  async stopEnvironment(id: string) {
    if (this.stopping.has(id)) throw new AppError(409, '环境正在停止');
    this.stopping.add(id);
    try {
      for (const session of [...this.sessions.values()]) if (session.env.id === id) session.disconnected('环境已停止');
      const device = this.devices.get(id);
      if (device?.ready) await device.request({ operation: 'stop' });
    } finally { this.stopping.delete(id); }
  }
  async cleanup() {
    for (const session of [...this.sessions.values()]) if (!session.sockets.size && Date.now() - session.lastUsed > this.idleMs) await session.close('闲置窗口已释放');
  }
  async close() {
    clearInterval(this.timer);
    const devices = [...this.devices.values()];
    await Promise.all(devices.map(device => new Promise<void>(resolve => { device.ws.once('close', resolve); device.ws.terminate(); })));
  }
}
