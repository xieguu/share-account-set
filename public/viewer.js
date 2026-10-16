const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const sessionId = params.get('session'), observe = params.has('view');
const screen = $('#screen'), context = screen.getContext('2d'), keyboard = $('#keyboard');
const retries = [500, 1000, 2000, 4000, 8000];
let ws, control = false, activeTab, displayedTab, frameBusy = false, queuedFrame;
let frames = 0, bytes = 0, lastFrames = 0, lastBytes = 0, lastMetric = performance.now(), latency = 0;
let generation = 0, retryAttempt = 0, retryTimer, noticeTimer, movePending, connecting = false, composing = false;
let tabsFingerprint = '';
const pressed = new Map();
const modifiers = event => ({ ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey });

function notice(message) {
  $('#notice').textContent = message; $('#notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').hidden = true, 6500);
}
function send(message, socket = ws) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function input(message) {
  if (!control) return;
  if (message.type === 'mouse' || message.type === 'key') {
    if (!displayedTab || displayedTab !== activeTab) return;
    message = { ...message, targetId: displayedTab };
  }
  send(message);
}
function placeholder(title, message, loading = false) {
  $('#placeholder').hidden = false; $('#placeholder h1').textContent = title;
  $('#status').textContent = message; $('#placeholder .spinner').hidden = !loading;
}
function setConnected(value) {
  control = value;
  $('#mode').textContent = value ? '● 独立操控中' : '◉ 只读观察模式';
  $('#address').disabled = !value; $('#quality').disabled = !value;
  $('#navigation').querySelectorAll('button').forEach(button => button.disabled = !value);
}
function syncState(state) {
  if (typeof state.control === 'boolean') setConnected(state.control);
  $('#session-label').textContent = `${state.session.environmentName} / ${state.session.username} / ${sessionId.slice(0, 8)}`;
  document.title = `${state.session.environmentName} · RelayHub`;
  $('#quality').value = state.session.stream.profile;
  if (activeTab !== state.activeTabId) {
    activeTab = state.activeTabId; displayedTab = undefined;
    screen.style.visibility = 'hidden';
    placeholder('正在切换页面', '等待当前标签页的第一帧画面。', true);
  }
  if (document.activeElement !== $('#address')) $('#address').value = state.tabs.find(tab => tab.id === activeTab)?.url || '';
  const fingerprint = JSON.stringify([state.tabs, activeTab, control]);
  if (fingerprint === tabsFingerprint) return;
  tabsFingerprint = fingerprint;
  const tabs = $('#tabs'); tabs.replaceChildren();
  for (const tab of state.tabs) {
    const wrapper = document.createElement('div'); wrapper.className = `tab ${tab.id === activeTab ? 'active' : ''}`;
    const button = document.createElement('button'); button.className = 'tab-select'; button.title = tab.url;
    const title = document.createElement('span');
    try { title.textContent = new URL(tab.url).hostname || '空白页'; } catch { title.textContent = '空白页'; }
    button.append(title); button.disabled = !control;
    button.onclick = () => input({ type: 'tab', action: 'switch', tabId: tab.id });
    wrapper.append(button);
    if (control) {
      const close = document.createElement('button'); close.className = 'close-tab'; close.textContent = '×'; close.title = '关闭标签页';
      close.onclick = () => input({ type: 'tab', action: 'close', tabId: tab.id });
      wrapper.append(close);
    }
    tabs.append(wrapper);
  }
  if (control) {
    const button = document.createElement('button'); button.textContent = '＋'; button.title = '新建标签页';
    button.onclick = () => input({ type: 'tab', action: 'new' }); tabs.append(button);
  }
}
function ack(frame) { send({ type: 'frame_ack', sequence: frame.meta.sequence }, frame.socket); }
async function drawFrame(frame) {
  if (frameBusy) {
    if (queuedFrame) ack(queuedFrame);
    queuedFrame = frame; return;
  }
  frameBusy = true;
  try {
    const image = await createImageBitmap(frame.blob);
    if (frame.generation === generation && frame.meta.tabId === activeTab) {
      context.drawImage(image, 0, 0, 1280, 800); frames++;
      displayedTab = frame.meta.tabId;
      screen.style.visibility = 'visible'; $('#placeholder').hidden = true;
      retryAttempt = 0;
    }
    image.close();
  } catch (error) { notice(`画面解码失败：${error.message}`); }
  finally {
    ack(frame); frameBusy = false;
    if (queuedFrame) { const next = queuedFrame; queuedFrame = undefined; void drawFrame(next); }
  }
}
async function inspectSession() {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body.session;
}
function scheduleReconnect(reason) {
  if (retryAttempt >= retries.length) {
    placeholder('连接未恢复', `${reason}。已尝试 5 次，可检查网络后手动重新连接。`); return;
  }
  const delay = retries[retryAttempt++];
  placeholder('连接中断，准备恢复', `${reason} · 第 ${retryAttempt} / ${retries.length} 次重连`, true);
  retryTimer = setTimeout(() => void connect(true), delay);
}
async function disconnected(event, current) {
  if (current !== generation) return;
  // Invalidate image decoding and message callbacks from the closed connection.
  current = ++generation;
  if (queuedFrame) { ack(queuedFrame); queuedFrame = undefined; }
  setConnected(false); pressed.clear(); movePending = undefined; displayedTab = undefined;
  screen.style.visibility = 'hidden';
  $('#mode').textContent = '● 已断开连接';
  if (event.code !== 1006 && event.code !== 1011 && event.code !== 4008) {
    placeholder('远程连接已断开', event.reason || '连接已关闭，可以返回工作台查看窗口状态。'); return;
  }
  try {
    const session = await inspectSession();
    if (current !== generation) return;
    if (!observe && session.controlled) {
      placeholder('窗口已有操控连接', '请关闭另一个操控页面后重新连接，或由管理员收回控制权。'); return;
    }
    scheduleReconnect(event.reason || '网络连接中断');
  } catch (error) {
    if (current !== generation) return;
    if ([401, 403, 404].includes(error.status)) placeholder('无法连接窗口', error.message);
    else scheduleReconnect(error.message);
  }
}
async function closePrevious(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  socket.onclose = null; socket.onmessage = null; socket.onerror = null;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('旧连接尚未释放，请稍后重新连接')), 3000);
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.close(1000, '重新连接');
  });
}
async function connect(automatic = false) {
  if (connecting) return;
  clearTimeout(retryTimer);
  if (!automatic) retryAttempt = 0;
  if (!sessionId) { placeholder('等待分配远程窗口', '如果尚未创建窗口，请返回工作台。'); return; }
  connecting = true; $('#reconnect').disabled = true;
  const current = ++generation;
  releaseKeys(); flushMove(); setConnected(false);
  displayedTab = undefined; activeTab = undefined; tabsFingerprint = '';
  screen.style.visibility = 'hidden';
  placeholder('正在连接远程浏览器', '正在验证权限并建立画面通道。', true);
  try {
    await closePrevious(ws);
    await inspectSession();
    if (current !== generation) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/sessions/${encodeURIComponent(sessionId)}?mode=${observe ? 'view' : 'control'}`);
    ws = socket; socket.binaryType = 'blob';
    let frameMeta;
    socket.onopen = () => send({ type: 'visibility', visible: !document.hidden }, socket);
    socket.onmessage = event => {
      if (current !== generation) return;
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'state') syncState(message);
        if (message.type === 'frame') frameMeta = message;
        if (message.type === 'notice' || message.type === 'error') notice(message.message);
        if (message.type === 'pong') latency = Math.round(performance.now() - message.at);
        return;
      }
      bytes += event.data.size;
      if (!frameMeta) { notice('收到缺少页面标识的画面，请重新连接'); return; }
      const frame = { blob: event.data, meta: frameMeta, socket, generation: current }; frameMeta = undefined;
      if (frame.meta.tabId !== activeTab || document.hidden) { ack(frame); return; }
      void drawFrame(frame);
    };
    socket.onclose = event => void disconnected(event, current);
    socket.onerror = () => { if (current === generation) $('#mode').textContent = '● 正在检查连接'; };
  } catch (error) {
    if ([401, 403, 404].includes(error.status)) placeholder('无法连接窗口', error.message);
    else scheduleReconnect(error.message);
  } finally { connecting = false; $('#reconnect').disabled = false; }
}
$('#reconnect').onclick = () => void connect();
$('#quality').onchange = event => input({ type: 'stream', profile: event.target.value });
$('#fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch (error) { notice(error.message); }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushMove(); releaseKeys(); }
  send({ type: 'visibility', visible: !document.hidden });
});
setInterval(() => {
  const now = performance.now(), elapsed = now - lastMetric;
  $('#metrics').textContent = `${Math.round((frames - lastFrames) * 1000 / elapsed)} FPS · ${latency} ms · ${Math.round((bytes - lastBytes) / elapsed)} KB/s`;
  lastMetric = now; lastFrames = frames; lastBytes = bytes;
  send({ type: 'ping', at: performance.now() });
}, 2000);
function coordinates(event) {
  const rect = screen.getBoundingClientRect();
  return { x: Math.min(1279, Math.max(0, (event.clientX - rect.left) * 1280 / rect.width)), y: Math.min(799, Math.max(0, (event.clientY - rect.top) * 800 / rect.height)) };
}
function pointer(event, type) {
  return { type: 'mouse', event: type, ...coordinates(event), button: ['left', 'middle', 'right'][event.button] || 'none',
    buttons: event.buttons, modifiers: modifiers(event), clickCount: Math.max(1, Math.min(event.detail || 1, 3)) };
}
function flushMove() { if (movePending) { input(movePending); movePending = undefined; } }
screen.addEventListener('pointerdown', event => {
  if (!control) return;
  event.preventDefault(); flushMove(); screen.setPointerCapture(event.pointerId);
  const rect = $('#stage').getBoundingClientRect();
  keyboard.style.left = `${event.clientX - rect.left}px`; keyboard.style.top = `${event.clientY - rect.top}px`;
  keyboard.focus({ preventScroll: true }); input(pointer(event, 'down'));
});
function pointerUp(event) {
  if (control) { flushMove(); input(pointer(event, 'up')); }
  if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
}
screen.addEventListener('pointerup', pointerUp);
screen.addEventListener('pointercancel', pointerUp);
screen.addEventListener('pointermove', event => {
  if (!control) return;
  const scheduled = !!movePending; movePending = pointer(event, 'move');
  if (!scheduled) requestAnimationFrame(flushMove);
});
screen.addEventListener('contextmenu', event => event.preventDefault());
screen.addEventListener('wheel', event => {
  if (!control) return; event.preventDefault(); flushMove();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
  input({ type: 'mouse', event: 'wheel', ...coordinates(event), deltaX: Math.min(4000, Math.max(-4000, event.deltaX * scale)),
    deltaY: Math.min(4000, Math.max(-4000, event.deltaY * scale)), modifiers: modifiers(event) });
}, { passive: false });
function flushText() {
  if (composing || !keyboard.value) return;
  input({ type: 'key', event: 'text', key: '', text: keyboard.value }); keyboard.value = '';
}
keyboard.addEventListener('compositionstart', () => composing = true);
keyboard.addEventListener('compositionend', () => { composing = false; flushText(); });
keyboard.addEventListener('input', flushText);
keyboard.addEventListener('paste', event => {
  event.preventDefault(); const text = event.clipboardData?.getData('text/plain');
  if (text) input({ type: 'key', event: 'text', key: '', text });
});
keyboard.addEventListener('keydown', event => {
  if (!control || event.isComposing || composing || event.key === 'Process' || event.keyCode === 229) return;
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  const message = { type: 'key', event: 'down', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) };
  pressed.set(event.code, message); input(message);
});
keyboard.addEventListener('keyup', event => {
  const message = pressed.get(event.code); if (!message) return;
  event.preventDefault(); pressed.delete(event.code); input({ ...message, event: 'up', modifiers: modifiers(event) });
});
function releaseKeys() { for (const message of pressed.values()) input({ ...message, event: 'up' }); pressed.clear(); }
keyboard.addEventListener('blur', releaseKeys);
$('#navigation').onsubmit = event => { event.preventDefault(); input({ type: 'navigate', url: $('#address').value.trim() }); };
document.querySelectorAll('[data-nav]').forEach(button => button.onclick = () => input({ type: 'nav', action: button.dataset.nav }));
window.addEventListener('beforeunload', () => { clearTimeout(retryTimer); generation++; ws?.close(); });
void connect();
