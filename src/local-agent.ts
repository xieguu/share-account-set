import { WebSocket } from 'ws';
import { z } from 'zod';
import { resolve } from 'node:path';
import { BrowserService } from './browser.js';
import type { Config } from './config.js';
import type { Peer } from './peer.js';
import { agentRequestSchema, agentWebSocketUrl, type AgentEvent } from './agent-protocol.js';
import { NetworkPolicy } from './network-policy.js';
import { AppError } from './protocol.js';

export const agentConfigSchema = z.object({ version: z.literal(1), server: z.url(), environmentId: z.string().uuid(),
  token: z.string().regex(/^[\w-]{43}$/) }).strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentOptions = { dataDir: string; headless?: boolean; channel?: string; insecureLoopback?: boolean; trustedNetworkOrigins?: string[] };

class TunnelPeer implements Peer {
  readyState: number = WebSocket.OPEN;
  constructor(private socket: WebSocket, readonly sessionId: string, readonly id: string, private emit: (event: AgentEvent) => void) {}
  get bufferedAmount() { return this.socket.bufferedAmount; }
  send(data: string | Buffer, options?: { binary?: boolean }) {
    if (this.readyState !== WebSocket.OPEN) return;
    const binary = options?.binary === true;
    this.emit({ type: 'data', sessionId: this.sessionId, peerId: this.id, binary,
      data: binary ? Buffer.from(data).toString('base64') : data.toString() });
  }
  close() {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    this.emit({ type: 'peerClosed', sessionId: this.sessionId, peerId: this.id });
  }
  terminate() { this.close(); }
}

/** Outbound-only device connection; its BrowserService never exposes CDP or an HTTP API. */
export class LocalAgent {
  private socket?: WebSocket;
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private browser?: BrowserService;
  private cleanup: Promise<void> = Promise.resolve();
  private delay = 1000;
  private readonly url: string;
  constructor(private config: AgentConfig, private options: AgentOptions) {
    agentConfigSchema.parse(config);
    this.url = agentWebSocketUrl(config.server, options.insecureLoopback);
  }
  start() {
    if (this.socket || this.stopped) throw new Error('Agent already started or stopped');
    this.connect();
  }
  private connect() {
    const socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.config.token}` },
      maxPayload: 32_000, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.socket = socket;
    const peers = new Map<string, TunnelPeer>();
    let pending = 0;
    const emit = (event: AgentEvent) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 4_000_000) { socket.close(4008, 'Relay transport congested'); return; }
      socket.send(JSON.stringify(event));
    };
    const armHeartbeat = () => {
      clearTimeout(this.heartbeat);
      this.heartbeat = setTimeout(() => socket.terminate(), 45_000);
      this.heartbeat.unref();
    };
    socket.on('open', () => {
      const config: Config = { host: '127.0.0.1', port: 3410, origin: this.config.server,
        dataDir: resolve(this.options.dataDir), headless: this.options.headless ?? false, channel: this.options.channel,
        trustedNetworkOrigins: this.options.trustedNetworkOrigins, adminUser: 'unused', adminPassword: 'unused-local-agent',
        idleMs: 900_000, maxContexts: 1, lab: false, labPort: 3411 };
      this.browser = new BrowserService(config);
      this.delay = 1000; armHeartbeat();
      emit({ type: 'ready', version: 1 });
      console.log('Local Agent connected. Profile remains on this device.');
    });
    socket.on('ping', armHeartbeat);
    socket.on('message', (data, binary) => {
      if (binary || ++pending > 128) { socket.close(1008, 'Invalid or excessive device requests'); return; }
      void (async () => {
        const input = agentRequestSchema.safeParse(JSON.parse(data.toString()));
        if (!input.success) { socket.close(1008, 'Invalid device request'); return; }
        const request = input.data;
        try {
          const browser = this.browser;
          if (!browser || socket.readyState !== WebSocket.OPEN) throw new AppError(409, '设备未连接');
          switch (request.operation) {
            case 'create': {
              if (request.environment.id !== this.config.environmentId) throw new AppError(403, '环境与设备凭据不匹配');
              await new NetworkPolicy(this.options.trustedNetworkOrigins).validate(request.environment.allowedOrigins);
              const session = await browser.create(request.environment, request.user, request.sessionId);
              const closed = session.onClosed;
              session.onClosed = () => {
                closed?.();
                for (const [id, peer] of peers) if (peer.sessionId === session.id) peers.delete(id);
                emit({ type: 'sessionClosed', sessionId: session.id });
              };
              break;
            }
            case 'stop':
              await browser.stopEnvironment(this.config.environmentId); peers.clear(); break;
            case 'close':
              await browser.sessions.get(request.sessionId)?.close(); break;
            case 'attach': {
              const session = browser.sessions.get(request.sessionId);
              if (!session) throw new AppError(404, '窗口不存在');
              if (peers.has(request.peerId)) throw new AppError(409, '连接已存在');
              const peer = new TunnelPeer(socket, request.sessionId, request.peerId, emit);
              session.attach(peer, request.control); peers.set(peer.id, peer); break;
            }
            case 'detach': {
              const peer = peers.get(request.peerId);
              if (peer?.sessionId === request.sessionId) {
                await browser.sessions.get(request.sessionId)?.detach(peer);
                peer.close(); peers.delete(peer.id);
              }
              break;
            }
            case 'command': {
              const session = browser.sessions.get(request.sessionId), peer = peers.get(request.peerId);
              if (!session || !peer || peer.sessionId !== session.id) throw new AppError(404, '窗口连接不存在');
              await session.command(peer, request.command); break;
            }
          }
          emit({ type: 'response', id: request.id });
        } catch (error) {
          // Do not send filesystem paths, profile contents, tokens or Playwright call logs to the relay.
          emit({ type: 'response', id: request.id, error: error instanceof AppError ? error.message : '本地浏览器操作失败，请检查网站连通性及设备浏览器安装' });
        }
      })().catch(() => socket.close(1008, 'Malformed request')).finally(() => pending--);
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if ([401, 403, 409].includes(response.statusCode || 0)) {
        this.stopped = true;
        console.error(`Local Agent registration rejected (${response.statusCode}); check or rotate the device configuration.`);
      }
      socket.terminate();
    });
    socket.on('error', () => { console.error('Local Agent connection failed; check server address, certificate and connectivity.'); });
    socket.on('close', () => {
      clearTimeout(this.heartbeat);
      const browser = this.browser; this.browser = undefined; this.socket = undefined;
      peers.clear();
      this.cleanup = browser ? browser.close() : Promise.resolve();
      void this.cleanup.then(() => {
        if (this.stopped) return;
        console.log('Local Agent offline. Local windows closed; retrying connection.');
        this.reconnect = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 30_000);
      }).catch(error => { this.stopped = true; console.error('Local Agent browser cleanup failed:', error); });
    });
  }
  async close() {
    this.stopped = true; clearTimeout(this.reconnect); clearTimeout(this.heartbeat);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => { socket.once('close', resolve); socket.terminate(); });
    await this.cleanup;
  }
}
