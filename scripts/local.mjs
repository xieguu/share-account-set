import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { values } = parseArgs({ options: { 'with-agent': { type: 'boolean' }, help: { type: 'boolean' } } });

async function run(label, entry, args = []) {
  console.log(`\n[local] ${label}`);
  await new Promise((done, reject) => {
    // Use Node and an argv array on every OS; no cmd.exe / shell interpolation.
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${label} failed (${signal || code})`)));
  });
}

async function main() {
  if (values.help) {
    console.log('npm run local [-- --with-agent]\nInstall locked dependencies and Chromium, preserve/create .env, build and start the complete local workspace.\n--with-agent explicitly enables HTTP Agent connections on numeric loopback for this run only.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required');
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Start with npm run local so the installed npm CLI can be located');
  await run('Prepare configuration', resolve(root, 'scripts/setup.mjs'));
  await run('Install locked dependencies', npm, ['ci', '--no-audit', '--no-fund']);
  const playwright = resolve(root, 'node_modules/playwright/cli.js');
  await run('Install Chromium', playwright, ['install', 'chromium']);
  await run('Build RelayHub', npm, ['run', 'build']);
  process.loadEnvFile(resolve(root, '.env'));
  const { loadConfig } = await import('../dist/config.js');
  const config = loadConfig();
  if (values['with-agent']) {
    const { agentWebSocketUrl } = await import('../dist/agent-protocol.js');
    agentWebSocketUrl(config.origin, true);
    if (!['127.0.0.1', '::1'].includes(config.host)) throw new Error('--with-agent requires RELAY_HOST=127.0.0.1 or ::1');
    process.env.RELAY_AGENT_INSECURE_LOOPBACK = 'true';
    console.log('[local] Numeric-loopback Agent development mode enabled for this run.');
  }
  console.log(`[local] Workspace: ${config.origin}\n[local] Login credentials: RELAY_ADMIN_USER / RELAY_ADMIN_PASSWORD in .env.\n[local] Keep this process running; Ctrl+C stops the service.`);
  await import('../dist/index.js');
}

main().catch(error => {
  console.error(`[local] ${error.message}`);
  process.exitCode = 1;
});
