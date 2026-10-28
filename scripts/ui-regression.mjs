/** Hermetic browser regressions: serves public/ with synthetic API responses only. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) { res.writeHead(500); res.end('Real APIs disabled in UI tests'); return; }
  try {
    const relative = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(publicDir)) throw Error('outside public');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp('/tmp/inspector-ui-regression-');
const portProbe = http.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const debugPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
let browser;
let failures = 0;
try {
  browser = await launch({ port: debugPort, profile: path.basename(profile), size: [1280, 900] });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__ui = { errors: [], requests: [], audits: [], holdAudit: true, holdRecover: false, appRunning: false, auditFail: false };
    addEventListener('error', e => __ui.errors.push(e.message));
    addEventListener('unhandledrejection', e => __ui.errors.push(String(e.reason)));
    const cat = { id:'cache', label:'缓存', status:'good', verdict:'safe', recommend:true, count:1, bytes:12, what:'测试', why:'测试', outcome:'测试' };
    const apps = ['zcode', 'cursor'].map(app => ({ app, label:app, targets:[{key:'root', path:'/fixture/'+app, short:'/fixture/'+app, exists:true}],
      totals:{bytes:12, files:1, dirs:1}, categories:[cat], catalog:[cat], files:[{t:'root',p:'cache/a',s:12,m:1,c:'cache'}], canRecover:app==='cursor' }));
    const task = { id:'orphan-id', title:'库内孤儿', workspace:'/fixture/ws', state:'untracked', reason:'untracked', residual:false,
      bytes:12, rows:1, children:0, updatedAt:1, createdAt:1, bodyRel:null };
    const auditResult = {apps:[{app:'zcode',label:'zcode',supported:true,sessionsScanned:1,bytesScanned:12,totals:{high:0,medium:0,info:0},hits:[],problems:[]}]};
    window.__ui.releaseAudits = () => { for (const resolve of __ui.audits.splice(0)) resolve(new Response(JSON.stringify(auditResult))); };
    const nativeFetch = fetch;
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('/api/')) return nativeFetch(url, options);
      __ui.requests.push(String(url));
      if (String(url)==='/api/tasks/cursor/recover') {
        if (__ui.holdRecover) return new Promise(resolve => { __ui.failRecover = () => resolve(new Response(JSON.stringify({error:'测试：写入被拒绝'}), {status:409})); });
        return new Response(JSON.stringify({error:'测试：写入被拒绝'}), {status:409});
      }
      if (String(url).startsWith('/api/audit') && __ui.auditFail) return new Response(JSON.stringify({error:'测试：审计失败'}), {status:500});
      if (String(url)==='/api/reveal') return new Response(JSON.stringify({error:'测试：文件已不存在'}), {status:404});
      if (String(url).startsWith('/api/audit') && __ui.holdAudit) return new Promise(resolve => __ui.audits.push(resolve));
      let data;
      if (String(url).startsWith('/api/scan')) data = {apps,grand:{bytes:24},durationMs:1,canTrash:true,canReveal:true};
      else if (String(url).startsWith('/api/audit')) data = auditResult;
      else if (String(url).startsWith('/api/tasks/all')) data = {tools:[],tasks:[],groups:[],bytes:0,total:0};
      else if (String(url).startsWith('/api/tasks/cursor/analyze')) return new Response(JSON.stringify({error:'测试：引用分析失败'}), {status:503});
      else if (String(url).startsWith('/api/tasks/cursor/orphans')) data = {sessions:[{id:'restore',title:'回灌测试',workspace:'/fixture/ws',messages:2,bubbles:2,bytes:12,date:1}],total:1,orphanBytes:12,app:{running:false},problems:[]};
      else if (String(url).startsWith('/api/tasks?')) {
        const appId = new URL(url, location.origin).searchParams.get('app');
        data = {appId,appLabel:appId,app:{running:__ui.appRunning,hits:[]},tasks:appId==='cursor'?[task]:[],history:appId+'-db',canRecover:appId==='cursor',
          totals:{count:1,bytes:12,byState:[{state:'untracked',count:1,bytes:12}]},db:{total:100,dbs:[]},problems:[]};
      } else throw Error('Unexpected API: '+url);
      return new Response(JSON.stringify(data));
    };
  ` });
  await browser.goto(`http://127.0.0.1:${server.address().port}/`, '#apptab-zcode');
  const evaluate = expression => browser.evaluate(expression);
  const screenshot = async file => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.writeFile(file, await browser.screenshot());
  };
  const wait = async expression => {
    for (let i = 0; i < 60; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Timed out: '+expression+'; '+JSON.stringify(await evaluate(`({ selected:document.querySelector('[data-app][aria-selected="true"]')?.dataset.app, disabled:document.querySelector('#rescanBtn').disabled, note:document.querySelector('#taskLede').textContent, requests:__ui.requests.slice(-8) })`)));
  };
  const check = async (name, run) => {
    try { await run(); console.log('PASS '+name); }
    catch (err) { failures++; console.error('FAIL '+name+': '+err.message); }
  };
  await check('all/audit resize has no exceptions', async () => {
    await evaluate(`document.querySelector('#apptab-all').click(); dispatchEvent(new Event('resize')); document.querySelector('#apptab-audit').click(); dispatchEvent(new Event('resize'));`);
    assert.deepEqual(await evaluate('__ui.errors'), []);
  });
  await check('leaving and reentering an in-flight audit starts a usable request', async () => {
    const before = await evaluate('__ui.requests.filter(x=>x.startsWith("/api/audit")).length');
    await evaluate(`document.querySelector('#apptab-zcode').click(); document.querySelector('#apptab-audit').click();`);
    const after = await evaluate('__ui.requests.filter(x=>x.startsWith("/api/audit")).length');
    assert.ok(after > before);
  });
  await evaluate('__ui.holdAudit=false; __ui.releaseAudits()');
  await check('rescan retains audit view and refreshes audit endpoint', async () => {
    await evaluate(`document.querySelector('#rescanBtn').click()`);
    await wait(`!document.querySelector('#rescanBtn').disabled`);
    assert.equal(await evaluate(`document.querySelector('[data-app="audit"]').getAttribute('aria-selected')`), 'true');
    assert.ok(await evaluate(`__ui.requests.includes('/api/audit?refresh=1')`));
  });
  await check('audit preference survives reload', async () => {
    await evaluate(`localStorage.setItem('zci-app','audit')`);
    await browser.send('Page.reload');
    await wait(`Boolean(document.querySelector('#apptab-audit'))`);
    assert.equal(await evaluate(`document.querySelector('#apptab-audit').getAttribute('aria-selected')`), 'true');
  });
  await check('Cursor orphan opens database cleanup drawer', async () => {
    await evaluate(`document.querySelector('#apptab-cursor').click()`);
    await wait(`Boolean(document.querySelector('[data-task-box]'))`);
    await evaluate(`document.querySelector('[data-task-box]').click(); document.querySelector('#taskPurgeBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#tdrawer').hidden`), false);
    assert.ok(await evaluate(`document.querySelector('#tdrawerStats').textContent.includes('未能估算')`));
    await evaluate(`document.querySelector('#tdrawerClose').click()`);
  });
  await check('recovery drawer traps keyboard focus', async () => {
    await wait(`Boolean(document.querySelector('[data-recover-id]'))`);
    await evaluate(`document.querySelector('[data-recover-id]').click(); document.querySelector('#recoverBtn').click(); document.querySelector('#rdryBtn').focus()`);
    // The final enabled control is the dry-run button until the confirmation is entered.
    await evaluate(`const root=document.querySelector('#rdrawer'); const enabled=[...root.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(x=>x.getClientRects().length); enabled.at(-1).focus();`);
    await browser.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
    await browser.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
    assert.equal(await evaluate(`document.querySelector('#rdrawer').contains(document.activeElement)`), true);
    await evaluate(`document.querySelector('#rdrawerClose').click()`);
  });
  await check('recovery errors remain visible after button state is restored', async () => {
    await evaluate(`if (!document.querySelector('[data-recover-id]').checked) document.querySelector('[data-recover-id]').click(); document.querySelector('#recoverBtn').click(); document.querySelector('#rdryBtn').click()`);
    await wait(`document.querySelector('#rdrawerMsg').textContent.includes('写入被拒绝')`);
    assert.equal(await evaluate(`document.querySelector('#rdryBtn').disabled`), false);
    assert.equal(await evaluate(`document.querySelector('#rdrawerMsg').classList.contains('is-err')`), true);
    await screenshot('/tmp/zcode-inspector-ui-recovery-error.png');
  });
  await check('busy recovery cannot be closed and keeps its selection', async () => {
    await evaluate(`__ui.holdRecover=true; document.querySelector('#rdryBtn').click(); document.querySelector('#rdrawerClose').click()`);
    assert.equal(await evaluate(`document.querySelector('#rdrawer').hidden`), false);
    await evaluate(`__ui.failRecover()`);
    await wait(`!document.querySelector('#rdryBtn').disabled`);
    assert.equal(await evaluate(`document.querySelector('#recoverBtn').disabled`), false);
    await evaluate(`document.querySelector('#rdrawerClose').click()`);
  });
  await evaluate(`document.querySelector('#rdrawerClose').click()`);
  await check('file reveal failures are visible without unhandled rejections', async () => {
    await evaluate(`document.querySelector('[data-group-toggle="cache"]').click(); document.querySelector('[data-reveal]').click()`);
    await wait(`document.body.textContent.includes('无法显示文件：测试：文件已不存在')`);
  });
  await check('narrow viewport and keyboard navigation remain usable', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:false });
    await evaluate(`document.querySelector('#apptab-all').click()`);
    await wait(`!document.querySelector('#allView').hidden`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    await screenshot('/tmp/zcode-inspector-ui-narrow.png');
    await evaluate(`document.querySelector('#apptab-cursor').click()`);
    await wait(`Boolean(document.querySelector('[data-task-box]'))`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    await screenshot('/tmp/zcode-inspector-ui-narrow-cursor.png');
  });
  await check('running application cannot enable deletion by typing confirmation', async () => {
    await evaluate(`__ui.appRunning=true; document.querySelector('#rescanBtn').click()`);
    await wait(`!document.querySelector('#rescanBtn').disabled && Boolean(document.querySelector('[data-task-box]'))`);
    await evaluate(`document.querySelector('[data-task-box]').click(); document.querySelector('#taskPurgeBtn').click(); document.querySelector('#tWord').value='清理'; document.querySelector('#tWord').dispatchEvent(new Event('input'))`);
    assert.equal(await evaluate(`document.querySelector('#tdrawerGo').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#tdryBtn').disabled`), false);
    await evaluate(`document.querySelector('#tdrawerClose').click(); __ui.appRunning=false`);
  });
  await check('failed audit refresh clears stale results', async () => {
    await evaluate(`__ui.holdAudit=false; document.querySelector('#apptab-audit').click(); __ui.releaseAudits()`);
    await wait(`document.querySelector('#auditTools').textContent.includes('zcode')`);
    await evaluate(`__ui.auditFail=true; document.querySelector('#rescanBtn').click()`);
    await wait(`!document.querySelector('#rescanBtn').disabled`);
    assert.ok(await evaluate(`document.querySelector('#auditLede').textContent.includes('扫描失败')`));
    assert.equal(await evaluate(`document.querySelector('#auditTools').textContent`), '');
    assert.equal(await evaluate(`document.querySelector('#auditList').textContent`), '');
    assert.equal(await evaluate(`document.querySelector('#auditEmpty').hidden`), true);
  });
  const browserErrors = await evaluate('__ui.errors');
  if (browserErrors.length) failures++;
  console.log(JSON.stringify({ checks:12, failures, browserErrors }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
if (failures) process.exitCode = 1;
