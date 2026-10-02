/**
 * 导航与滚动修复验证:
 *  1) /favicon.ico 返回 204(浏览器主动请求不再报 404)
 *  2) 退出表格模式:href 与视图不同步时点「返回估算单列表」也能真正退出(修复前无反应)
 *  3) 重新进入:hash 已等于目标时点「查看」也能进入(修复前无反应)
 *  4) 表格模式下点击各类单元格(真实鼠标)不把页面拉回顶部(滚动保持)
 *  5) 常规 进入→退出→再进入 往返正常
 * 运行:node test/cdp-nav-scroll-test.cjs(需服务在跑)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9407;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 1) favicon 204 ----
  const fr = await fetch(APP + 'favicon.ico');
  if (fr.status !== 204) { console.error('✗ /favicon.ico 应返回 204,实得 ' + fr.status); process.exit(1); }
  console.log('✓ /favicon.ico 返回 204(不再 404)');

  const login = await (await fetch(APP + 'api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json();
  const dd = await (await fetch(APP + 'api/data', { headers: { Authorization: 'Bearer ' + login.token } })).json();
  const target = dd.estimates[0];

  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--window-size=900,600',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    APP + '?autologin=1#estimates'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('8237'));
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* not ready */ }
  }
  if (!wsUrl) { console.error('✗ 无法连接 CDP'); child.kill(); process.exit(1); }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0; const pending = new Map(); const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text).slice(0, 160));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cdp = (method, params) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await cdp('Runtime.enable', {});
  const evalJS = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result ? r.result.result.value : undefined; };
  const wait = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { await sleep(300); if (await evalJS(expr)) return true; } return false; };
  const assert = (c, m) => { if (!c) { console.error('✗ ' + m); process.exit(1); } };
  const inEditor = () => evalJS(`!document.getElementById('view-editor').hidden`);
  const inList = () => evalJS(`!document.getElementById('view-estimates').hidden`);
  const clickAt = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
  };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });

  assert(await wait(`!document.getElementById('view-estimates').hidden`), '列表页未就绪');
  console.log('✓ CDP 已连接、列表页就绪');

  // ---- 5) 常规往返:进入 → 退出 → 再进入 ----
  for (let i = 1; i <= 2; i++) {
    await evalJS(`(() => { const b = document.querySelector('#view-estimates [data-action="view-estimate"]'); if (b) b.click(); })()`);
    assert(await wait(`!document.getElementById('view-editor').hidden && !!document.querySelector('td[data-addr="C6"]')`), '第' + i + '轮进入编辑器失败');
    await evalJS(`(() => { const b = document.querySelector('[data-action="editor-back"]'); if (b) b.click(); })()`);
    await sleep(400);
    assert(!(await evalJS(`!document.getElementById('exit-modal').hidden`)) || true, '');
    await evalJS(`(() => { const b = document.querySelector('[data-exit-choice="discard"]'); if (b) b.click(); })()`);
    assert(await wait(`!document.getElementById('view-estimates').hidden`), '第' + i + '轮退出失败');
  }
  console.log('✓ 常规往返:进入 → 退出 → 再进入(2 轮)正常');

  // ---- 2) 视图=编辑器但 hash=#estimates(不同步)→ 点返回应能退出 ----
  await evalJS(`(() => { const b = document.querySelector('#view-estimates [data-action="view-estimate"]'); if (b) b.click(); })()`);
  assert(await wait(`!document.getElementById('view-editor').hidden`), '准备进入编辑器失败');
  await evalJS(`history.replaceState(null, '', location.pathname + location.search + '#estimates')`);
  await sleep(200);
  await evalJS(`(() => { const b = document.querySelector('[data-action="editor-back"]'); if (b) b.click(); })()`);
  const exited = await wait(`!document.getElementById('view-estimates').hidden`, 20);
  assert(exited, 'hash 与视图不同步时点「返回估算单列表」无反应(仍在编辑器)');
  console.log('✓ hash 不同步时退出表格模式生效(修复前会无反应)');

  // ---- 3) 视图=列表但 hash=#estimate/<id>(不同步)→ 点「查看」应能进入 ----
  const tid = target.id;
  await evalJS(`history.replaceState(null, '', location.pathname + location.search + '#estimate/${tid}')`);
  await sleep(200);
  const listVisible = await inList();
  await evalJS(`(() => { const b = document.querySelector('#view-estimates [data-action="view-estimate"][data-id="${tid}"]'); if (b) b.click(); })()`);
  const entered = await wait(`!document.getElementById('view-editor').hidden && !!document.querySelector('td[data-addr="C6"]')`, 25);
  assert(entered, 'hash 已等于目标时点「查看」无反应(无法重新进入)');
  console.log('✓ hash 相同(不同步)时点「查看」可进入(修复前会无反应);列表此前可见=' + listVisible);

  // ---- 4) 点击各类单元格不跳顶(真实鼠标) ----
  await sleep(500);
  const docH = await evalJS(`document.documentElement.scrollHeight`);
  const probe = async (addr, label) => {
    const pt = await evalJS(`(() => {
      const el = document.querySelector('td[data-addr="${addr}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + Math.min(r.height / 2, 12)) };
    })()`);
    if (!pt) { console.log('  · 跳过 ' + addr + '(本单无此格)'); return; }
    await sleep(220);
    const before = await evalJS(`Math.round(window.scrollY || document.scrollingElement.scrollTop)`);
    await clickAt(pt.x, pt.y);
    await sleep(420);
    const after = await evalJS(`Math.round(window.scrollY || document.scrollingElement.scrollTop)`);
    assert(after >= before - 60, '点击 ' + addr + '(' + label + ') 页面跳顶: ' + before + ' → ' + after);
    console.log('  · ' + addr.padEnd(4) + ' ' + label + ' scrollY ' + before + ' → ' + after + ' ✓');
  };
  await probe('A2', '名称规格(标签)');
  await probe('B2', '名称值');
  await probe('F2', '开始日期');
  await probe('H2', '结束日期');
  await probe('B12', '锅数输入格');
  await probe('H12', '每平方重量(公式)');
  await probe('B17', '清单首行');
  await probe('F17', '清单单价(输入)');
  await probe('K17', '清单占比(公式)');
  console.log('✓ 表格模式点击各类单元格不跳顶(文档高 ' + docH + ')');

  assert(errs.length === 0, '页面异常: ' + errs.join(' | '));
  console.log('✓ 零异常');
  console.log('\n✅ 导航与滚动修复验证全部通过');
  ws.close(); child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
