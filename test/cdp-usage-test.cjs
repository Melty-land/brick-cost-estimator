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

  // ---------- 任务3:用料明细表(13 列 / 期末结存 / 负数标红) ----------
  const detailRows = await evalJS(`document.querySelectorAll('#usage-detail tbody tr').length`);
  assert(detailRows === 22, '明细表行数应为 22(e1 11 + e2 11),实得 ' + detailRows);
  const detailHeads = await evalJS(`Array.from(document.querySelectorAll('#usage-detail thead th')).map(function (t) { return t.textContent; })`);
  assert(detailHeads.length === 13, '明细表应为 13 列,实得 ' + detailHeads.length + ':' + JSON.stringify(detailHeads));
  assert(detailHeads.some(function (h) { return h.indexOf('期末结存(公斤)') >= 0; }),
    '表头缺少「期末结存(公斤)」:' + JSON.stringify(detailHeads));
  const negCount = await evalJS(`document.querySelectorAll('#usage-detail td.neg').length`);
  assert(negCount >= 1, '应存在负数结存单元格(td.neg),实得 ' + negCount);
  const row0 = await evalJS(`(() => {
    const tr = document.querySelector('#usage-detail tbody tr');
    if (!tr) return null;
    return {
      tds: Array.from(tr.querySelectorAll('td')).map(function (td) { return td.textContent; }),
      sh: tr.dataset.sh, si: tr.dataset.si, usage: tr.dataset.usage
    };
  })()`);
  assert(row0, '未取到明细首行');
  const cQty = num(row0.tds[6]), cPots = num(row0.tds[7]), cUsage = num(row0.tds[8]), cClosing = num(row0.tds[12]);
  assert(Math.abs(cUsage - cQty * cPots) < 0.01,
    '第 9 列(本期用料)应为第 7 列×第 8 列:' + cUsage + ' vs ' + cQty + '×' + cPots);
  assert(Math.abs(cClosing - (num(row0.sh) + num(row0.si) - num(row0.usage))) < 0.01,
    '第 13 列(期末结存)应为 上存+进料−用料:' + cClosing + ' vs ' + row0.sh + '+' + row0.si + '−' + row0.usage);
  const sumText = await evalJS(`(document.querySelector('#usage-filter') || {}).textContent || ''`);
  assert(sumText.indexOf('张预算表') >= 0 && sumText.indexOf('行明细') >= 0,
    '小计应含「张预算表」与「行明细」:' + sumText);
  console.log('✓ 用料明细表:22 行 / 13 列 / 期末结存 / 负数标红 / 小计');

  assert(errs.length === 0, '存在 console 错误: ' + errs.join(' | '));
  console.log('✓ 无 console 错误');
  console.log('\n✅ 用料明细页测试通过(任务2-3)');
  ws.close(); child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
