import { api as request, login, logout, initConnection, getConnection, checkBackend, saveBackend, resetConnection, viewerUrl, reserveViewer } from './connection.js';

const $ = selector => document.querySelector(selector);
let user, environments = [], sessions = [], members = [], view = 'environments';
let refreshTimer, toastTimer, refreshOperation;
let backendOperation;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles = {environments:['账号环境','选择一个账号环境，打开属于你的远程窗口。'],sessions:['运行窗口','查看实时连接、继续操作，或释放闲置窗口。'],members:['成员管理','为成员分配账号环境和访问权限。'],audit:['操作记录','查看登录、环境配置和窗口生命周期记录。']};
async function api(path, options = {}) {
  try { return await request(path, options); }
  catch (error) {
    if (error.status === 401 && user && !options.signal?.aborted) {
      showLogin(); $('#login-error').textContent=error.message;
    }
    throw error;
  }
}
function toast(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,5000); }
function showLogin() {
  cancelRefresh(); user=undefined; environments=[]; sessions=[]; members=[];
  $('#workspace').hidden=true; $('#login-screen').hidden=false;
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  for (const key of Object.keys(titles)) $(`#${key}-view`).replaceChildren();
}
async function showWorkspace(current) {
  cancelRefresh();
  user=current; $('#login-screen').hidden=true; $('#workspace').hidden=false;
  $('#username').textContent=user.username; $('#avatar').textContent=user.username[0].toUpperCase(); $('#role').textContent=user.role==='admin'?'工作空间管理员':'普通成员';
  document.querySelectorAll('.admin-only').forEach(el=>el.hidden=user.role!=='admin');
  try { await setView('environments'); }
  catch(error) { toast(error.message); }
}
function refreshBusy(busy) {
  $('#refresh').disabled=busy;
  $('#refresh').setAttribute('aria-busy',String(busy));
  $('#refresh').textContent=busy?'刷新中…':'↻ 刷新';
}
function cancelRefresh() {
  clearTimeout(refreshTimer);
  refreshOperation?.controller.abort(); refreshOperation=undefined;
  refreshBusy(false);
}
async function refresh() {
  cancelRefresh();
  if (!user || document.hidden) return;
  const operation={controller:new AbortController(),view};
  refreshOperation=operation; refreshBusy(true);
  const options={signal:operation.controller.signal};
  try {
    const result=await Promise.all([api('/environments',options),api('/sessions',options),
      user.role==='admin' && operation.view==='members'?api('/admin/users',options):null,
      operation.view==='audit'?api('/admin/audit',options):null]);
    if(refreshOperation!==operation || operation.controller.signal.aborted) return;
    environments=result[0].environments; sessions=result[1].sessions;
    if(result[2]) members=result[2].users;
    connectionStatus('服务已连接', true);
    $('#stat-environments').textContent=environments.length; $('#environment-count').textContent=environments.length;
    $('#stat-sessions').textContent=sessions.length; $('#session-count').textContent=sessions.length;
    $('#stat-connections').textContent=sessions.reduce((sum,s)=>sum+s.clients,0);
    renderEnvironments(); renderSessions();
    if(operation.view==='members') renderMembers();
    if(result[3]) renderAudit(result[3].entries);
  } catch(error) {
    if(refreshOperation!==operation || operation.controller.signal.aborted) return;
    operation.controller.abort();
    connectionStatus(error.message, false);
    throw error;
  } finally {
    if(refreshOperation===operation) {
      refreshOperation=undefined; refreshBusy(false);
      // Wait after settlement: slow responses cannot accumulate interval callbacks.
      if(user && !document.hidden) refreshTimer=setTimeout(()=>void refresh().catch(error=>toast(error.message)),7000);
    }
  }
}
function renderEnvironments() {
  const query=$('#search').value.trim().toLowerCase();
  const visible=environments.filter(e=>`${e.name} ${e.startUrl}`.toLowerCase().includes(query));
  $('#environments-view').innerHTML=visible.length?visible.map(env=>{
    const own=sessions.find(s=>s.environmentId===env.id && s.userId===user.id);
    const status={running:'● 环境运行中',stopped:'按需启动',online:'● 本地设备在线',offline:'本地设备离线',paused:'已暂停共享'}[env.status]||env.status;
    return `<article class="environment-card"><div class="card-top"><div class="site-icon">${esc(env.name[0].toUpperCase())}</div><span class="badge ${['running','online'].includes(env.status)?'':'off'}">${esc(status)}</span></div><h3>${esc(env.name)}</h3><p class="site-url" title="${esc(env.startUrl)}">${esc(env.startUrl)}</p><div class="card-meta"><span>${env.sessions} / ${env.maxSessions} 个窗口</span><b>${env.ownerId===user.id?'我的环境':'已授权'} · ${env.kind==='local'?'本地设备':'服务器'}</b></div><div class="card-actions"><button class="primary" data-action="${own?'connect':'start'}" data-id="${esc(own?.id||env.id)}" ${['offline','paused'].includes(env.status)?'disabled':''}>${own?'继续我的窗口':'打开独立窗口'} <span>↗</span></button>${env.canManage?`<button class="secondary" data-action="share-env" data-id="${env.id}">共享成员</button><button class="secondary" data-action="pause-env" data-id="${env.id}">${env.paused?'恢复共享':'暂停共享'}</button><button class="secondary" data-action="edit-env" data-id="${env.id}">编辑</button><button class="secondary" data-action="stop" data-id="${env.id}" title="关闭全部窗口并保存浏览器资料">停止</button>${env.kind==='local'?`<button class="secondary" data-action="pair-agent" data-id="${env.id}">下载设备配置</button><button class="secondary" data-action="revoke-agent" data-id="${env.id}">撤销设备</button>`:''}<button class="secondary" data-action="env-audit" data-id="${env.id}">记录</button><button class="secondary" data-action="delete-env" data-id="${env.id}" title="删除环境配置，浏览器资料保留">×</button>`:''}</div></article>`;
  }).join(''):`<div class="empty"><strong>${query?'没有匹配的环境':'还没有可用的账号环境'}</strong>添加自己的私有环境，登录网站后选择共享成员。</div>`;
}
function table(headers, rows) { return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
function renderSessions() {
  $('#sessions-view').innerHTML=sessions.length?table(['窗口 / 账号环境','所属成员','连接状态','创建时间','操作'],sessions.map(s=>`<tr><td>${esc(s.environmentName)}<small>${s.id.slice(0,8)} · ${s.tabs} 个标签页</small></td><td>${esc(s.username)}</td><td><span class="badge ${s.clients?'':'off'}">${s.clients} 个连接${s.controlled?' · 正在操控':''}</span></td><td>${new Date(s.createdAt).toLocaleTimeString()}</td><td><button class="secondary" data-action="${s.userId===user.id?'connect':'observe'}" data-id="${s.id}">${s.userId===user.id?'连接':'观察'}</button>${environments.find(env=>env.id===s.environmentId)?.canManage&&s.userId!==user.id?`<button class="secondary" data-action="takeover" data-id="${s.id}">接管</button>`:''}<button class="danger" data-action="close" data-id="${s.id}">释放</button></td></tr>`)):'<div class="empty"><strong>当前没有运行窗口</strong>前往账号环境，打开一个独立窗口。</div>';
}
function renderMembers() {
  $('#members-view').innerHTML=table(['成员','角色','账号环境','状态','操作'],members.map(m=>`<tr><td>${esc(m.username)}</td><td>${m.role==='admin'?'管理员':'普通成员'}</td><td>${m.role==='admin'?'全部环境':m.environmentIds.length+' 个环境'}</td><td>${m.enabled?'正常':'已停用'}</td><td>${m.enabled&&m.role!=='admin'?`<button class="secondary" data-action="grants" data-id="${m.id}">分配环境</button>`:''}${m.enabled&&m.id!==user.id?`<button class="danger" data-action="disable" data-id="${m.id}">停用</button>`:''}</td></tr>`));
}
function renderAudit(entries) {
  const labels={'login':'成员登录','session.create':'创建窗口','session.close':'释放窗口','environment.create':'创建环境','environment.update':'编辑环境','environment.stop':'停止环境','environment.delete':'删除环境','user.create':'创建成员','user.disable':'停用成员','grant.add':'分配环境','grant.revoke':'撤销环境权限','control.revoke':'收回操控权'};
  $('#audit-view').innerHTML=entries.length?table(['时间（UTC）','操作','操作者 ID','对象 ID'],entries.map(e=>`<tr><td>${esc(e.at)}</td><td>${esc(labels[e.action]||e.action)}</td><td>${esc(e.userId?.slice(0,8))}</td><td>${esc(e.objectId?.slice(0,32))}</td></tr>`)):'<div class="empty">尚无记录</div>';
}
async function setView(next) {
  view=next;
  for(const key of Object.keys(titles)) $(`#${key}-view`).hidden=key!==view;
  document.querySelectorAll('.nav').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#view-title').textContent=titles[view][0]; $('#breadcrumb').textContent=titles[view][0]; $('#view-description').textContent=titles[view][1];
  $('#environment-tools').hidden=view!=='environments'; $('#add-environment').hidden=view!=='environments'; $('#add-member').hidden=view!=='members';
  await refresh();
}
function openViewer(id, observe=false) {
  const viewer=reserveViewer();
  if(viewer) viewer.location.replace(viewerUrl(id,observe));
  else toast('浏览器阻止了新窗口，请允许弹出窗口后重试。');
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button'); if(!button) return;
  if(button.dataset.view) { try { await setView(button.dataset.view); } catch(error){toast(error.message);} return; }
  const action=button.dataset.action,id=button.dataset.id;
  if(!action) return;
  button.disabled=true;
  try {
    if(action==='start') {
      // Reserve the client tab during the user gesture, before the async browser launch.
      const viewer=reserveViewer();
      try { const {session}=await api('/sessions',{method:'POST',body:JSON.stringify({environmentId:id})});
        if(viewer) viewer.location.replace(viewerUrl(session.id));
        else toast('窗口已创建，请从运行窗口列表连接。');
      } catch(error) { viewer?.close(); throw error; }
    }
    if(action==='connect') openViewer(id);
    if(action==='observe') openViewer(id,true);
    if(action==='takeover') {
      const viewer=reserveViewer();
      try { await api(`/sessions/${id}/revoke-control`,{method:'POST'});
        if(viewer) viewer.location.replace(viewerUrl(id));
        else toast('控制权已收回，请允许弹出窗口后从列表连接。');
      } catch(error) { viewer?.close(); throw error; }
    }
    if(action==='close' && confirm('释放此窗口？当前页面和未保存的输入将关闭。')) await api(`/sessions/${id}`,{method:'DELETE'});
    if(action==='stop' && confirm('停止整个账号环境？该环境的全部窗口将关闭，登录资料会保留。')) await api(`/environments/${id}/stop`,{method:'POST'});
    if(action==='delete-env' && confirm('删除环境配置并关闭全部窗口？浏览器资料保留在原来的服务器或设备上。')) await api(`/environments/${id}`,{method:'DELETE'});
    if(action==='pause-env') await api(`/environments/${id}/pause`,{method:'POST',body:JSON.stringify({paused:!environments.find(env=>env.id===id).paused})});
    if(action==='share-env') { await showEnvironmentGrants(id); return; }
    if(action==='env-audit') {
      const {entries}=await api(`/environments/${id}/audit`);
      $('#environment-audit-list').innerHTML=table(['时间（UTC）','操作','操作者'],entries.map(entry=>`<tr><td>${esc(entry.at)}</td><td>${esc(entry.action)}</td><td>${esc(entry.userId)}</td></tr>`));
      $('#environment-audit-dialog').showModal(); return;
    }
    if(action==='pair-agent' && confirm('下载新的设备配置？旧配置将失效。此文件只交给运行本地浏览器的设备所有者。')) {
      const config=await api(`/environments/${id}/agent-key`,{method:'POST'});
      const url=URL.createObjectURL(new Blob([JSON.stringify(config,null,2)],{type:'application/json'}));
      const link=document.createElement('a'); link.href=url; link.download=`relayhub-agent-${id.slice(0,8)}.json`; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('设备配置已下载。请按安装说明启动 Local Agent。');
    }
    if(action==='revoke-agent' && confirm('撤销设备连接并关闭正在使用的本地窗口？设备上的登录资料会保留。')) await api(`/environments/${id}/agent-key`,{method:'DELETE'});
    if(action==='disable' && confirm('停用此成员并关闭其全部窗口？')) await api(`/admin/users/${id}/disable`,{method:'POST'});
    if(action==='grants') { showGrants(id); return; }
    if(action==='edit-env') { showEnvironment(id); return; }
    await refresh();
  } catch(error) { toast(error.message); } finally { button.disabled=false; }
});
function environmentCheckboxes(ids=[]) { return environments.map(e=>`<label><input type="checkbox" value="${e.id}" ${ids.includes(e.id)?'checked':''}>${esc(e.name)}</label>`).join('')||'<p class="muted">暂无账号环境</p>'; }
async function showEnvironmentGrants(id) {
  const [directory,granted]=await Promise.all([api('/members'),api(`/environments/${id}/grants`)]);
  const ids=new Set(granted.members.map(member=>member.id));
  const env=environments.find(env=>env.id===id);
  $('#environment-grants-list').innerHTML=directory.members.filter(member=>member.id!==env.ownerId).map(member=>`<label><input type="checkbox" value="${esc(member.id)}" ${ids.has(member.id)?'checked':''}>${esc(member.username)}</label>`).join('')||'<p>没有其他可授权的成员。</p>';
  $('#environment-grants-dialog .form-error').textContent=''; $('#environment-grants-dialog').showModal();
  $('#environment-grants-list').onchange=async event=>{
    const input=event.target; input.disabled=true;
    try { await api(`/environments/${id}/grants/${input.value}`,{method:input.checked?'PUT':'DELETE'}); await refresh(); }
    catch(error) {input.checked=!input.checked;$('#environment-grants-dialog .form-error').textContent=error.message;}
    finally {input.disabled=false;}
  };
}
function showGrants(id) {
  const member=members.find(m=>m.id===id); $('#grant-list').innerHTML=environmentCheckboxes(member.environmentIds);
  $('#grants-dialog .form-error').textContent=''; $('#grants-dialog').showModal();
  $('#grant-list').onchange=async event=>{
    const input=event.target; input.disabled=true;
    try { await api(`/admin/users/${id}/grants/${input.value}`,{method:input.checked?'PUT':'DELETE'}); await refresh(); }
    catch(error) { input.checked=!input.checked; $('#grants-dialog .form-error').textContent=error.message; }
    finally { input.disabled=false; }
  };
}
$('#login-form').onsubmit=async event=>{
  event.preventDefault(); const form=event.target,button=form.querySelector('button'); button.disabled=true; $('#login-error').textContent='';
  try { const {user:current}=await login(Object.fromEntries(new FormData(form))); form.reset(); await showWorkspace(current); }
  catch(error){$('#login-error').textContent=error.message;} finally {button.disabled=false;}
};
$('#logout').onclick=async()=>{try{await logout();showLogin();}catch(error){toast(error.message);}};
$('#refresh').onclick=()=>refresh().catch(error=>toast(error.message));
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) cancelRefresh();
  else if(user) void refresh().catch(error=>toast(error.message));
});
window.addEventListener('pagehide',cancelRefresh);
window.addEventListener('pageshow',event=>{
  if(event.persisted && user) void refresh().catch(error=>toast(error.message));
});
$('#search').oninput=renderEnvironments;
function showEnvironment(id) {
  const form=$('#environment-form'), env=environments.find(item=>item.id===id);
  form.reset(); form.dataset.environmentId=env?.id||'';
  form.querySelector('h2').textContent=env?'编辑账号环境':'添加账号环境';
  form.querySelector('[type=submit]').textContent=env?'保存环境配置':'创建环境';
  let note=$('#environment-edit-note');
  if(!note){note=document.createElement('p');note.id='environment-edit-note';note.className='muted';form.querySelector('.form-error').before(note);}
  note.textContent=env?'保存会关闭此环境的运行窗口，登录资料与成员授权保留。':'';
  if(env){form.elements.name.value=env.name;form.elements.startUrl.value=env.startUrl;form.elements.allowedOrigins.value=env.allowedOrigins.join('\n');form.elements.maxSessions.value=env.maxSessions;}
  form.elements.mode.value=env?.kind||'server'; form.elements.mode.disabled=!!env;
  updateCreationMode();
  $('#environment-dialog .form-error').textContent=''; $('#environment-dialog').showModal();
}
$('#add-environment').onclick=()=>showEnvironment();
function updateCreationMode() {
  const mode=$('#environment-form').elements.mode.value;
  $('#import-fields').hidden=mode!=='import'; $('#local-agent-help').hidden=mode!=='local';
  $('#storage-file').required=mode==='import'; $('#import-confirm').required=mode==='import';
  $('#storage-preview').textContent='';
}
$('#environment-form').elements.mode.onchange=updateCreationMode;
$('#storage-file').onchange=async event=>{
  const file=event.target.files[0]; $('#import-confirm').checked=false;
  try {
    if(!file) return;
    if(file.size>2*1024*1024) throw new Error('JSON 文件不能超过 2 MiB。');
    const value=JSON.parse(await file.text());
    if(!Array.isArray(value.cookies)||!Array.isArray(value.origins)) throw new Error('请选择 Playwright storageState JSON 文件。');
    $('#storage-preview').textContent=`${value.cookies.length} 个 Cookie；存储来源：${value.origins.map(item=>item.origin).join('、')||'无'}。内容将存入新建的服务器环境。`;
  } catch(error) {event.target.value='';$('#storage-preview').textContent=error.message;}
};
$('#add-member').onclick=()=>{ $('#member-environments').innerHTML=environmentCheckboxes(); $('#member-dialog .form-error').textContent=''; $('#member-dialog').showModal(); };
document.querySelectorAll('.dialog-close').forEach(button=>button.onclick=()=>button.closest('dialog').close());
$('#environment-form').elements.startUrl.addEventListener('change',event=>{
  if(!$('#environment-form').elements.allowedOrigins.value) {
    try { $('#environment-form').elements.allowedOrigins.value=new URL(event.target.value).origin; } catch { /* HTML form validation displays invalid URLs. */ }
  }
});
for(const name of ['environment','member']) $(`#${name}-form`).onsubmit=async event=>{
  event.preventDefault(); const form=event.target, button=form.querySelector('[type=submit]'), input=Object.fromEntries(new FormData(form));
  button.disabled=true; form.querySelector('.form-error').textContent='';
  try {
    if(name==='environment') {input.maxSessions=Number(input.maxSessions);input.allowedOrigins=input.allowedOrigins.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}
    else input.environmentIds=[...$('#member-environments').querySelectorAll('input:checked')].map(el=>el.value);
    const editId=name==='environment'?form.dataset.environmentId:'';
    if(editId && environments.find(env=>env.id===editId)?.sessions && !confirm('保存配置将关闭此环境的全部运行窗口，继续保存？')) return;
    if(name==='environment') {
      const environment={name:input.name,startUrl:input.startUrl,allowedOrigins:input.allowedOrigins,maxSessions:input.maxSessions};
      const mode=form.elements.mode.value;
      if(!editId && mode==='import') {
        const file=$('#storage-file').files[0];
        if(!file || file.size>2*1024*1024 || !$('#import-confirm').checked) throw new Error('请选择不超过 2 MiB 的 JSON 并确认共享范围。');
        await api('/environments/import',{method:'POST',body:JSON.stringify({environment,storageState:JSON.parse(await file.text()),confirmSharedIdentity:true})});
      } else await api(`/environments${editId?'/'+editId:''}`,{method:editId?'PUT':'POST',body:JSON.stringify({...environment,kind:mode})});
    } else await api('/admin/users',{method:'POST',body:JSON.stringify(input)});
    form.closest('dialog').close();form.reset();await refresh();toast(name==='environment'?(editId?'环境配置已保存':'账号环境已创建'):'成员已创建');
  }catch(error){form.querySelector('.form-error').textContent=error.message;}finally{button.disabled=false;}
};
function connectionStatus(message, online) {
  const connection=getConnection();
  $('#connection-target').textContent=connection.backend || '尚未设置服务地址';
  $('#connection-state').textContent=message;
  $('#workspace-service-status span').textContent=online?'服务已连接':'连接待检查';
  $('#workspace-service-status').classList.toggle('offline',!online);
  $('#workspace-service-status').title=connection.backend?`${connection.backend} · ${message}`:message;
  $('#workspace-backend-button').title=connection.backend || '设置服务地址';
}
function enableLogin(enabled) { $('#login-form').querySelectorAll('input,button').forEach(el=>el.disabled=!enabled); }
function showBackendSettings() {
  const connection=getConnection();
  $('#backend-address').value=connection.backend || '';
  $('#backend-address').readOnly=connection.requireBackend===false;
  $('#backend-error').textContent='';
  $('#backend-status').textContent=connection.requireBackend===false?'当前工作台由此服务提供。连接其他服务请使用 Pages 工作台。':'';
  $('#backend-dialog').showModal();
}
$('#backend-config-button').onclick=showBackendSettings;
$('#workspace-backend-button').onclick=showBackendSettings;
$('#backend-dialog').addEventListener('close',()=>{
  if(backendOperation?.phase==='checking') backendOperation.controller.abort();
});
$('#backend-dialog').addEventListener('cancel',event=>{
  // Once logout starts, closing the dialog cannot undo the server-side change.
  if(backendOperation?.phase==='saving') event.preventDefault();
});
$('#backend-form').onsubmit=async event=>{
  event.preventDefault(); if(backendOperation) return;
  const operation={controller:new AbortController(),phase:'checking'};
  backendOperation=operation;
  $('#backend-save').disabled=true; $('#backend-reset').disabled=true; $('#backend-address').disabled=true;
  $('#backend-error').textContent=''; $('#backend-status').textContent='正在检查服务连接…';
  try {
    const value=$('#backend-address').value;
    const health=await checkBackend(value,{signal:operation.controller.signal});
    if(operation.controller.signal.aborted || !$('#backend-dialog').open) return;
    operation.phase='saving'; $('#backend-dialog .dialog-close').disabled=true;
    $('#backend-status').textContent='正在保存连接设置…';
    const changed=new URL(value.trim()).origin!==getConnection().backend;
    if(changed && user) await logout();
    await saveBackend(value);
    if(changed) showLogin();
    enableLogin(true); connectionStatus(`服务已连接 · v${health.version}`,true);
    $('#backend-dialog').close(); $('#login-error').textContent='';
  } catch(error) {
    if(operation.controller.signal.aborted || !$('#backend-dialog').open) return;
    $('#backend-error').textContent=error.message; $('#backend-status').textContent='连接设置未保存';
  } finally {
    backendOperation=undefined;
    $('#backend-save').disabled=false; $('#backend-reset').disabled=false; $('#backend-address').disabled=false;
    $('#backend-dialog .dialog-close').disabled=false;
  }
};
$('#backend-reset').onclick=async()=>{
  try { if(user) await logout(); resetConnection(); location.reload(); }
  catch(error) { $('#backend-error').textContent=error.message; }
};
try {
  const connection=await initConnection();
  if(!connection.backend) connectionStatus('请设置管理员提供的 RelayHub 服务地址。',false);
  else {
    const health=await checkBackend(connection.backend);
    enableLogin(true); connectionStatus(`服务已连接 · v${health.version}`,true);
    if(connection.authMode==='cookie' || connection.hasToken) {
      try { const {user:current}=await api('/me'); await showWorkspace(current); }
      catch(error) { showLogin(); if(error.status!==401) throw error; }
    }
  }
} catch(error) { showLogin(); connectionStatus(error.message,false); $('#login-error').textContent=error.message; }
finally { $('#backend-config-button').disabled=false; }
