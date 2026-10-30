import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { startLab } from './lab.js';

const config = loadConfig();
if (config.lab) config.trustedNetworkOrigins = [...(config.trustedNetworkOrigins || []),
  `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.labPort}`];
const runtime = createApp(config);
const server = serve({ fetch: runtime.app.fetch, hostname: config.host, port: config.port });
runtime.attach(server as Server);
const lab = config.lab ? await startLab(config.labPort, config.host) : undefined;
if (lab && !runtime.store.environments().length) {
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.labPort}`;
  runtime.store.addEnvironment({ name: '共享会话验证站', startUrl: `${url}/`, allowedOrigins: [url], maxSessions: 8 });
}
console.log(`RelayHub listening at ${config.origin}`);
if (lab) console.log(`Local verification site listening on port ${config.labPort}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
  await Promise.all([
    new Promise<void>(resolve => server.close(() => resolve())),
    lab ? new Promise<void>(resolve => lab.close(() => resolve())) : Promise.resolve(),
  ]);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
