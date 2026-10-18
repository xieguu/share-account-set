import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { HttpBindings } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { Store, type User } from './store.js';
import { BrowserService } from './browser.js';
import { AppError, allowedUrl, commandSchema, normalizedOrigin } from './protocol.js';
import { ConnectionTickets } from './connection-auth.js';

const COOKIE = 'relayhub_session';
const userSchema = z.object({ username: z.string().regex(/^[a-zA-Z0-9_-]{2,40}$/),
  password: z.string().min(12).max(256), role: z.enum(['admin', 'member']).default('member'),
  environmentIds: z.array(z.string().uuid()).max(50).default([]) });
const environmentSchema = z.object({ name: z.string().trim().min(1).max(80),
  startUrl: z.url().max(4096), allowedOrigins: z.array(z.url().max(4096)).min(1).max(50),
  maxSessions: z.number().int().min(1).max(30).default(8) });
type Variables = { user: User; token: string };

export function createApp(config: Config) {
  const store = new Store(config);
  const browsers = new BrowserService(config);
  const app = new Hono<{ Variables: Variables; Bindings: HttpBindings }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const tickets = new ConnectionTickets();
  const allowedOrigin = (origin: string | undefined) => Boolean(origin && (origin === config.origin || config.frontendOrigins?.includes(origin)));
  const cleanAttempts = setInterval(() => {
    for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
    tickets.prune();
  }, 60_000);
  cleanAttempts.unref();

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof ZodError) return c.json({ error: '输入格式不正确', details: error.issues }, 400);
    if (error instanceof SyntaxError) return c.json({ error: '请求必须是有效 JSON' }, 400);
    console.error(error);
    return c.json({ error: '服务操作失败，详情见服务端日志' }, 500);
  });
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
    const origin = c.req.header('origin');
    if ((c.req.path.startsWith('/api/') && origin && !allowedOrigin(origin))
      || (!['GET','HEAD','OPTIONS'].includes(c.req.method) && !allowedOrigin(origin))) {
      throw new AppError(403, '请求来源不匹配');
    }
    await next();
  });
  app.use('/api/*', cors({
    origin: origin => allowedOrigin(origin) ? origin : null,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600,
  }));
  app.get('/api/health', c => c.json({ status: 'ok', version: '0.1.0' }));
  app.post('/api/login', async c => {
    const input = z.object({ username: z.string().max(40), password: z.string().max(256),
      authMode: z.enum(['cookie', 'token']).default('cookie') }).parse(await c.req.json());
    if (c.req.header('origin') !== config.origin && input.authMode !== 'token') {
      throw new AppError(400, '跨域登录必须使用 authMode: token');
    }
    const address = c.env?.incoming?.socket?.remoteAddress || 'local';
    const key = `${address}:${input.username}`;
    let entry = attempts.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { count: 0, until: Date.now() + 600_000 };
      attempts.set(key, entry);
    }
    if (entry.count >= 20) throw new AppError(429, '尝试次数过多，请在 10 分钟后重试');
    const token = store.login(input.username, input.password);
    if (!token) { entry.count++; throw new AppError(401, '用户名或密码不正确'); }
    attempts.delete(key);
    if (input.authMode === 'cookie') setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure: config.origin.startsWith('https:'), path: '/', maxAge: 43_200 });
    const user = store.authenticate(token)!;
    store.audit(user.id, 'login', user.id);
    return c.json(input.authMode === 'token' ? { user, token } : { user });
  });
  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('authorization');
    const crossOrigin = Boolean(c.req.header('origin') && c.req.header('origin') !== config.origin);
    let token: string | undefined;
    if (authorization !== undefined) {
      const bearer = /^Bearer ([\w-]{43})$/i.exec(authorization);
      if (!bearer) throw new AppError(401, 'Authorization 必须使用有效的 Bearer 登录令牌');
      token = bearer[1];
    } else {
      if (crossOrigin) throw new AppError(401, '跨域请求必须提供 Bearer 登录令牌');
      token = getCookie(c, COOKIE);
    }
    const user = store.authenticate(token);
    if (!user) throw new AppError(401, '请先登录 RelayHub');
    c.set('user', user);
    c.set('token', token!);
    await next();
  });
  app.post('/api/logout', c => {
    store.logout(c.get('token'));
    tickets.revokeToken(c.get('token'));
    if (!c.req.header('authorization')) deleteCookie(c, COOKIE, { path: '/' });
    for (const [ws, connection] of connections) if (connection.token === c.get('token')) ws.close(4003, '登录已退出');
    return c.json({ ok: true });
  });
  app.get('/api/me', c => c.json({ user: c.get('user') }));
  app.get('/api/environments', c => {
    const user = c.get('user');
    return c.json({ environments: store.environments().filter(env => store.hasAccess(user, env.id)).map(env => ({
      ...env, status: browsers.status(env.id),
      sessions: [...browsers.sessions.values()].filter(session => session.env.id === env.id).length,
    })) });
  });
  app.get('/api/sessions', c => {
    const user = c.get('user');
    return c.json({ sessions: [...browsers.sessions.values()]
      .filter(session => user.role === 'admin' || session.user.id === user.id).map(session => session.summary()) });
  });
  app.get('/api/sessions/:id', c => {
    const user = c.get('user');
    const session = browsers.get(c.req.param('id'), user);
    if (!store.hasAccess(user, session.env.id)) throw new AppError(404, '窗口不存在');
    return c.json({ session: session.summary() });
  });
  app.post('/api/sessions/:id/ticket', async c => {
    const { mode } = z.object({ mode: z.enum(['control', 'view']) }).strict().parse(await c.req.json());
    const user = c.get('user');
    const session = browsers.get(c.req.param('id'), user);
    if (!store.hasAccess(user, session.env.id)) throw new AppError(404, '窗口不存在');
    if (mode === 'control' && session.controller) throw new AppError(409, '窗口已有操控连接');
    return c.json(tickets.issue({ token: c.get('token'), sessionId: session.id, mode, origin: c.req.header('origin')! }));
  });
  app.post('/api/sessions', async c => {
    const { environmentId } = z.object({ environmentId: z.string().uuid() }).parse(await c.req.json());
    const user = c.get('user');
    const env = store.environment(environmentId);
    if (!env || !store.hasAccess(user, env.id)) throw new AppError(404, '账号环境不存在');
    const session = await browsers.create(env, user);
    // Permission may have been revoked while Chromium was starting.
    if (!store.user(user.id)?.enabled || !store.environment(env.id) || !store.hasAccess(user, env.id)) {
      await session.close('权限已撤销');
      throw new AppError(403, '权限已撤销');
    }
    store.audit(user.id, 'session.create', session.id);
    return c.json({ session: session.summary() }, 201);
  });
  app.delete('/api/sessions/:id', async c => {
    const session = browsers.get(c.req.param('id'), c.get('user'));
    await session.close();
    store.audit(c.get('user').id, 'session.close', session.id);
    return c.json({ ok: true });
  });
  app.use('/api/admin/*', async (c, next) => {
    if (c.get('user').role !== 'admin') throw new AppError(403, '此操作需要管理员权限');
    await next();
  });
  app.get('/api/admin/users', c => c.json({ users: store.users().map(user => ({ ...user, environmentIds: store.grantIds(user.id) })) }));
  app.post('/api/admin/users', async c => {
    const input = userSchema.parse(await c.req.json());
    if (store.users().some(user => user.username === input.username)) throw new AppError(409, '用户名已存在');
    for (const id of input.environmentIds) if (!store.environment(id)) throw new AppError(404, '账号环境不存在');
    const user = store.addUser(input.username, input.password, input.role);
    for (const id of input.environmentIds) store.grant(user.id, id);
    store.audit(c.get('user').id, 'user.create', user.id);
    return c.json({ user }, 201);
  });
  app.post('/api/admin/users/:id/disable', async c => {
    const id = c.req.param('id');
    if (id === c.get('user').id) throw new AppError(400, '不能停用当前管理员');
    if (!store.user(id)) throw new AppError(404, '成员不存在');
    store.disableUser(id);
    disconnectUser(id, '成员已停用');
    for (const session of [...browsers.sessions.values()]) if (session.user.id === id) await session.close('成员已停用');
    store.audit(c.get('user').id, 'user.disable', id);
    return c.json({ ok: true });
  });
  app.put('/api/admin/users/:id/grants/:environmentId', c => {
    const id = c.req.param('id');
    const environmentId = c.req.param('environmentId');
    if (!store.user(id) || !store.environment(environmentId)) throw new AppError(404, '成员或环境不存在');
    store.grant(id, environmentId);
    store.audit(c.get('user').id, 'grant.add', `${id}:${environmentId}`);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/users/:id/grants/:environmentId', async c => {
    const id = c.req.param('id');
    const environmentId = c.req.param('environmentId');
    store.revoke(id, environmentId);
    for (const session of [...browsers.sessions.values()]) {
      if (session.user.id === id && session.env.id === environmentId) await session.close('环境访问权限已撤销');
    }
    store.audit(c.get('user').id, 'grant.revoke', `${id}:${environmentId}`);
    return c.json({ ok: true });
  });
  app.post('/api/admin/environments', async c => {
    const input = environmentSchema.parse(await c.req.json());
    const origins = [...new Set(input.allowedOrigins.map(normalizedOrigin))];
    if (origins.some(allowedOrigin)) throw new AppError(400, '不能把 RelayHub 门户入口加入远程浏览器环境');
    allowedUrl(input.startUrl, origins);
    const env = store.addEnvironment({ ...input, allowedOrigins: origins });
    store.audit(c.get('user').id, 'environment.create', env.id);
    return c.json({ environment: env }, 201);
  });
  app.put('/api/admin/environments/:id', async c => {
    const id = c.req.param('id');
    if (!store.environment(id)) throw new AppError(404, '账号环境不存在');
    const input = environmentSchema.parse(await c.req.json());
    const origins = [...new Set(input.allowedOrigins.map(normalizedOrigin))];
    if (origins.some(allowedOrigin)) throw new AppError(400, '不能把 RelayHub 门户入口加入远程浏览器环境');
    allowedUrl(input.startUrl, origins);
    await browsers.stopEnvironment(id);
    const env = store.updateEnvironment(id, { ...input, allowedOrigins: origins });
    store.audit(c.get('user').id, 'environment.update', id);
    return c.json({ environment: env });
  });
  app.post('/api/admin/environments/:id/stop', async c => {
    await browsers.stopEnvironment(c.req.param('id'));
    store.audit(c.get('user').id, 'environment.stop', c.req.param('id'));
    return c.json({ ok: true });
  });
  app.delete('/api/admin/environments/:id', async c => {
    const id = c.req.param('id');
    await browsers.stopEnvironment(id);
    store.deleteEnvironment(id);
    // Profile data is deliberately preserved; deletion does not silently erase account cookies.
    store.audit(c.get('user').id, 'environment.delete', id);
    return c.json({ ok: true });
  });
  app.post('/api/admin/sessions/:id/revoke-control', async c => {
    await browsers.get(c.req.param('id'), c.get('user')).revokeControl();
    store.audit(c.get('user').id, 'control.revoke', c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/admin/audit', c => c.json({ entries: store.audits() }));
  app.notFound(c => c.json({ error: '路径不存在' }, 404));
  app.use('/*', serveStatic({ root: './public', index: 'index.html' }));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 24_000 });
  const connections = new Map<WebSocket, { userId: string; token: string; alive: boolean }>();
  function disconnectUser(id: string, reason: string) {
    for (const [ws, connection] of connections) if (connection.userId === id) ws.close(4003, reason);
  }
  const heartbeat = setInterval(() => {
    for (const [ws, connection] of connections) {
      if (!connection.alive) { ws.terminate(); continue; }
      if (!store.authenticate(connection.token)) { ws.close(4003, '登录已过期'); continue; }
      connection.alive = false;
      ws.ping();
    }
  }, 15_000);
  heartbeat.unref();
  function attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
      try {
        if (!allowedOrigin(req.headers.origin)) { reject(403); return; }
        const url = new URL(req.url || '/', config.origin);
        const match = /^\/ws\/sessions\/([\da-f-]+)$/.exec(url.pathname);
        if (!match?.[1]) { reject(404); return; }
        const mode = url.searchParams.get('mode') || 'control';
        if (!['control', 'view'].includes(mode)) { reject(400); return; }
        let token: string | undefined;
        if (url.searchParams.has('ticket')) {
          token = tickets.consume(url.searchParams.get('ticket')!, {
            sessionId: match[1], mode: mode as 'control' | 'view', origin: req.headers.origin!,
          });
        } else {
          if (req.headers.origin !== config.origin) { reject(401); return; }
          token = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
        }
        const user = store.authenticate(token);
        if (!user || !token) { reject(401); return; }
        const session = browsers.get(match[1], user);
        if (!store.hasAccess(user, session.env.id)) { reject(403); return; }
        const control = mode === 'control';
        if (control && session.controller) { reject(409); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          try { session.attach(ws, control); }
          catch (error) { ws.close(4409, error instanceof Error ? error.message : '连接失败'); return; }
          const connection = { userId: user.id, token, alive: true };
          connections.set(ws, connection);
          let pending = 0;
          let detached = false;
          ws.on('pong', () => { connection.alive = true; });
          ws.on('message', (data, binary) => {
            if (detached) return;
            if (binary) { ws.close(1003, '只接受 JSON 控制消息'); return; }
            try {
              const currentUser = store.authenticate(token);
              if (!currentUser || !store.hasAccess(currentUser, session.env.id)) {
                ws.close(4003, '权限已撤销'); return;
              }
              const command = commandSchema.parse(JSON.parse(data.toString()));
              if (++pending > 100) { pending--; ws.close(1008, '控制队列已满'); return; }
              // The session owns operation ordering. Transport ACKs and pings bypass slow navigation.
              void session.command(ws, command).catch(error => report(error)).finally(() => { pending--; });
            } catch (error) { report(error); }
          });
          function report(error: unknown) {
              const message = error instanceof ZodError ? '控制消息格式不正确' : error instanceof Error ? error.message : String(error);
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message }));
          }
          ws.on('close', () => {
            detached = true;
            connections.delete(ws);
            void session.detach(ws).catch(error => console.error('[detach]', error));
          });
          ws.on('error', error => console.error('[websocket]', error.message));
        });
      } catch (error) { reject(error instanceof AppError ? error.status : 500); }
    });
  }
  async function close() {
    clearInterval(heartbeat);
    clearInterval(cleanAttempts);
    tickets.clear();
    for (const ws of connections.keys()) ws.terminate();
    await browsers.close();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    store.close();
  }
  return { app, store, browsers, attach, close };
}
