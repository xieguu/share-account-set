import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';

test('legacy SQLite environments migrate to the existing administrator without losing grants or IDs', () => {
  mkdirSync('test-results', { recursive: true });
  const dataDir = mkdtempSync(resolve('test-results/migration-'));
  const db = new DatabaseSync(join(dataDir, 'relayhub.sqlite'));
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE environments(id TEXT PRIMARY KEY, name TEXT NOT NULL, startUrl TEXT NOT NULL, allowedOrigins TEXT NOT NULL, maxSessions INTEGER NOT NULL);
    CREATE TABLE grants(userId TEXT REFERENCES users(id), environmentId TEXT REFERENCES environments(id), PRIMARY KEY(userId,environmentId));
    INSERT INTO users VALUES('admin-id','admin','unchanged','admin',1),('member-id','member','unchanged','member',1);
    INSERT INTO environments VALUES('legacy-env','Legacy','https://example.com','["https://example.com"]',8);
    INSERT INTO grants VALUES('member-id','legacy-env');`);
  db.close();
  const config = { dataDir, adminUser: 'unused', adminPassword: 'unused-password' } as Config;
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new Store(config);
    try {
      const env = store.environment('legacy-env')!;
      assert.equal(env.ownerId, 'admin-id'); assert.equal(env.kind, 'server'); assert.equal(env.paused, 0);
      assert.deepEqual(store.grantIds('member-id'), ['legacy-env']);
      assert.equal(store.hasAccess(store.user('member-id')!, env.id), true);
      assert.equal(store.db.prepare('SELECT password FROM users WHERE id=?').get('admin-id')!.password, 'unchanged');
    } finally { store.close(); }
  }
});
