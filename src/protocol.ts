import { z } from 'zod';

const modifiers = z.object({ ctrl: z.boolean(), shift: z.boolean(), alt: z.boolean(), meta: z.boolean() }).partial();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mouse'), event: z.enum(['move','down','up','wheel','click','dblclick','contextmenu']),
    x: z.number().finite().min(0).max(1279), y: z.number().finite().min(0).max(799),
    button: z.enum(['left','right','middle','none']).optional(), buttons: z.number().int().min(0).max(7).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    deltaX: z.number().min(-4000).max(4000).optional(), deltaY: z.number().min(-4000).max(4000).optional(),
    modifiers: modifiers.optional(), targetId: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('key'), event: z.enum(['down','up','text']), key: z.string().max(64),
    code: z.string().max(64).optional(), keyCode: z.number().int().min(0).max(255).optional(),
    text: z.string().max(16000).optional(), modifiers: modifiers.optional(), targetId: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('navigate'), url: z.string().max(4096) }).strict(),
  z.object({ type: z.literal('nav'), action: z.enum(['back','forward','reload']) }).strict(),
  z.object({ type: z.literal('tab'), action: z.enum(['new','switch','close']), tabId: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('ping'), at: z.number() }).strict(),
  z.object({ type: z.literal('frame_ack'), sequence: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('visibility'), visible: z.boolean() }).strict(),
  z.object({ type: z.literal('stream'), profile: z.enum(['economy','balanced','smooth']) }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;

export class AppError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, '只允许 HTTP / HTTPS 地址');
  }
  return url.origin;
}
export function allowedUrl(value: string, origins: string[]): string {
  if (!origins.includes(normalizedOrigin(value))) throw new AppError(403, '该地址未加入账号环境的允许来源');
  return new URL(value).href;
}
