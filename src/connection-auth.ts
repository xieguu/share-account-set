import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './protocol.js';

type TicketBinding = { token: string; sessionId: string; mode: 'control' | 'view'; origin: string };
type TicketRecord = TicketBinding & { expiresAt: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Short-lived, one-use credentials for browser WebSocket handshakes. */
export class ConnectionTickets {
  private readonly entries = new Map<string, TicketRecord>();

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  issue(binding: TicketBinding) {
    this.prune();
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.token === binding.token && entry.sessionId === binding.sessionId) pending++;
    }
    if (pending >= 4) throw new AppError(429, '此登录的窗口连接票据已达上限，请等待票据使用或过期');
    if (this.entries.size >= 2048) throw new AppError(429, '连接票据已达服务上限，请稍后重试');
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30_000;
    this.entries.set(hash(ticket), { ...binding, expiresAt });
    return { ticket, expiresAt };
  }

  consume(ticket: string, expected: Omit<TicketBinding, 'token'>): string {
    if (!/^[\w-]{43}$/.test(ticket)) throw new AppError(401, '连接票据格式不正确');
    const key = hash(ticket);
    const entry = this.entries.get(key);
    // Every presentation consumes a known ticket, including failed binding checks.
    this.entries.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) throw new AppError(401, '连接票据无效、已使用或已过期');
    if (entry.sessionId !== expected.sessionId || entry.mode !== expected.mode || entry.origin !== expected.origin) {
      throw new AppError(403, '连接票据与窗口、模式或请求来源不匹配');
    }
    return entry.token;
  }

  revokeToken(token: string) {
    for (const [key, entry] of this.entries) if (entry.token === token) this.entries.delete(key);
  }

  clear() { this.entries.clear(); }
}
