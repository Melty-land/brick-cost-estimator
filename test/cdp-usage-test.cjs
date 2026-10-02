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
  const login = await (await fetch(APP + 'api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  })).json();
  const TOKEN = login.token;

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

  // ---------- 任务4:剩余材料表(8 列 / 累计与最新批次结存) ----------
  const stockRows = await evalJS(`document.querySelectorAll('#usage-stock tbody tr').length`);
  assert(stockRows === 11, '剩余材料表行数应为 11(材料种数),实得 ' + stockRows);
  const stockHeads = await evalJS(`Array.from(document.querySelectorAll('#usage-stock thead th')).map(function (t) { return t.textContent; })`);
  assert(stockHeads.length === 8, '剩余材料表应为 8 列,实得 ' + stockHeads.length + ':' + JSON.stringify(stockHeads));
  assert(stockHeads.some(function (h) { return h.indexOf('最新批次结存') >= 0; }), '表头缺少「最新批次结存」');
  const stockNeg = await evalJS(`document.querySelectorAll('#usage-stock td.neg').length`);
  assert(stockNeg >= 1, '剩余材料表应存在负数单元格(td.neg),实得 ' + stockNeg);
  const srow0 = await evalJS(`(() => {
    const tr = document.querySelector('#usage-stock tbody tr');
    if (!tr) return null;
    return {
      tds: Array.from(tr.querySelectorAll('td')).map(function (td) { return td.textContent; }),
      sh: tr.dataset.sh, si: tr.dataset.si, usage: tr.dataset.usage
    };
  })()`);
  assert(srow0, '未取到剩余材料首行');
  const sTotal = num(srow0.tds[5]);
  assert(Math.abs(sTotal - (num(srow0.sh) + num(srow0.si) - num(srow0.usage))) < 0.01,
    '累计剩余应为 累计上存+累计进料−累计用料:' + sTotal + ' vs ' + srow0.sh + '+' + srow0.si + '−' + srow0.usage);
  const stockText = await evalJS(`document.getElementById('usage-stock').textContent`);
  assert(stockText.indexOf('NaN') < 0 && stockText.indexOf('undefined') < 0,
    '剩余材料表不得出现 NaN/undefined');
  assert(/—|\d/.test(srow0.tds[6]), '最新批次结存列应有值或显示「—」:' + srow0.tds[6]);
  console.log('✓ 剩余材料表:11 行 / 8 列 / 累计剩余 / 最新批次结存 / 负数标红');

  // ---------- 任务5:筛选条、空数据路径与导出 ----------
  const setDate = (id, val) => evalJS(`(() => {
    const el = document.getElementById('${id}');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '${val}');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const detailCount = () => evalJS(`document.querySelectorAll('#usage-detail tbody tr').length`);
  const clearUsage = async () => { await evalJS(`(() => { const b = document.querySelector('[data-action="usage-clear"]'); if (b) b.click(); })()`); await sleep(400); };

  assert(await setDate('usage-from', '2026-10-01'), '未找到 #usage-from 日期输入');
  await sleep(400);
  let r5 = await detailCount();
  assert(r5 === 11, '时间段筛选(≥2026-10-01)后明细应为 11 行(只剩 e2),实得 ' + r5);
  await clearUsage();
  r5 = await detailCount();
  assert(r5 === 22, '点「清除」后明细应回到 22 行,实得 ' + r5);
  console.log('✓ 时间段筛选与清除');

  await setDate('usage-from', '2026-01-01');
  await setDate('usage-to', '2026-01-02');
  await sleep(400);
  const emptyText = await evalJS(`document.getElementById('usage-detail').textContent + '|' + document.getElementById('usage-stock').textContent`);
  assert(emptyText.indexOf('暂无') >= 0, '空结果时两表应显示「暂无」提示:' + emptyText.slice(0, 140));
  await clearUsage();
  r5 = await detailCount();
  assert(r5 === 22, '空数据清除筛选后应恢复 22 行,实得 ' + r5);
  console.log('✓ 空数据路径显示空提示并可恢复(任务3 第6条)');

  assert(await evalJS(`(() => {
    const inp = Array.from(document.querySelectorAll('#usage-filter input[name="usage-mat"]')).filter(function (i) { return i.value === '黑水泥'; })[0];
    if (!inp) return false;
    inp.click();
    return true;
  })()`), '未找到材料 chip「黑水泥」');
  await sleep(450);
  const matNames = await evalJS(`Array.from(document.querySelectorAll('#usage-detail tbody tr')).map(function (tr) { return tr.children[4].textContent; })`);
  assert(matNames.length > 0 && matNames.every(function (n) { return n === '黑水泥'; }),
    '材料单选后明细应只含黑水泥,实得 ' + JSON.stringify(matNames.slice(0, 5)));
  const stockRows5 = await evalJS(`document.querySelectorAll('#usage-stock tbody tr').length`);
  assert(stockRows5 === 1, '材料单选后剩余材料表应为 1 行,实得 ' + stockRows5);
  const s5 = await evalJS(`(() => { const tr = document.querySelector('#usage-stock tbody tr'); return tr ? { cell: tr.children[4].textContent, usage: tr.dataset.usage } : null; })()`);
  assert(s5 && Math.abs(num(s5.cell) - num(s5.usage)) < 0.01,
    '剩余材料累计用料应与行内 data-usage 一致:' + JSON.stringify(s5));
  assert(await evalJS(`!!document.querySelector('[data-action="usage-export-detail"]') && !!document.querySelector('[data-action="usage-export-stock"]')`),
    '缺少两表导出按钮');
  await evalJS(`document.querySelector('[data-action="usage-export-detail"]').click()`);
  await sleep(300);
  console.log('✓ 材料单选(只含黑水泥 / 剩余表 1 行 / 累计用料自洽)与导出按钮');

  // ---------- 修复轮 F1:「全部」按钮应恢复不限 ----------
  await clearUsage();
  await evalJS(`(() => {
    const inp = Array.from(document.querySelectorAll('#usage-filter input[name="usage-mat"]')).filter(function (i) { return i.value === '黑水泥'; })[0];
    if (inp) inp.click();
  })()`);
  await sleep(400);
  let f1 = await detailCount();
  assert(f1 < 22, '前置:材料单选后行数应少于全量,实得 ' + f1);
  await evalJS(`(() => {
    const all = document.querySelector('#usage-filter input.ovl-all[data-group="usage-mat"]');
    if (all) { all.checked = true; all.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await sleep(450);
  f1 = await detailCount();
  const checkedMats = await evalJS(`document.querySelectorAll('#usage-filter input[name="usage-mat"]:checked').length`);
  assert(f1 === 22, '点「全部」后明细应恢复 22 行,实得 ' + f1);
  assert(checkedMats === 0, '点「全部」后子项应全部取消勾选,实得 ' + checkedMats);
  console.log('✓ F1:「全部」按钮恢复不限并同步勾选状态');

  // ---------- 修复轮 F2:导出文件名应带 .xls ----------
  await evalJS(`(() => {
    window.__expName = null;
    if (window.Exporter) {
      const orig = window.Exporter.exportXLS;
      window.Exporter.exportXLS = function (name) { window.__expName = name; return Promise.resolve(true); };
      window.__restoreExport = function () { window.Exporter.exportXLS = orig; };
    }
  })()`);
  await evalJS(`document.querySelector('[data-action="usage-export-detail"]').click()`);
  await sleep(350);
  const expName = await evalJS(`window.__expName`);
  assert(typeof expName === 'string' && /\.xls$/.test(expName),
    '导出文件名应以 .xls 结尾,实得 ' + JSON.stringify(expName));
  await evalJS(`(() => { if (window.__restoreExport) window.__restoreExport(); })()`);
  console.log('✓ F2:导出文件名带 .xls 扩展名(' + expName + ')');

  // ---------- 修复轮 F4:未匹配产品提示 ----------
  const dd = await (await fetch(APP + 'api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const target = dd.estimates[0];
  const backup = { productId: target.productId, name: target.name, code: target.code };
  target.productId = 'no-such-product';
  target.name = 'ZZ-未匹配测试';
  target.code = 'ZZ-999';
  await fetch(APP + 'api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(dd)
  });
  await evalJS(`location.reload()`);
  assert(await waitFor(`!document.getElementById('view-usage').hidden && !!document.getElementById('usage-filter')`, 80),
    '重载后用料明细页未就绪');
  await sleep(400);
  const unmatchText = await evalJS(`document.getElementById('usage-filter').textContent`);
  assert(unmatchText.indexOf('未匹配') >= 0, '存在未匹配批次时应给出提示,实得 ' + unmatchText.slice(0, 140));
  // 复原数据
  const dd2 = await (await fetch(APP + 'api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const t2 = dd2.estimates.filter(function (e) { return e.code === 'ZZ-999'; })[0];
  if (t2) { t2.productId = backup.productId; t2.name = backup.name; t2.code = backup.code; }
  await fetch(APP + 'api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(dd2)
  });
  console.log('✓ F4:未匹配产品提示已显示(数据已复原)');

  assert(errs.length === 0, '存在 console 错误: ' + errs.join(' | '));
  console.log('✓ 无 console 错误');
  console.log('\n✅ 用料明细页测试通过(任务2-5 + 修复轮)');
  ws.close(); child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
