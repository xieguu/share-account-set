import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NetworkPolicy, publicAddress } from '../src/network-policy.js';

test('network policy rejects nonpublic ranges, encoded IPs, mixed DNS and rebinding', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.2.2', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.1.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const origin of ['http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::1]', 'http://[::ffff:7f00:1]']) await assert.rejects(new NetworkPolicy().addresses(origin), /禁止访问/);
  await assert.rejects(new NetworkPolicy([], async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.1.1.1', family: 4 }]).addresses('https://mixed.test'), /禁止访问/);
  let calls = 0;
  const rebinding = new NetworkPolicy([], async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  await rebinding.validate(['http://rebind.test']);
  const proxy = await rebinding.proxy(['http://rebind.test']);
  try {
    const status = await new Promise<number>(r => request(proxy.url, { path: 'http://rebind.test/', headers: { Host: 'rebind.test' } }, response => { response.resume(); r(response.statusCode!); }).end());
    assert.equal(status, 403); assert.equal(calls, 2);
  } finally { await proxy.close(); }
});

test('proxy uses a pinned DNS answer and exact operator-approved origin for private HTTP and CONNECT', async t => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('approved'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const port = (server.address() as AddressInfo).port, origin = `http://authorized.test:${port}`;
  let calls = 0;
  const policy = new NetworkPolicy([origin], async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; });
  const proxy = await policy.proxy([origin]);
  try {
    const response = await new Promise<number>((r, reject) => {
      request(proxy.url, { path: `${origin}/`, headers: { Host: `authorized.test:${port}` } }, response => { response.resume(); r(response.statusCode!); }).on('error', reject).end();
    });
    assert.equal(response, 200); assert.equal(calls, 1); assert.equal(requests, 1);
    const denied = await new Promise<number>(r => request(proxy.url, { path: `http://127.0.0.1:${port}/` }, response => { response.resume(); r(response.statusCode!); }).end());
    assert.equal(denied, 403); assert.equal(requests, 1);
    await new Promise<void>((r, reject) => {
      const req = request(proxy.url, { method: 'CONNECT', path: `authorized.test:${port}` });
      req.on('connect', (response, socket) => { assert.equal(response.statusCode, 200); socket.destroy(); r(); });
      req.on('error', reject); req.end();
    });
    assert.equal(calls, 2);
  } finally { await proxy.close(); }
});
