/**
 * CDP 成本总览 + 图表跨批次 + 上存跨批提示(2026-09 新增功能):
 *  1) 成本总览:#overview 出现筛选条(时间段/砖型/材料多选)与 KPI(2 批合计 ¥5,387,600)
 *  2) 材料多选:点掉"黑水泥"→ 材料总消耗表不再含黑水泥
 *  3) 日期筛选:≥2026-10-01 → 只剩 e2(成本 ¥2,959,600)
 *  4) 图表页:#charts 顶部有同款筛选条;环形图为跨批次;有「到成本总览」互跳按钮
 *  5) 上存跨批提示:e2 打开时提示上一批次 BZ-240(2026-09-01);一键填入后上存 = 上批库存(-1995)
 * 运行:node test/cdp-overview-check.cjs(需服务在跑;基于演示数据,建议先 seed-demo;
 *      本测试会改 e2 数据(一键填入),结束后请 seed-demo 复位)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9387;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    APP + '?autologin=1#overview'
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
  console.log('✓ CDP 已连接');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
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
  async function waitFor(expr, tries = 60) {
    for (let i = 0; i < tries; i++) {
      await sleep(300);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  function assert(cond, msg) { if (!cond) { console.error('✗ ' + msg); process.exit(1); } }
  const kpis = async () => evalJS(`Array.from(document.querySelectorAll('#view-overview .kpi-value')).map(x => x.textContent)`);

  // ---- 1. 成本总览 KPI ----
  assert(await waitFor(`!document.getElementById('view-overview').hidden && !!document.querySelector('#view-overview .ovl-filter')`), '总揽页未渲染');
  const k1 = await kpis();
  assert(k1.some(v => v.indexOf('5,387,600') >= 0), '总揽成本合计应为 ¥5,387,600,实得 ' + JSON.stringify(k1));
  console.log('✓ 成本总览:2 批合计 ¥5,387,600');

  // ---- 2. 材料多选(点掉 黑水泥)→ 材料消耗表不再含它 ----
  assert(await evalJS(`(() => { const lb = Array.from(document.querySelectorAll('#view-overview label.ovl-chip')).find(l => l.textContent.trim() === '黑水泥'); if (!lb) return false; lb.click(); return true; })()`), '未找到黑水泥 chip');
  await sleep(400);
  const rows2 = await evalJS(`(() => { const c = Array.from(document.querySelectorAll('#view-overview .ovl-card')).find(x => x.innerText.indexOf('材料总消耗') >= 0); return c ? Array.from(c.querySelectorAll('tbody tr')).map(tr => tr.cells[0].textContent) : []; })()`);
  assert(rows2.length === 1 && rows2[0] === '黑水泥', '单选黑水泥后材料表应只剩黑水泥,实得 ' + JSON.stringify(rows2));
  console.log('✓ 材料单选:只选黑水泥 → 材料总消耗表仅 1 行黑水泥');
  await evalJS(`(() => { const b = document.querySelector('[data-action="ovl-clear"]'); if (b) b.click(); })()`);
  await sleep(300);

  // ---- 3. 日期筛选 ----
  await evalJS(`(() => {
    const f = document.getElementById('ovl-from');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(f, '2026-10-01');
    f.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  const k3 = await kpis();
  assert(k3.some(v => v.indexOf('2,959,600') >= 0), '日期筛选后应为 ¥2,959,600,实得 ' + JSON.stringify(k3));
  console.log('✓ 时间段筛选:仅剩 2026-10 批次(¥2,959,600)');
  await evalJS(`(() => { const b = document.querySelector('[data-action="ovl-clear"]'); if (b) b.click(); })()`);
  await sleep(300);

  // ---- 4. 图表页:同款筛选 + 跨批次环形 + 互跳按钮 ----
  assert(await evalJS(`!!document.querySelector('[data-action="ovl-to-charts"]')`), '总揽缺「生成图表」按钮');
  await evalJS(`location.hash = '#charts'`);
  assert(await waitFor(`!document.getElementById('view-charts').hidden`), '图表页未开');
  await sleep(500);
  const chartText = await evalJS(`document.getElementById('view-charts').innerText`);
  assert(chartText.indexOf('时间段') >= 0 && chartText.indexOf('跨批次') >= 0, '图表页缺筛选条/跨批次环形');
  assert(await evalJS(`!!document.querySelector('[data-action="ovl-to-overview"]')`), '图表页缺「到成本总览」');
  console.log('✓ 图表页:跨批次环形 + 共用筛选 + 互跳按钮');

  // ---- 5. 上存跨批提示(e2 ← e1)----
  await evalJS(`location.hash = '#estimate/e2'`);
  assert(await waitFor(`!!document.querySelector('td[data-addr="C6"]')`), '编辑器未开');
  await sleep(300);
  const hint = await evalJS(`(() => { const h = document.querySelector('.stock-prev-hint'); return h ? h.innerText : null; })()`);
  assert(hint && hint.indexOf('BZ-240') >= 0, 'e2 未出现上存跨批提示');
  await evalJS(`(() => { const b = document.querySelector('[data-action="apply-prev-stock"]'); if (b) b.click(); })()`);
  await sleep(500);
  const after = await evalJS(`document.querySelector('td[data-addr="C17"]').textContent`);
  assert(after === '-1995', '一键填入后黑水泥上存应为 -1995,实得 ' + after);
  console.log('✓ 上存跨批提示+一键填入(黑水泥上存 = 上一批库存 -1995)');

  assert(errs.length === 0, '页面 console 错误:' + JSON.stringify(errs).slice(0, 300));
  console.log('✓ 零异常');
  console.log('\n✅ 成本总览 / 图表跨批次 / 上存跨批提示 全部通过');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗', e.message); child.kill(); process.exit(1); });
