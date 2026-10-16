import { createServer } from 'node:http';

// A separate origin provides a real cookie/login target without using third-party accounts.
export function startLab(port: number, host = '127.0.0.1') {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/login') {
      res.writeHead(303, { 'Set-Cookie': 'relay_lab_account=demo-admin; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000', Location: '/' });
      res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/logout') {
      res.writeHead(303, { 'Set-Cookie': 'relay_lab_account=; HttpOnly; Path=/; Max-Age=0', Location: '/' });
      res.end(); return;
    }
    const loggedIn = /(?:^|;\s*)relay_lab_account=demo-admin(?:;|$)/.test(req.headers.cookie || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>RelayHub · 会话验证站</title>
    <style>*{box-sizing:border-box}body{margin:0;padding:56px;background:#eef4f1;color:#17372c;font:18px system-ui}main{max-width:900px;margin:auto}small{letter-spacing:3px;color:#558375}h1{font-size:42px}section{background:white;border:1px solid #d4e4dc;border-radius:18px;padding:26px;margin:20px 0}button,a{border:0;border-radius:8px;background:#16765a;color:white;padding:12px 20px;cursor:pointer;text-decoration:none;font:inherit}input,textarea{display:block;width:100%;padding:14px;margin:14px 0;border:1px solid #afc9bc;border-radius:8px;font:inherit}p{line-height:1.7}.bottom{margin-top:850px}</style>
    <main><small>RELAYHUB / LIVE VERIFICATION</small><h1>同一账号，各自操作。</h1>
    <section><p>共享登录状态：<strong id="account">${loggedIn ? '已登录 · demo-admin' : '尚未登录'}</strong></p>
    <form method="post" action="${loggedIn ? '/logout' : '/login'}"><button id="login">${loggedIn ? '退出共享账号' : '管理员登录测试账号'}</button></form>
    <p>在一个窗口登录，另一个窗口刷新后会看到同一账号。Cookie 设置了 30 天有效期，可验证浏览器重启后的持久化。</p></section>
    <section><h2>当前页面的独立状态</h2><button id="increment">计数 +1</button> <strong id="count">0</strong>
    <input id="text" placeholder="在这里测试键盘、中文输入和粘贴" aria-label="输入测试">
    <textarea id="notes" placeholder="每个页面单独输入，不会写入另一页" aria-label="笔记"></textarea>
    <p>当前路径：<span id="path"></span></p><a id="navigate" href="/second">导航至第二页</a> <a id="popup" href="/popup" target="_blank">打开关联弹窗</a></section>
    <section class="bottom"><h2>滚动到这里，说明滚轮也已连接。</h2><a href="/">返回首页</a></section></main>
    <script>let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++count);document.querySelector('#path').textContent=location.pathname;</script></html>`);
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
