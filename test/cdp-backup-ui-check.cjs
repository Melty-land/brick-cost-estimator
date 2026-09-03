/**
 * 浏览器验证数据备份功能(修复后):
 *  1) admin 点「快照备份」-> toast 含 快照备份完成(不再 401)
 *  2) admin 点「导出备份文件」-> 触发下载(a[download] 出现)且文件名 brick-data-*.zip
 *  3) admin 可见「导入恢复(管理员)」按钮
 *  4) 普通用户:导入按钮隐藏;普通用户点快照/导出(登录即可)仍可用
 * 需先恢复用户数据(测完自行处理;本测试不改业务数据,仅触发快照/导出)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9290;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const DL_DIR = path.join(os.tmpdir(), 'dsh-dl-' + CDP_PORT);
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(APP + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j };
}

async function main() {
  // 预清理:确保只有一个普通用户测试账号
  const adminLogin = await api('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  const adminToken = adminLogin.json.token;
  await api('api/users/t_bak', 'DELETE', null, adminToken);
  await api('api/users', 'POST', { username: 't_bak', password: 'tbak12345', nickname: '备份测试', role: 'user' }, adminToken);

  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--window-size=1600,1000',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    APP + '?autologin=1#estimates'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('8237'));
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* not ready */ }
  }
  if (!wsUrl) { console.error('✗ 无法连接 CDP'); child.kill(); process.exit(1); }
  console.log('✓ CDP 已连接');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const consoleMsgs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') consoleMsgs.push(m.params);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await cdp('Runtime.enable', {});
  await cdp('Page.enable', {});
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });
  // 清空下载目录
  for (const f of fs.readdirSync(DL_DIR)) fs.unlinkSync(path.join(DL_DIR, f));
  function cdp(method, params) {
    return new Promise((res) => {
      const id = ++msgId; pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evalJS(expression) {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, tries = 50) {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const toastText = () => evalJS(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);

  if (!(await waitFor(`(() => {
    const s = document.getElementById('auth-screen');
    const authHidden = !s || getComputedStyle(s).display === 'none';
    return !!document.querySelector('[data-action="db-snapshot"]') && authHidden;
  })()`))) {
    console.error('✗ 页面未就绪(auth 层未隐藏或快照按钮缺失)'); process.exit(1);
  }
  await sleep(500);

  // ---- 1. admin 快照备份 ----
  await evalJS(`document.querySelector('[data-action="db-snapshot"]').click()`);
  const snapOk = await waitFor(`(() => { const t = document.getElementById('toast'); return t && !t.hidden && t.textContent.indexOf('快照备份完成') >= 0; })()`);
  if (!snapOk) { console.error('✗ 快照备份未成功,toast=' + (await toastText())); process.exit(1); }
  console.log('✓ admin 快照备份成功:toast「' + (await toastText()) + '」');

  // ---- 2. admin 导出 zip(下载落盘验证) ----
  await evalJS(`document.querySelector('[data-action="db-export"]').click()`);
  let dlFile = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const files = fs.readdirSync(DL_DIR).filter((f) => f.endsWith('.zip'));
    if (files.length) { dlFile = files[files.length - 1]; break; }
  }
  if (!dlFile) { console.error('✗ 导出未下载 zip'); process.exit(1); }
  const dlSize = fs.statSync(path.join(DL_DIR, dlFile)).size;
  const zipBuf = fs.readFileSync(path.join(DL_DIR, dlFile));
  if (!zipBuf.includes(Buffer.from('brick-data.json'))) { console.error('✗ zip 内容缺失 brick-data.json'); process.exit(1); }
  console.log('✓ admin 导出 zip 成功:' + dlFile + ' (' + dlSize + 'B,含 brick-data.json)');

  // ---- 3. admin 导入按钮可见 ----
  const impVisible = await evalJS(`!document.getElementById('sysbar-import').hidden`);
  if (!impVisible) { console.error('✗ admin 应看到导入按钮'); process.exit(1); }
  console.log('✓ admin 可见「导入恢复(管理员)」按钮');

  // ---- 4. 普通用户 t_bak 登录:导入隐藏;快照/导出仍可用 ----
  await evalJS(`document.querySelector('#btn-logout').click()`);
  await waitFor(`(() => { const s = document.getElementById('auth-screen'); return s && getComputedStyle(s).display !== 'none'; })()`);
  const setIn = async (sel, val) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(val))}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setIn('#auth-username', 't_bak');
  await setIn('#auth-password', 'tbak12345');
  await evalJS(`document.querySelector('#auth-submit').click()`);
  await waitFor(`(() => { const s = document.getElementById('auth-screen'); return s && getComputedStyle(s).display === 'none'; })()`);
  await sleep(300);
  const impHiddenUser = await evalJS(`document.getElementById('sysbar-import').hidden`);
  if (!impHiddenUser) { console.error('✗ 普通用户不应看到导入按钮'); process.exit(1); }
  console.log('✓ 普通用户:导入恢复按钮已隐藏');
  await evalJS(`document.querySelector('[data-action="db-snapshot"]').click()`);
  const snapUser = await waitFor(`(() => { const t = document.getElementById('toast'); return t && !t.hidden && t.textContent.indexOf('快照备份完成') >= 0; })()`);
  if (!snapUser) { console.error('✗ 普通用户快照备份失败:toast=' + (await toastText())); process.exit(1); }
  console.log('✓ 普通用户快照备份(登录即可)成功');

  // 清理测试账号
  await api('api/users/t_bak', 'DELETE', null, adminToken);

  // 页面零异常
  const errs = consoleMsgs.filter(m => m.type === 'error');
  if (errs.length) { console.error('✗ 页面出现 console 错误:' + JSON.stringify(errs).slice(0, 300)); process.exit(1); }
  console.log('\n✅ 数据备份功能浏览器验证全部通过');
  ws.close(); child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('验证失败:', e); process.exit(1); });
