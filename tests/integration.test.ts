import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { startLab } from '../src/lab.js';
import type { Config } from '../src/config.js';
import type { RemoteSession } from '../src/browser.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(40); }
  throw new Error(`Timeout: ${message}`);
}
test('real Chromium: shared account, independent input/frames, authorization and persistence', { timeout: 180_000 }, async t => {
  mkdirSync('test-results', { recursive: true });
  const dataDir = mkdtempSync(resolve('test-results/runtime-'));
  const lab = await startLab(0);
  const labOrigin = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const config: Config = {
    host: '127.0.0.1', port: 3410, origin: 'http://127.0.0.1:3410', dataDir,
    adminUser: 'admin', adminPassword: 'test-admin-password-123', headless: true,
    idleMs: 60_000, maxContexts: 4, lab: false, labPort: 3411,
  };
  config.trustedNetworkOrigins = [labOrigin];
  const runtime = createApp(config);
  const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  runtime.attach(server);
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach(ws => ws.terminate());
    await runtime.close();
    await Promise.all([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => lab.close(() => resolve())),
    ]);
  });
  async function request(path: string, method = 'GET', body?: unknown, cookie = '', origin = config.origin) {
    const res = await fetch(`${config.origin}/api${path}`, { method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  async function login(username: string, password: string) {
    const res = await request('/login', 'POST', {username, password});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.cookie;
  }
  type Client = { ws: WebSocket; frames: Buffer[]; messages: Record<string, unknown>[]; send: (message: unknown) => void };
  async function connect(sessionId: string, cookie: string, mode = 'control', acknowledge = true): Promise<Client> {
    const ws = new WebSocket(`${config.origin.replace('http:', 'ws:')}/ws/sessions/${sessionId}?mode=${mode}`, {
      headers: { Cookie: cookie, Origin: config.origin },
    });
    sockets.push(ws);
    const frames: Buffer[] = [], messages: Record<string, unknown>[] = [];
    let sequence = 0;
    ws.on('message', (data, binary) => {
      if (binary) { frames.push(Buffer.from(data as Buffer)); if(frames.length > 20) frames.shift(); if(acknowledge)ws.send(JSON.stringify({type:'frame_ack',sequence})); }
      else { const message=JSON.parse(data.toString()); messages.push(message); if(message.type==='frame')sequence=message.sequence; }
    });
    await new Promise<void>((resolve,reject) => {ws.once('open',resolve); ws.once('error',reject);});
    await until(() => messages.some(message => message.type === 'state'), 'initial state');
    return {ws,frames,messages,send:message=>ws.send(JSON.stringify(message))};
  }
  async function refused(sessionId: string, cookie: string, status: number, origin = config.origin) {
    const ws = new WebSocket(`${config.origin.replace('http:','ws:')}/ws/sessions/${sessionId}`, {headers:{Cookie:cookie,Origin:origin}});
    await new Promise<void>((resolve,reject)=>{
      ws.on('unexpected-response',(_req,res)=>{try{assert.equal(res.statusCode,status);res.resume();ws.terminate();resolve();}catch(error){reject(error);}});
      ws.on('open',()=>{ws.terminate();reject(new Error('Unauthorized WebSocket opened'));});
      ws.on('error',()=>{});
    });
  }
  async function click(client: Client, session: RemoteSession, selector: string) {
    await session.testPage().locator(selector).scrollIntoViewIfNeeded();
    const box = await session.testPage().locator(selector).boundingBox();
    assert.ok(box, selector);
    client.send({type:'mouse',event:'click',x:box.x+box.width/2,y:box.y+box.height/2,button:'left'});
  }
  const admin = await login('admin', config.adminPassword);
  let envId = '', aliceId = '', bobId = '', aliceCookie = '', bobCookie = '';
  let adminSession!: RemoteSession, aliceSession!: RemoteSession, bobSession!: RemoteSession;
  let adminClient!: Client, aliceClient!: Client, bobClient!: Client;

  await t.test('HTTP authorization, exact origins, grants and static UI', async () => {
    assert.equal((await request('/me')).status, 401);
    assert.equal((await request('/login','POST',{username:'admin',password:config.adminPassword},'','https://other.example')).status,403);
    assert.equal((await fetch(`${config.origin}/`)).status,200);
    assert.equal((await fetch(`${config.origin}/viewer.html`)).status,200);
    const env = await request('/admin/environments','POST',{name:'Live verification',startUrl:`${labOrigin}/`,allowedOrigins:[labOrigin],maxSessions:3},admin);
    assert.equal(env.status,201); envId=env.body.environment.id;
    for(const username of ['alice','bob']) {
      const res=await request('/admin/users','POST',{username,password:`${username}-password-123`},admin);
      assert.equal(res.status,201);
      if(username==='alice')aliceId=res.body.user.id;else bobId=res.body.user.id;
    }
    aliceCookie=await login('alice','alice-password-123');bobCookie=await login('bob','bob-password-123');
    assert.equal((await request('/admin/users','GET',undefined,aliceCookie)).status,403);
    assert.equal((await request('/sessions','POST',{environmentId:envId},aliceCookie)).status,404);
    for(const id of [aliceId,bobId]) assert.equal((await request(`/admin/users/${id}/grants/${envId}`,'PUT',undefined,admin)).status,200);
  });
  await t.test('parallel session allocation uses one persistent browser context', async () => {
    const res=await Promise.all([admin,aliceCookie,bobCookie].map(cookie=>request('/sessions','POST',{environmentId:envId},cookie)));
    res.forEach(r=>assert.equal(r.status,201,JSON.stringify(r.body)));
    [adminSession,aliceSession,bobSession]=res.map(r=>runtime.browsers.sessions.get(r.body.session.id)!);
    assert.equal(adminSession.testPage().context(),aliceSession.testPage().context());
    assert.equal(aliceSession.testPage().context(),bobSession.testPage().context());
    assert.equal((await request('/sessions','POST',{environmentId:envId},aliceCookie)).status,409);
    [adminClient,aliceClient,bobClient]=await Promise.all([connect(adminSession.id,admin),connect(aliceSession.id,aliceCookie),connect(bobSession.id,bobCookie)]);
    await Promise.all([adminClient,aliceClient,bobClient].map(c=>until(()=>c.frames.length>=2,'independent JPEG frames')));
    [adminClient,aliceClient,bobClient].forEach(c=>assert.equal(c.frames[0]!.subarray(0,2).toString('hex'),'ffd8'));
  });
  await t.test('one login is shared by both member pages', async () => {
    await click(adminClient,adminSession,'#login');
    await until(async()=> (await adminSession.testPage().locator('#account').innerText()).includes('demo-admin'),'admin login');
    for(const client of [aliceClient,bobClient])client.send({type:'nav',action:'reload'});
    await Promise.all([aliceSession,bobSession].map(s=>until(async()=>(await s.testPage().locator('#account').innerText()).includes('demo-admin'),'shared login')));
    await adminSession.testPage().evaluate(()=>localStorage.setItem('relay-shared','same-context'));
    assert.equal(await bobSession.testPage().evaluate(()=>localStorage.getItem('relay-shared')),'same-context');
  });
  await t.test('mouse, Chinese text, keyboard and navigation do not cross targets', async () => {
    await Promise.all([click(aliceClient,aliceSession,'#text'),click(bobClient,bobSession,'#text')]);
    aliceClient.send({type:'key',event:'text',key:'',text:'Alice 中文输入'});
    bobClient.send({type:'key',event:'text',key:'',text:'Bob 独立页面'});
    await until(async()=>await aliceSession.testPage().locator('#text').inputValue()==='Alice 中文输入','Alice text');
    await until(async()=>await bobSession.testPage().locator('#text').inputValue()==='Bob 独立页面','Bob text');
    aliceClient.send({type:'key',event:'down',key:'Backspace',code:'Backspace',keyCode:8});
    aliceClient.send({type:'key',event:'up',key:'Backspace',code:'Backspace',keyCode:8});
    await until(async()=>await aliceSession.testPage().locator('#text').inputValue()==='Alice 中文输','Backspace');
    assert.equal(await bobSession.testPage().locator('#text').inputValue(),'Bob 独立页面');
    await click(aliceClient,aliceSession,'#increment');
    await until(async()=>await aliceSession.testPage().locator('#count').innerText()==='1','Alice counter');
    assert.equal(await bobSession.testPage().locator('#count').innerText(),'0');
    aliceClient.send({type:'navigate',url:`${labOrigin}/second`});
    await aliceSession.testPage().waitForURL('**/second');
    assert.equal(bobSession.testPage().url(),`${labOrigin}/`);
    bobClient.send({type:'mouse',event:'wheel',x:600,y:700,deltaY:700});
    await until(async()=>await bobSession.testPage().evaluate(()=>scrollY)>0,'independent wheel');
    assert.equal(await aliceSession.testPage().evaluate(()=>scrollY),0);
  });
  await t.test('popups belong to the originating member', async () => {
    await click(aliceClient,aliceSession,'#popup');
    await until(()=>aliceSession.tabs.size===2,'popup registered');
    await aliceSession.testPage().waitForURL('**/popup');
    assert.equal(bobSession.tabs.size,1);assert.equal(adminSession.tabs.size,1);
    assert.equal((await aliceSession.testPage().locator('#account').innerText()).includes('demo-admin'),true);
  });
  await t.test('ownership, read-only monitoring, control lease and invalid messages', async () => {
    assert.equal((await request(`/sessions/${bobSession.id}`,'DELETE',undefined,aliceCookie)).status,404);
    await refused(bobSession.id,aliceCookie,404);
    await refused(bobSession.id,bobCookie,409);
    await refused(bobSession.id,bobCookie,403,'https://other.example');
    const observer=await connect(bobSession.id,admin,'view');
    observer.send({type:'navigate',url:`${labOrigin}/second`});
    await until(()=>observer.messages.some(m=>m.type==='error'&&String(m.message).includes('只读')),'read-only observer');
    bobClient.send({type:'tab',action:'switch',tabId:aliceSession.activeTabId});
    await until(()=>bobClient.messages.some(m=>m.type==='error'&&String(m.message).includes('不属于')),'foreign tab blocked');
    bobClient.send({type:'navigate',url:'file:///etc/passwd'});
    await until(()=>bobClient.messages.some(m=>m.type==='error'&&String(m.message).includes('HTTP')),'local protocol blocked');
    bobClient.send({type:'mouse',event:'click',x:0,y:0,sessionId:aliceSession.id});
    await until(()=>bobClient.messages.some(m=>m.type==='error'&&String(m.message).includes('格式')),'extra fields rejected');
    bobClient.send({type:'mouse',event:'click',x:0,y:0,targetId:aliceSession.activeTabId});
    await until(()=>bobClient.messages.some(m=>m.type==='error'&&String(m.message).includes('页面已切换')),'stale-frame input rejected');
    aliceClient.send({type:'navigate',url:'https://example.com/'});
    await until(()=>aliceClient.messages.some(m=>m.type==='error'&&String(m.message).includes('允许来源')),'navigation policy');
    const response=await aliceSession.testPage().evaluate(async()=>{try{await fetch('https://example.com/');return 'allowed';}catch{return 'blocked';}});
    assert.equal(response,'blocked');
    assert.equal((await request(`/admin/sessions/${bobSession.id}/revoke-control`,'POST',undefined,admin)).status,200);
    await until(()=>bobClient.ws.readyState===WebSocket.CLOSED,'controller revoked');
    const takeover=await connect(bobSession.id,admin);assert.ok(takeover);
    await request(`/admin/users/${aliceId}/grants/${envId}`,'DELETE',undefined,admin);
    await until(()=>!runtime.browsers.sessions.has(aliceSession.id),'grant revocation closes pages');
    assert.equal((await request('/sessions','POST',{environmentId:envId},aliceCookie)).status,404);
  });
  await t.test('stream keeps updating on all targets and persists a real JPEG artifact', async () => {
    const before=adminSession.summary().frames;
    await until(()=>adminSession.summary().frames>before+2,'admin background frames');
    assert.equal(adminSession.summary().captureFailures,0);
    assert.equal(bobSession.summary().captureFailures,0);
    writeFileSync(join(dataDir,'remote-frame.jpg'),adminClient.frames.at(-1)!);
  });
  await t.test('static frames are suppressed and pointer input does not rebuild state', async () => {
    await adminSession.testPage().evaluate(()=>{ (document.activeElement as HTMLElement)?.blur(); });
    await pause(150);
    const before=adminSession.summary().stream;
    const states=adminClient.messages.filter(m=>m.type==='state').length;
    for(let i=0;i<20;i++)adminClient.send({type:'mouse',event:'move',x:10+i,y:10});
    await pause(1500);
    const after=adminSession.summary().stream;
    assert.equal(adminClient.messages.filter(m=>m.type==='state').length,states);
    assert.ok(after.suppressed>before.suppressed,'identical captures should not be transmitted');
    assert.ok(after.transmitted-before.transmitted<after.captured-before.captured);
    writeFileSync(join(dataDir,'static-stream-sample.json'),JSON.stringify({sampleMs:1500,captured:after.captured-before.captured,transmitted:after.transmitted-before.transmitted,suppressed:after.suppressed-before.suppressed},null,2));
  });
  await t.test('slow observer has one unacknowledged frame while controller keeps receiving', async () => {
    const slow=await connect(adminSession.id,admin,'view',false);
    await until(()=>slow.frames.length===1,'first unacknowledged frame');
    await adminSession.testPage().evaluate(()=>document.body.style.backgroundColor='#123456');
    await pause(400);
    assert.equal(slow.frames.length,1,'do not queue more frames behind a stalled decoder');
    slow.send({type:'frame_ack',sequence:slow.messages.find(m=>m.type==='frame')!.sequence});
    await adminSession.testPage().evaluate(()=>document.body.style.backgroundColor='#654321');
    await until(()=>slow.frames.length===2,'ack resumes the observer');
    slow.ws.close();
  });
  await t.test('quality profiles apply and invisible sessions stop capture', async () => {
    adminClient.send({type:'stream',profile:'economy'});
    await until(()=>adminSession.summary().stream.profile==='economy','profile changed');
    assert.equal(adminSession.summary().stream.fps,4);
    adminClient.send({type:'visibility',visible:false});
    await until(()=>adminSession.summary().stream.visibleViewers===0,'viewer paused');
    await pause(100);const before=adminSession.summary().stream.captured;
    await pause(500);assert.equal(adminSession.summary().stream.captured,before);
    adminClient.send({type:'visibility',visible:true});
    await until(()=>adminSession.summary().stream.captured>before,'capture resumed');
    adminClient.send({type:'stream',profile:'balanced'});
  });
  await t.test('logout closes only the matching login and successful logins do not exhaust limits', async () => {
    const secondLogin=await login('admin',config.adminPassword);
    const observer=await connect(adminSession.id,secondLogin,'view');
    await request('/logout','POST',undefined,secondLogin);
    await until(()=>observer.ws.readyState===WebSocket.CLOSED,'logout closes its observer');
    assert.equal(adminClient.ws.readyState,WebSocket.OPEN,'another login remains connected');
    for(let i=0;i<21;i++){
      const cookie=await login('admin',config.adminPassword);
      await request('/logout','POST',undefined,cookie);
    }
    assert.equal((await request('/me','GET',undefined,admin)).status,200);
  });
  await t.test('slow navigation does not delay ping and revoked input cannot run later', async () => {
    let release!:()=>void,requested=false;
    const gate=new Promise<void>(resolve=>release=resolve);
    await adminSession.testPage().route(`${labOrigin}/slow`,async route=>{
      requested=true;await gate;
      await route.fulfill({contentType:'text/html',body:'<input id="late" autofocus>'});
    });
    try {
      adminClient.send({type:'navigate',url:`${labOrigin}/slow`});
      await until(()=>requested,'slow page requested');
      adminClient.send({type:'ping',at:123456});
      await until(()=>adminClient.messages.some(m=>m.type==='pong'&&m.at===123456),'ping while navigation waits',1000);
      const revoke=request(`/admin/sessions/${adminSession.id}/revoke-control`,'POST',undefined,admin);
      await until(()=>!adminSession.controller,'controller invalidated before navigation completes');
      adminClient.send({type:'key',event:'text',key:'',text:'stale input'});
      release();assert.equal((await revoke).status,200);
      await until(()=>adminClient.ws.readyState===WebSocket.CLOSED,'revoked connection closed');
      assert.equal(await adminSession.testPage().locator('#late').inputValue(),'');
      adminClient=await connect(adminSession.id,admin);
    } finally {release();}
  });
  await t.test('stopping and restarting the browser preserves login cookies', async () => {
    await request(`/admin/environments/${envId}/stop`,'POST',undefined,admin);
    assert.equal(runtime.browsers.sessions.size,0);
    const res=await request('/sessions','POST',{environmentId:envId},admin);
    assert.equal(res.status,201,JSON.stringify(res.body));
    const resumed=runtime.browsers.sessions.get(res.body.session.id)!;
    assert.ok((await resumed.testPage().locator('#account').innerText()).includes('demo-admin'));
    assert.equal(await resumed.testPage().evaluate(()=>localStorage.getItem('relay-shared')),'same-context');
    await resumed.close();
  });
  await t.test('idle disconnected windows are reclaimed and logout revokes the cookie', async () => {
    const res=await request('/sessions','POST',{environmentId:envId},admin);
    assert.equal(res.status,201);
    const session=runtime.browsers.sessions.get(res.body.session.id)!;
    session.lastUsed=Date.now()-120_000;
    await runtime.browsers.cleanup();assert.equal(runtime.browsers.sessions.size,0);
    assert.equal((await request('/logout','POST',undefined,bobCookie)).status,200);
    assert.equal((await request('/me','GET',undefined,bobCookie)).status,401);
  });
  await t.test('editing an environment keeps its profile and existing member grants', async () => {
    const first=await request('/sessions','POST',{environmentId:envId},admin);assert.equal(first.status,201);
    const before=runtime.store.environment(envId)!;
    const input={...before,name:'Edited environment',startUrl:`${labOrigin}/second`,maxSessions:4};
    assert.equal((await request(`/admin/environments/${envId}`,'PUT',input,aliceCookie)).status,403);
    const result=await request(`/admin/environments/${envId}`,'PUT',input,admin);
    assert.equal(result.status,200);assert.equal(result.body.environment.id,envId);
    assert.equal(runtime.browsers.sessions.size,0);
    assert.ok(runtime.store.grantIds(bobId).includes(envId));
    const restarted=await request('/sessions','POST',{environmentId:envId},admin);
    assert.equal(restarted.status,201);
    const session=runtime.browsers.sessions.get(restarted.body.session.id)!;
    assert.equal(session.testPage().url(),`${labOrigin}/second`);
    assert.ok((await session.testPage().locator('#account').innerText()).includes('demo-admin'));
  });
});
