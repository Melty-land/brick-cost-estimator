/**
 * 用料明细页 CDP 测试(阶段一)
 *  任务2:页签顺序、#usage 路由与视图骨架
 *  任务3:用料明细表(13 列/期末结存/负数标红/空提示)
 *  任务4:剩余材料表(8 列/累计与最新结存/无 NaN)
 *  任务5:筛选条(时间段/产品/材料)与两表导出
 * 运行:node test/seed-demo.cjs && node test/cdp-usage-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9408;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--window-size=1600,900',
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(JSON.stringify(m.params).slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text).slice(0, 200));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cdp = (method, params) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await cdp('Runtime.enable', {});
  const evalJS = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result ? r.result.result.value : undefined;
  };
  const waitFor = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { await sleep(300); if (await evalJS(expr)) return true; } return false; };
  const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1); } };
  const num = (v) => { const n = Number(String(v).replace(/[¥,]/g, '')); return isFinite(n) ? n : NaN; };

  // ---------- 任务2:页签与路由 ----------
  assert(await waitFor(`!document.getElementById('view-estimates').hidden`), '估算单列表未就绪');
  const tabs = await evalJS(`Array.from(document.querySelectorAll('.tab')).map(function (t) { return t.dataset.view; })`);
  const iOverview = tabs.indexOf('overview'), iUsage = tabs.indexOf('usage');
  assert(iUsage >= 0, '未找到「用料明细」页签(data-view="usage"),实得 ' + JSON.stringify(tabs));
  assert(iUsage === iOverview + 1, '「用料明细」应紧跟「成本总览」之后,实得 ' + JSON.stringify(tabs));
  console.log('✓ 页签顺序:用料明细紧跟成本总览(' + tabs.join('|') + ')');

  await evalJS(`location.hash = '#usage'`);
  assert(await waitFor(`!document.getElementById('view-usage').hidden`), '#usage 未打开用料明细视图');
  assert(await evalJS(`!!document.querySelector('#view-usage #usage-detail')`), '缺少 #usage-detail 容器');
  assert(await evalJS(`!!document.querySelector('#view-usage #usage-stock')`), '缺少 #usage-stock 容器');
  console.log('✓ #usage 路由与视图骨架就绪(#usage-detail / #usage-stock)');

  assert(errs.length === 0, '存在 console 错误: ' + errs.join(' | '));
  console.log('✓ 无 console 错误');
  console.log('\n✅ 用料明细页测试通过(任务2)');
  ws.close(); child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
