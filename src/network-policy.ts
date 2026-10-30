import { lookup } from 'node:dns/promises';
import type dns from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'node:http';
import ipaddr from 'ipaddr.js';
import { Server, RequestError } from 'proxy-chain';
import { AppError, normalizedOrigin } from './protocol.js';

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const host = (value: string) => value.replace(/^\[|\]$/g, '');
export function publicAddress(value: string) {
  try { return ipaddr.process(host(value)).range() === 'unicast'; } catch { return false; }
}

/** The address returned by validation is also the address used to connect: no second DNS lookup. */
export class NetworkPolicy {
  constructor(private trustedOrigins: string[] = [], private resolve: Resolver = name => lookup(name, { all: true, verbatim: true })) {}
  async addresses(origin: string): Promise<Address[]> {
    const url = new URL(normalizedOrigin(origin));
    const name = host(url.hostname);
    let addresses: Address[];
    try { addresses = isIP(name) ? [{ address: name, family: isIP(name) }] : await this.resolve(name); }
    catch { throw new AppError(400, '网站域名无法解析'); }
    if (!addresses.length || (!this.trustedOrigins.includes(url.origin) && addresses.some(item => !publicAddress(item.address)))) {
      throw new AppError(400, '禁止访问未经服务器或设备所有者授权的本地、内网及保留地址');
    }
    return addresses;
  }
  async validate(origins: string[]) { for (const origin of origins) await this.addresses(origin); }

  async proxy(origins: string[]) {
    // A private, ephemeral loopback listener. It never accepts an origin outside this environment.
    const agent = new Agent({ keepAlive: false });
    const proxy = new Server({ host: '127.0.0.1', port: 0, prepareRequestFunction: async ({ hostname, port, isHttp, request }) => {
      const origin = isHttp ? new URL(request.url!).origin : origins.find(candidate => {
        const url = new URL(candidate);
        return host(url.hostname) === host(hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port;
      });
      if (!origin || !origins.includes(origin)) throw new RequestError('Origin denied', 403);
      let addresses: Address[];
      try { addresses = await this.addresses(origin); }
      catch { throw new RequestError('Network destination denied', 403); }
      const pinned = addresses[0]!;
      // Node skips lookup for literal IPs; those were validated above as well.
      const dnsLookup = ((_name: string, options: dns.LookupOptions, callback: Function) => {
        if (options?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
      }) as unknown as typeof dns.lookup;
      return { dnsLookup, httpAgent: agent };
    } });
    await proxy.listen();
    return { url: `http://127.0.0.1:${proxy.port}`, async close() { await proxy.close(true); agent.destroy(); } };
  }
}
