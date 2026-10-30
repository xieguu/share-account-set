import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { LocalAgent, agentConfigSchema } from './local-agent.js';
import { normalizedOrigin } from './protocol.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-dir': { type: 'string' },
  headless: { type: 'boolean' }, 'allow-insecure-loopback': { type: 'boolean' },
  'trusted-origin': { type: 'string', multiple: true }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('npm run agent -- --config relayhub-agent.json [--data-dir PATH] [--headless]\nLocal development only: --allow-insecure-loopback --trusted-origin http://127.0.0.1:3411');
} else {
  if (!values.config) throw new Error('--config is required; download a device configuration from your environment in RelayHub');
  const config = agentConfigSchema.parse(JSON.parse(readFileSync(values.config, 'utf8')));
  const agent = new LocalAgent(config, { dataDir: resolve(values['data-dir'] || `${homedir()}/.relayhub-agent`),
    headless: values.headless, insecureLoopback: values['allow-insecure-loopback'],
    trustedNetworkOrigins: values['trusted-origin']?.map(normalizedOrigin) });
  agent.start();
  process.on('SIGINT', () => void agent.close());
  process.on('SIGTERM', () => void agent.close());
}
