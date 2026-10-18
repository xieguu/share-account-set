import { resolve } from 'node:path';
import { z } from 'zod';

const originSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !value.includes('*') && value === url.origin;
  } catch { return false; }
}, '必须是精确的 HTTP(S) Origin，不能包含路径、凭据、查询参数或通配符');

const schema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(3410),
  origin: originSchema.default('http://127.0.0.1:3410'),
  frontendOrigins: z.array(originSchema).max(20).optional(),
  dataDir: z.string().default('./data'),
  adminUser: z.string().min(2).default('admin'),
  adminPassword: z.string().min(12),
  headless: z.boolean().default(true),
  channel: z.string().optional(),
  idleMs: z.number().positive().default(900_000),
  maxContexts: z.number().int().positive().default(6),
  lab: z.boolean().default(false),
  labPort: z.coerce.number().int().min(1).max(65535).default(3411),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  return schema.parse({
    host: process.env.RELAY_HOST,
    port: process.env.RELAY_PORT,
    origin: process.env.RELAY_ORIGIN,
    frontendOrigins: process.env.RELAY_FRONTEND_ORIGINS === undefined ? undefined
      : process.env.RELAY_FRONTEND_ORIGINS.trim() === '' ? []
      : process.env.RELAY_FRONTEND_ORIGINS.split(',').map(value => value.trim()),
    dataDir: resolve(process.env.RELAY_DATA_DIR || './data'),
    adminUser: process.env.RELAY_ADMIN_USER,
    adminPassword: process.env.RELAY_ADMIN_PASSWORD,
    headless: process.env.RELAY_HEADLESS !== 'false',
    channel: process.env.RELAY_BROWSER_CHANNEL || undefined,
    idleMs: Number(process.env.RELAY_IDLE_MINUTES || 15) * 60_000,
    maxContexts: Number(process.env.RELAY_MAX_CONTEXTS || 6),
    lab: process.env.RELAY_LAB === 'true',
    labPort: process.env.RELAY_LAB_PORT,
  });
}
