import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { chromium, type Page } from 'playwright';
import { createApp } from '../src/app.js';
import { startLab } from '../src/lab.js';
import type { Config } from '../src/config.js';
import type { RemoteSession } from '../src/browser.js';

test('management UI and real remote canvas: two users, text, shortcuts, IME and multiline', {timeout:120_000}, async t => {
  mkdirSync('test-results',{recursive:true});
  const lab=await startLab(0);
  const labOrigin=`http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
  const config: Config={host:'127.0.0.1',port:3410,origin:'http://127.0.0.1:3410',dataDir:mkdtempSync(resolve('test-results/ui-')),
    adminUser:'admin',adminPassword:'ui-admin-password-123',headless:true,idleMs:60_000,maxContexts:3,lab:false,labPort:3411};
  config.trustedNetworkOrigins = [labOrigin];
  const runtime=createApp(config);
  runtime.store.addEnvironment({name:'共享验证环境',startUrl:`${labOrigin}/`,allowedOrigins:[labOrigin],maxSessions:3});
  const server=serve({fetch:runtime.app.fetch,hostname:'127.0.0.1',port:0}) as Server;runtime.attach(server);
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  config.origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser=await chromium.launch();
  const errors:string[]=[];
  browser.on('disconnected',()=>{});
  const adminContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const adminPage=await adminContext.newPage();
  adminContext.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  adminPage.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{
    await browser.close();await runtime.close();
    await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>lab.close(()=>r()))]);
  });
  async function signIn(page: Page, username: string, password: string) {
    await page.goto(config.origin);
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#workspace').waitFor({state:'visible'});
  }
  async function openViewer(page: Page) {
    const popupPromise=page.waitForEvent('popup');
    await page.getByRole('button',{name:'打开独立窗口'}).click();
    const popup=await popupPromise;
    await popup.waitForURL('**/viewer.html?session=*');
    await popup.locator('#placeholder').waitFor({state:'hidden'});
    return popup;
  }
  async function remoteClick(viewer: Page, session: RemoteSession, selector: string) {
    await session.testPage().locator(selector).scrollIntoViewIfNeeded();
    const target=await session.testPage().locator(selector).boundingBox();
    const canvas=await viewer.locator('#screen').boundingBox();assert.ok(target);assert.ok(canvas);
    await viewer.mouse.click(canvas.x+(target.x+target.width/2)*canvas.width/1280,canvas.y+(target.y+target.height/2)*canvas.height/800);
  }
  async function valueIs(session: RemoteSession, selector: string, expected: string) {
    await session.testPage().waitForFunction(({selector,expected})=>(document.querySelector(selector) as HTMLInputElement)?.value===expected,{selector,expected},{timeout:8000});
  }
  async function until(check:()=>boolean, label:string) {
    const end=Date.now()+8000;
    while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,30));}
    throw new Error(`Timeout: ${label}`);
  }
  await adminPage.goto(config.origin);
  await adminPage.screenshot({path:'test-results/login.png',fullPage:true});
  await signIn(adminPage,'admin',config.adminPassword);
  await adminPage.locator('[data-view=members]').click();
  await adminPage.locator('#add-member').click();
  await adminPage.locator('#member-form [name=username]').fill('uiuser');
  await adminPage.locator('#member-form [name=password]').fill('ui-member-password-123');
  await adminPage.locator('#member-environments input').check();
  await adminPage.locator('#member-form [type=submit]').click();
  await adminPage.locator('#member-dialog').waitFor({state:'hidden'});
  await adminPage.locator('[data-view=environments]').click();
  await adminPage.locator('[data-action=edit-env]').click();
  await adminPage.locator('#environment-form [name=name]').fill('共享验证环境 · 已配置');
  await adminPage.locator('#environment-form [type=submit]').click();
  await adminPage.locator('#environment-dialog').waitFor({state:'hidden'});
  await adminPage.getByRole('heading',{name:'共享验证环境 · 已配置'}).waitFor();
  await adminPage.screenshot({path:'test-results/dashboard.png',fullPage:true});
  const adminViewer=await openViewer(adminPage);
  const adminSession=[...runtime.browsers.sessions.values()].find(s=>s.user.username==='admin')!;
  await remoteClick(adminViewer,adminSession,'#login');
  await adminSession.testPage().locator('#account').getByText('已登录 · demo-admin').waitFor();
  const memberContext=await browser.newContext({viewport:{width:1440,height:1000}});
  memberContext.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const memberPage=await memberContext.newPage();
  await signIn(memberPage,'uiuser','ui-member-password-123');
  assert.equal(await memberPage.locator('[data-view=members]').isVisible(),false);
  const memberViewer=await openViewer(memberPage);
  const memberSession=[...runtime.browsers.sessions.values()].find(s=>s.user.username==='uiuser')!;
  assert.ok((await memberSession.testPage().locator('#account').innerText()).includes('demo-admin'));
  await remoteClick(adminViewer,adminSession,'#text');
  await adminViewer.keyboard.type('Admin isolated');
  await valueIs(adminSession,'#text','Admin isolated');
  await remoteClick(memberViewer,memberSession,'#text');
  await memberViewer.keyboard.insertText('中文输入验证');
  await valueIs(memberSession,'#text','中文输入验证');
  await memberViewer.keyboard.press('Control+a');
  await memberViewer.keyboard.insertText('Shortcut selected');
  await valueIs(memberSession,'#text','Shortcut selected');
  await memberViewer.keyboard.press('Control+a');
  await memberViewer.locator('#keyboard').evaluate(element=>{
    const textarea=element as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    textarea.value='输入法合成';
    textarea.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'输入法合成'}));
    textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'输入法合成'}));
    textarea.dispatchEvent(new InputEvent('input',{bubbles:true,data:'输入法合成'}));
  });
  await valueIs(memberSession,'#text','输入法合成');
  await remoteClick(memberViewer,memberSession,'#notes');
  await memberViewer.keyboard.type('line one');await memberViewer.keyboard.press('Enter');await memberViewer.keyboard.type('line two');
  await valueIs(memberSession,'#notes','line one\nline two');
  assert.equal(await adminSession.testPage().locator('#text').inputValue(),'Admin isolated');
  await memberViewer.locator('#quality').selectOption('economy');
  await until(()=>memberSession.summary().stream.profile==='economy','quality selection');
  const oldController=memberSession.controller;
  await memberViewer.locator('#reconnect').click();
  await until(()=>!!memberSession.controller&&memberSession.controller!==oldController,'manual reconnect');
  await memberViewer.locator('#placeholder').waitFor({state:'hidden'});
  const interrupted=memberSession.controller!;interrupted.terminate();
  await until(()=>!!memberSession.controller&&memberSession.controller!==interrupted,'automatic reconnect');
  await memberViewer.locator('#placeholder').waitFor({state:'hidden'});
  assert.equal(await memberSession.testPage().locator('#notes').inputValue(),'line one\nline two');
  // A frame can finish decoding after the server has revoked this connection.
  await memberViewer.evaluate(`(() => {
    const original=window.createImageBitmap;
    let release;
    const gate=new Promise(resolve=>release=resolve);
    Object.defineProperty(window,'releaseTestFrame',{configurable:true,value:()=>{window.createImageBitmap=original;release();}});
    window.createImageBitmap=async(...args)=>{
      document.documentElement.dataset.frameDecoding='true';
      await gate;return original(...args);
    };
  })()`);
  await memberSession.testPage().evaluate(()=>document.body.style.backgroundColor='#dceae2');
  await memberViewer.waitForFunction(()=>document.documentElement.dataset.frameDecoding==='true');
  await memberSession.revokeControl();
  await memberViewer.getByText('远程连接已断开',{exact:true}).waitFor();
  await memberViewer.evaluate(()=>{
    Reflect.get(window,'releaseTestFrame')();
  });
  await memberViewer.waitForTimeout(150);
  assert.equal(await memberViewer.locator('#placeholder').isVisible(),true,'late decoded frames must not hide disconnection');
  await memberViewer.locator('#reconnect').click();
  await memberViewer.locator('#placeholder').waitFor({state:'hidden'});
  await memberViewer.locator('#quality').selectOption('balanced');
  await memberViewer.screenshot({path:'test-results/remote-window.png',fullPage:true});
  await memberPage.setViewportSize({width:390,height:844});
  await memberPage.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.equal(await memberPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile portal should not overflow');
  assert.deepEqual(errors,[],'no browser JavaScript errors');
});
