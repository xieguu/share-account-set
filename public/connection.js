const appDirectory = new URL('./', import.meta.url);
const storagePrefix = `relayhub:${appDirectory.origin}${appDirectory.pathname}`;
const backendKey = `${storagePrefix}:backend`;
const authKey = `${storagePrefix}:auth`;
let configuration, backend, token, initialization, revision = 0;

export class ConnectionError extends Error {
  constructor(message, status = 0, code = 'CONNECTION_ERROR') {
    super(message); this.name = 'ConnectionError'; this.status = status; this.code = code;
  }
}

function readStorage(key) {
  try { return sessionStorage.getItem(key); }
  catch { throw new ConnectionError('浏览器无法读取当前工作台的连接信息，请允许此页面使用会话存储。', 0, 'STORAGE_ERROR'); }
}
function writeStorage(key, value) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); }
  catch { throw new ConnectionError('浏览器无法保存当前工作台的连接信息，请允许此页面使用会话存储。', 0, 'STORAGE_ERROR'); }
}

export function validateBackend(value) {
  const input = String(value).trim();
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(input)) {
    throw new ConnectionError('请填写服务地址，例如 https://relay.example.com，不包含页面路径、参数或片段。', 0, 'INVALID_BACKEND');
  }
  let url;
  try { url = new URL(input); }
  catch { throw new ConnectionError('服务地址格式无效。', 0, 'INVALID_BACKEND'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConnectionError('服务地址只能包含协议、主机名和可选端口，不能包含账号或密码。', 0, 'INVALID_BACKEND');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ConnectionError('远程服务需要使用 HTTPS；HTTP 仅用于本机 localhost、127.0.0.1 或 [::1]。', 0, 'INVALID_BACKEND');
  }
  if (location.protocol === 'https:' && url.protocol !== 'https:') {
    throw new ConnectionError('当前工作台通过 HTTPS 打开，服务地址也需要使用 HTTPS。', 0, 'INVALID_BACKEND');
  }
  return url.origin;
}

async function readJson(response, label) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ConnectionError(`${label}返回了非 JSON 内容（HTTP ${response.status}），请核对服务地址。`, response.status, 'INVALID_RESPONSE');
  }
  try { return await response.json(); }
  catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    throw new ConnectionError(`${label}返回的数据无法读取。`, response.status, 'INVALID_RESPONSE');
  }
}

export async function initConnection() {
  if (!initialization) initialization = (async () => {
    let response;
    try { response = await fetch(new URL('connection-config.json', appDirectory), { cache: 'no-store', redirect: 'error' }); }
    catch { throw new ConnectionError('工作台连接配置无法加载，请检查网络并重新加载页面。', 0, 'CONFIG_ERROR'); }
    if (!response.ok) throw new ConnectionError(`工作台连接配置加载失败（HTTP ${response.status}）。`, response.status, 'CONFIG_ERROR');
    const config = await readJson(response, '工作台连接配置');
    if (!config || typeof config.requireBackend !== 'boolean') throw new ConnectionError('工作台连接配置格式无效。', 0, 'CONFIG_ERROR');
    const savedBackend = readStorage(backendKey);
    const nextBackend = savedBackend ? validateBackend(savedBackend) : config.requireBackend ? null : location.origin;
    if (!config.requireBackend && nextBackend !== location.origin) throw new ConnectionError('此工作台由当前服务提供，请重置连接设置后使用当前服务。', 0, 'INVALID_BACKEND');
    if (config.requireBackend && nextBackend === location.origin) throw new ConnectionError('当前页面需要连接独立部署的 RelayHub 服务，请修改已保存的服务地址。', 0, 'INVALID_BACKEND');
    const savedAuth = readStorage(authKey);
    let nextToken;
    if (savedAuth) {
      let auth;
      try { auth = JSON.parse(savedAuth); }
      catch { throw new ConnectionError('已保存的登录信息无法读取，请重新设置服务地址。', 0, 'STORAGE_ERROR'); }
      if (auth && auth.backend === nextBackend && typeof auth.token === 'string' && auth.token) nextToken = auth.token;
      else writeStorage(authKey, null);
    }
    configuration = config; backend = nextBackend; token = nextToken;
    return getConnection();
  })();
  return initialization;
}

export function getConnection() {
  return { backend: backend || null, requireBackend: configuration?.requireBackend ?? null,
    authMode: backend && backend !== location.origin ? 'token' : 'cookie', hasToken: !!token };
}

export async function saveBackend(value) {
  await initConnection();
  const next = validateBackend(value);
  if (!configuration.requireBackend && next !== location.origin) throw new ConnectionError('此工作台使用当前服务；连接其他服务请使用 Pages 工作台。', 0, 'INVALID_BACKEND');
  if (configuration.requireBackend && next === location.origin) throw new ConnectionError('请填写独立部署的 RelayHub 服务地址，不能使用当前静态工作台的地址。', 0, 'INVALID_BACKEND');
  if (next !== backend) {
    writeStorage(authKey, null); token = undefined; revision++;
    writeStorage(backendKey, next); backend = next;
  } else writeStorage(backendKey, next);
  return getConnection();
}

function clearAuthentication() { writeStorage(authKey, null); token = undefined; revision++; }

export function resetConnection() {
  clearAuthentication(); writeStorage(backendKey, null);
  backend = undefined; configuration = undefined; initialization = undefined;
}

async function request(origin, path, options = {}, authentication) {
  const started = revision;
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (authentication) headers.set('Authorization', `Bearer ${authentication}`);
  let response, result;
  try {
    response = await fetch(new URL(`/api${path}`, origin), { ...options, headers, cache: 'no-store', redirect: 'error',
      credentials: origin === location.origin ? 'same-origin' : 'omit',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    result = await readJson(response, '服务');
  } catch (error) {
    if (started !== revision) throw new ConnectionError('连接设置已改变，请使用当前服务重新操作。', 0, 'CONNECTION_CHANGED');
    if (options.signal?.aborted) throw new ConnectionError('操作已取消。', 0, 'REQUEST_CANCELLED');
    if (error instanceof ConnectionError) throw error;
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new ConnectionError(timeout ? '服务响应超时，请检查网络后重试。' : `无法连接服务 ${origin}。请检查网络、服务地址及服务端是否允许此工作台连接。`, 0, 'NETWORK_ERROR');
  }
  if (started !== revision) throw new ConnectionError('连接设置已改变，请使用当前服务重新操作。', 0, 'CONNECTION_CHANGED');
  if (!response.ok) {
    if (response.status === 401 && authentication && token === authentication) clearAuthentication();
    throw new ConnectionError(typeof result?.error === 'string' ? result.error : `请求失败（HTTP ${response.status}）。`, response.status, 'HTTP_ERROR');
  }
  return result;
}

export async function checkBackend(value, { signal } = {}) {
  await initConnection();
  const origin = validateBackend(value);
  if (!configuration.requireBackend && origin !== location.origin) throw new ConnectionError('此工作台使用当前服务；连接其他服务请使用 Pages 工作台。', 0, 'INVALID_BACKEND');
  if (configuration.requireBackend && origin === location.origin) throw new ConnectionError('请填写独立部署的 RelayHub 服务地址。', 0, 'INVALID_BACKEND');
  const result = await request(origin, '/health', { signal });
  if (result?.status !== 'ok' || typeof result.version !== 'string') throw new ConnectionError('此地址未返回有效的 RelayHub 服务状态。', 0, 'INVALID_RESPONSE');
  return result;
}

export async function api(path, options = {}) {
  await initConnection();
  if (!backend) throw new ConnectionError('请先设置 RelayHub 服务地址。', 0, 'BACKEND_REQUIRED');
  if (!path.startsWith('/') || path.startsWith('//')) throw new ConnectionError('请求路径无效。', 0, 'INVALID_REQUEST');
  const tokenMode = getConnection().authMode === 'token';
  if (tokenMode && !token && path !== '/login' && path !== '/health') throw new ConnectionError('请返回工作台登录后再打开窗口。', 401, 'AUTH_REQUIRED');
  return request(backend, path, options, tokenMode ? token : undefined);
}

export async function login(credentials) {
  await initConnection();
  const tokenMode = getConnection().authMode === 'token';
  clearAuthentication();
  const result = await api('/login', { method: 'POST', body: JSON.stringify({ ...credentials, ...(tokenMode ? { authMode: 'token' } : {}) }) });
  if (!result?.user) throw new ConnectionError('服务未返回有效的登录结果。', 0, 'INVALID_RESPONSE');
  if (tokenMode) {
    if (typeof result.token !== 'string' || !result.token) throw new ConnectionError('服务未返回登录凭据，请检查服务版本。', 0, 'INVALID_RESPONSE');
    writeStorage(authKey, JSON.stringify({ backend, token: result.token })); token = result.token; revision++;
  }
  return result;
}

export async function logout() {
  try { await api('/logout', { method: 'POST' }); }
  catch (error) {
    // An explicit authentication rejection confirms that this login is already invalid.
    // Transport failures still propagate: they cannot confirm server-side revocation.
    if (error.status !== 401 || !['HTTP_ERROR', 'AUTH_REQUIRED'].includes(error.code)) throw error;
  }
  clearAuthentication();
}

export async function websocketUrl(sessionId, mode) {
  await initConnection();
  if (!backend) throw new ConnectionError('请返回工作台设置服务地址。', 0, 'BACKEND_REQUIRED');
  const url = new URL(`/ws/sessions/${encodeURIComponent(sessionId)}`, backend);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('mode', mode);
  if (getConnection().authMode === 'token') {
    const result = await api(`/sessions/${encodeURIComponent(sessionId)}/ticket`, { method: 'POST', body: JSON.stringify({ mode }) });
    // Only the issuing server can compare expiresAt with its own clock.
    if (typeof result?.ticket !== 'string' || !result.ticket || !Number.isFinite(result.expiresAt) || result.expiresAt <= 0) {
      throw new ConnectionError('服务未返回有效的窗口连接凭据。', 0, 'INVALID_RESPONSE');
    }
    url.searchParams.set('ticket', result.ticket);
  }
  return url.href;
}

export function viewerUrl(sessionId, observe = false) {
  const url = new URL('viewer.html', appDirectory); url.searchParams.set('session', sessionId);
  if (observe) url.searchParams.set('view', '1');
  return url.href;
}

export function reserveViewer() {
  // An inherited about:blank origin copies this tab's sessionStorage before opener is removed.
  const viewer = window.open('about:blank', '_blank');
  if (viewer) viewer.opener = null;
  return viewer;
}
