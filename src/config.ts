import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(3410),
  origin: z.url().default('http://127.0.0.1:3410'),
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
