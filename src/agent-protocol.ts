import { z } from 'zod';
import { commandSchema } from './protocol.js';

const id = z.string().uuid();
export const environmentInputSchema = z.object({ name: z.string().trim().min(1).max(80),
  startUrl: z.url().max(4096), allowedOrigins: z.array(z.url().max(4096)).min(1).max(50),
  maxSessions: z.number().int().min(1).max(30).default(8) });
const environment = environmentInputSchema.extend({ id, ownerId: id, kind: z.literal('local'), paused: z.number().int().min(0).max(1) }).strict();
const user = z.object({ id, username: z.string().max(40), role: z.enum(['admin', 'member']), enabled: z.literal(1) }).strict();
const envelope = { type: z.literal('request'), id };
export const agentRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...envelope, operation: z.literal('create'), sessionId: id, environment, user }).strict(),
  z.object({ ...envelope, operation: z.literal('stop') }).strict(),
  z.object({ ...envelope, operation: z.literal('close'), sessionId: id }).strict(),
  z.object({ ...envelope, operation: z.literal('attach'), sessionId: id, peerId: id, control: z.boolean() }).strict(),
  z.object({ ...envelope, operation: z.literal('detach'), sessionId: id, peerId: id }).strict(),
  z.object({ ...envelope, operation: z.literal('command'), sessionId: id, peerId: id, command: commandSchema }).strict(),
]);
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentOperation = AgentRequest extends infer R ? R extends AgentRequest ? Omit<R, 'type' | 'id'> : never : never;
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), version: z.literal(1) }).strict(),
  z.object({ type: z.literal('response'), id, error: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal('data'), sessionId: id, peerId: id, binary: z.boolean(), data: z.string().max(2_000_000) }).strict(),
  z.object({ type: z.literal('peerClosed'), sessionId: id, peerId: id }).strict(),
  z.object({ type: z.literal('sessionClosed'), sessionId: id }).strict(),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Plain WS is an explicit development option restricted to numeric loopback addresses. */
export function agentWebSocketUrl(server: string, insecureLoopback = false) {
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Agent server must be an HTTP(S) origin');
  if (url.protocol !== 'https:' && !(insecureLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Local Agent requires HTTPS/WSS; plain HTTP is allowed only with explicit numeric-loopback development mode');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/agent';
  return url.href;
}
