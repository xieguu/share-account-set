import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Config } from './config.js';

export type User = { id: string; username: string; role: 'admin' | 'member'; enabled: number };
export type Environment = {
  id: string; name: string; startUrl: string; allowedOrigins: string[]; maxSessions: number;
  ownerId: string; kind: 'server' | 'local'; paused: number;
};
export type EnvironmentInput = Pick<Environment, 'name' | 'startUrl' | 'allowedOrigins' | 'maxSessions'>;
type UserRow = User & { password: string };
type EnvironmentRow = Omit<Environment, 'allowedOrigins'> & { allowedOrigins: string };

function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  if (!salt || !expected) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(password, salt, 64));
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  readonly db: DatabaseSync;
  constructor(config: Config) {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(config.dataDir, 'relayhub.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, startUrl TEXT NOT NULL,
        allowedOrigins TEXT NOT NULL, maxSessions INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        userId TEXT REFERENCES users(id) ON DELETE CASCADE,
        environmentId TEXT REFERENCES environments(id) ON DELETE CASCADE,
        PRIMARY KEY(userId, environmentId)
      );
      CREATE TABLE IF NOT EXISTS logins (
        token TEXT PRIMARY KEY, userId TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        userId TEXT, action TEXT NOT NULL, objectId TEXT
      );
    `);
    if (!(this.db.prepare('SELECT id FROM users LIMIT 1').get())) {
      this.addUser(config.adminUser, config.adminPassword, 'admin');
    }
    const columns = this.db.prepare('PRAGMA table_info(environments)').all() as { name: string }[];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns.some(column => column.name === 'ownerId')) {
        this.db.exec("ALTER TABLE environments ADD COLUMN ownerId TEXT REFERENCES users(id)");
        this.db.exec("UPDATE environments SET ownerId=(SELECT id FROM users WHERE role='admin' ORDER BY rowid LIMIT 1)");
      }
      if (!columns.some(column => column.name === 'kind')) this.db.exec("ALTER TABLE environments ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'");
      if (!columns.some(column => column.name === 'paused')) this.db.exec('ALTER TABLE environments ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
      const auditColumns = this.db.prepare('PRAGMA table_info(audit)').all() as { name: string }[];
      if (!auditColumns.some(column => column.name === 'environmentId')) this.db.exec('ALTER TABLE audit ADD COLUMN environmentId TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_keys (
        environmentId TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL
      ); CREATE INDEX IF NOT EXISTS audit_environment ON audit(environmentId, id);`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.db.prepare('DELETE FROM logins WHERE expires < ?').run(Date.now());
  }
  addUser(username: string, password: string, role: User['role']): User {
    const id = randomUUID();
    this.db.prepare('INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)')
      .run(id, username, passwordHash(password), role);
    return this.user(id)!;
  }
  user(id: string): User | undefined {
    return this.db.prepare('SELECT id,username,role,enabled FROM users WHERE id=?').get(id) as User | undefined;
  }
  users(): User[] {
    return this.db.prepare('SELECT id,username,role,enabled FROM users ORDER BY username').all() as User[];
  }
  login(username: string, password: string): string | undefined {
    const user = this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as UserRow | undefined;
    // Same KDF cost for unknown users; raw passwords and login tokens are never stored.
    const hash = user?.password ?? `00000000000000000000000000000000:${'00'.repeat(64)}`;
    if (!passwordMatches(password, hash) || !user?.enabled) return;
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO logins VALUES(?,?,?)').run(tokenHash(token), user.id, Date.now() + 43_200_000);
    return token;
  }
  authenticate(token: string | undefined): User | undefined {
    if (!token) return;
    return this.db.prepare(`SELECT u.id,u.username,u.role,u.enabled FROM users u
      JOIN logins l ON u.id=l.userId WHERE l.token=? AND l.expires>? AND u.enabled=1`)
      .get(tokenHash(token), Date.now()) as User | undefined;
  }
  logout(token: string) { this.db.prepare('DELETE FROM logins WHERE token=?').run(tokenHash(token)); }
  grantIds(userId: string): string[] {
    return (this.db.prepare('SELECT environmentId FROM grants WHERE userId=?').all(userId) as {environmentId: string}[])
      .map(row => row.environmentId);
  }
  grant(userId: string, environmentId: string) {
    this.db.prepare('INSERT OR IGNORE INTO grants VALUES(?,?)').run(userId, environmentId);
  }
  revoke(userId: string, environmentId: string) {
    this.db.prepare('DELETE FROM grants WHERE userId=? AND environmentId=?').run(userId, environmentId);
  }
  canManage(user: User, id: string) {
    const env = this.environment(id);
    return !!env && !!user.enabled && (user.role === 'admin' || env.ownerId === user.id);
  }
  hasAccess(user: User, id: string) {
    const env = this.environment(id);
    return !!env && !!user.enabled && (user.role === 'admin' || (!!this.user(env.ownerId)?.enabled
      && (env.ownerId === user.id || this.grantIds(user.id).includes(id))));
  }
  disableUser(id: string) {
    this.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(id);
    this.db.prepare('DELETE FROM logins WHERE userId=?').run(id);
  }
  environments(): Environment[] {
    return (this.db.prepare('SELECT * FROM environments ORDER BY name').all() as EnvironmentRow[])
      .map(row => ({ ...row, allowedOrigins: JSON.parse(row.allowedOrigins) }));
  }
  environment(id: string): Environment | undefined {
    const row = this.db.prepare('SELECT * FROM environments WHERE id=?').get(id) as EnvironmentRow | undefined;
    return row ? { ...row, allowedOrigins: JSON.parse(row.allowedOrigins) } : undefined;
  }
  addEnvironment(input: EnvironmentInput & Partial<Pick<Environment, 'ownerId' | 'kind'>>): Environment {
    const ownerId = input.ownerId || (this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY rowid LIMIT 1").get() as { id: string }).id;
    const env: Environment = { ...input, id: randomUUID(), ownerId, kind: input.kind || 'server', paused: 0 };
    this.db.prepare('INSERT INTO environments(id,name,startUrl,allowedOrigins,maxSessions,ownerId,kind,paused) VALUES(?,?,?,?,?,?,?,?)')
      .run(env.id, env.name, env.startUrl, JSON.stringify(env.allowedOrigins), env.maxSessions, env.ownerId, env.kind, env.paused);
    return env;
  }
  updateEnvironment(id: string, input: EnvironmentInput): Environment {
    this.db.prepare('UPDATE environments SET name=?,startUrl=?,allowedOrigins=?,maxSessions=? WHERE id=?')
      .run(input.name, input.startUrl, JSON.stringify(input.allowedOrigins), input.maxSessions, id);
    return this.environment(id)!;
  }
  pauseEnvironment(id: string, paused: boolean) { this.db.prepare('UPDATE environments SET paused=? WHERE id=?').run(Number(paused), id); }
  environmentGrants(id: string) {
    return this.db.prepare('SELECT u.id,u.username,u.enabled FROM users u JOIN grants g ON u.id=g.userId WHERE g.environmentId=? ORDER BY u.username').all(id);
  }
  issueAgentKey(id: string) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO agent_keys VALUES(?,?) ON CONFLICT(environmentId) DO UPDATE SET tokenHash=excluded.tokenHash').run(id, tokenHash(token));
    return token;
  }
  revokeAgentKey(id: string) { this.db.prepare('DELETE FROM agent_keys WHERE environmentId=?').run(id); }
  authenticateAgent(token: string) {
    const row = this.db.prepare('SELECT environmentId FROM agent_keys WHERE tokenHash=?').get(tokenHash(token)) as { environmentId: string } | undefined;
    const env = row && this.environment(row.environmentId);
    return env?.kind === 'local' && this.user(env.ownerId)?.enabled ? env : undefined;
  }
  deleteEnvironment(id: string) { this.db.prepare('DELETE FROM environments WHERE id=?').run(id); }
  audit(userId: string, action: string, objectId: string, environmentId?: string) {
    this.db.prepare('INSERT INTO audit(userId,action,objectId,environmentId) VALUES(?,?,?,?)').run(userId, action, objectId, environmentId || null);
  }
  environmentAudits(id: string) { return this.db.prepare('SELECT * FROM audit WHERE environmentId=? OR objectId=? ORDER BY id DESC LIMIT 100').all(id, id); }
  audits() { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}
