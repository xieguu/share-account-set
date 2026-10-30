import { BrowserService, type RemoteSession } from './browser.js';
import { AgentHub, type AgentSession } from './agent-hub.js';
import type { Config } from './config.js';
import type { Environment, Store, User } from './store.js';
import { AppError } from './protocol.js';

export class BrowserPool {
  readonly server: BrowserService;
  readonly agents: AgentHub;
  constructor(config: Config, private store: Store) {
    this.server = new BrowserService(config);
    this.agents = new AgentHub(store, config.idleMs);
  }
  get sessions() { return new Map<string, RemoteSession | AgentSession>([...this.server.sessions, ...this.agents.sessions]); }
  create(env: Environment, user: User) { return env.kind === 'local' ? this.agents.create(env, user) : this.server.create(env, user); }
  get(id: string, user: User) {
    const session = this.sessions.get(id);
    if (!session || !this.store.hasAccess(user, session.env.id) || !(session.user.id === user.id || this.store.canManage(user, session.env.id))) throw new AppError(404, '窗口不存在');
    return session;
  }
  status(id: string) { return this.store.environment(id)?.kind === 'local' ? this.agents.status(id) : this.server.status(id); }
  async stopEnvironment(id: string) {
    if (this.store.environment(id)?.kind === 'local') await this.agents.stopEnvironment(id);
    else await this.server.stopEnvironment(id);
  }
  async cleanup() { await this.server.cleanup(); await this.agents.cleanup(); }
  async close() { await this.agents.close(); await this.server.close(); }
}
