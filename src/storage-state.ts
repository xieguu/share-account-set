import { z } from 'zod';
import { AppError, normalizedOrigin } from './protocol.js';

export const IMPORT_LIMIT = 2 * 1024 * 1024;
const text = z.string().max(262_144);
const name = z.string().max(1024);
const keyPath = { keyPath: name.optional(), keyPathArray: z.array(name).max(32).optional() };
const record = z.object({ key: z.unknown().optional(), keyEncoded: z.unknown().optional(),
  value: z.unknown().optional(), valueEncoded: z.unknown().optional() }).strict().superRefine((value, ctx) => {
  if ('key' in value && 'keyEncoded' in value || ('value' in value) === ('valueEncoded' in value)) {
    ctx.addIssue({ code: 'custom', message: 'IndexedDB record must have exactly one value representation' });
  }
});
const database = z.object({ name, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stores: z.array(z.object({ name, autoIncrement: z.boolean(), ...keyPath,
    records: z.array(record).max(10_000), indexes: z.array(z.object({ name, ...keyPath,
      multiEntry: z.boolean(), unique: z.boolean() }).strict()).max(64) }).strict()).max(128) }).strict();
const schema = z.object({
  cookies: z.array(z.object({ name: name.min(1), value: text, domain: z.string().min(1).max(253),
    path: z.string().startsWith('/').max(4096), expires: z.number().finite().refine(value => value === -1 || value >= 0),
    httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
    partitionKey: z.url().optional() }).strict()).max(1000),
  origins: z.array(z.object({ origin: z.url().max(4096),
    localStorage: z.array(z.object({ name, value: text }).strict()).max(2000),
    indexedDB: z.array(database).max(64).optional() }).strict()).max(50),
}).strict();
export type StorageState = z.infer<typeof schema>;

/** JSON data only. Never accepts a filename, profile directory, executable function or restore script. */
export function parseStorageState(value: unknown, allowedOrigins: string[]): StorageState {
  let nodes = 0;
  function inspect(item: unknown, depth = 0) {
    if (++nodes > 100_000 || depth > 40) throw new AppError(400, '会话状态超过结构或深度限制');
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new AppError(400, '会话状态包含不支持的对象字段');
        inspect(child, depth + 1);
      }
    }
  }
  inspect(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, '文件不符合受支持的 Playwright storageState JSON 格式');
  const state = parsed.data;
  const hosts = new Set(allowedOrigins.map(origin => new URL(origin).hostname));
  for (const cookie of state.cookies) {
    // No parent-domain widening: add the cookie's exact base domain to the environment explicitly.
    const domain = cookie.domain.replace(/^\./, '');
    if (!hosts.has(domain) || /[\s/:@]/.test(domain)) throw new AppError(400, 'Cookie 域名未加入允许来源');
    if (cookie.partitionKey && !allowedOrigins.includes(normalizedOrigin(cookie.partitionKey))) throw new AppError(400, 'Cookie 分区来源未获授权');
  }
  const seen = new Set<string>();
  for (const origin of state.origins) {
    if (origin.origin !== normalizedOrigin(origin.origin) || !allowedOrigins.includes(origin.origin) || seen.has(origin.origin)) {
      throw new AppError(400, '会话状态含有未授权、重复或非标准来源');
    }
    seen.add(origin.origin);
  }
  return state;
}
