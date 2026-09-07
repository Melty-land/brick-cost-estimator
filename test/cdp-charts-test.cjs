/**
 * CDP 图表页测试(2026-09 改版:跨批次 + 全局口径 + 四图):
 * 1) 四图齐全:材料成本构成(环形,跨批合计 538.76万)、批次成本对比(单柱)、
 *    每平方成本(折线)、材料库存(横向条);点击柱/折线点可跳批次
 * 2) 全局口径切换:金额 → 用量(公斤)(环形中心合计变化、横条单位变化)
 * 3) 日期筛选改变环形合计;清除恢复
 * 4) 柱状图/折线点点击 → 跳转估算单编辑器
 * 运行:node test/cdp-charts-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9235;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '?autologin=1#charts'
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
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await cdp('Runtime.enable', {});
  function cdp(method, params) {
    return new Promise((res) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evalJS(expression) {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails.text));
    return r.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, tries = 50) {
    for (let i = 0; i < tries; i++) {
      await sleep(300);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  function assert(cond, msg) { if (!cond) { console.error('✗ ' + msg); process.exit(1); } }

  if (!(await waitFor(`!!document.querySelector('.donut-total')`))) { console.error('✗ 图表页未渲染'); process.exit(1); }
  console.log('✓ 图表页已打开');

  // ---- 1. 四图元素(金额口径)----
  const counts = await evalJS(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return JSON.stringify({
      donutSegs: q('.donut-seg'),
      legendItems: q('.chart-legend-item'),
      bars: q('.bar'),                 // 单柱:2 批 = 2 根
      polylines: q('polyline'),        // 每平方折线:单序列 1 条
      dots: q('.dot'),
      hbars: q('.hbar'),               // 库存横条
      donutTotal: (document.querySelector('.donut-total') || {}).textContent
    });
  })()`);
  console.log('图表元素:', counts);
  const c1 = JSON.parse(counts);
  assert(c1.donutSegs >= 5 && c1.legendItems >= 5, '环形图元素不足');
  assert(c1.bars === 2, '单柱应 2 根(每批一条),实得 ' + c1.bars);
  assert(c1.polylines === 1 && c1.dots >= 2, '每平方折线应 1 条 ≥2 点');
  assert(c1.hbars >= 5, '库存横条不足(应 ≥5)');
  assert(c1.donutTotal === '538.76万', '环形合计异常: ' + c1.donutTotal);
  console.log('✓ 四图齐全:环形 11 段(合计 538.76万)、单柱 2、每平方折线、库存条');

  // ---- 2. 全局口径切换 → 用量(公斤)----
  await evalJS(`document.querySelector('[data-mode="kg"]').click()`);
  await sleep(400);
  const kgTotal = await evalJS(`(document.querySelector('.donut-total') || {}).textContent`);
  const hbarKg = await evalJS(`(document.querySelector('.h-val') || {}).textContent`);
  console.log('kg 口径环形合计:', kgTotal, '| 库存条首值:', hbarKg);
  assert(hbarKg.includes('公斤'), '切 kg 后横条应显示公斤,实得 ' + hbarKg);
  await evalJS(`document.querySelector('[data-mode="amount"]').click()`);
  await sleep(300);
  console.log('✓ 全局口径切换金额/公斤生效');

  // ---- 3. 日期筛选改变环形合计;清除恢复 ----
  await evalJS(`(() => {
    const f = document.getElementById('ovl-from');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(f, '2026-10-01');
    f.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  let dt = await evalJS(`document.querySelector('.donut-total').textContent`);
  assert(dt === '295.96万', '筛选(≥2026-10-01)后应为 295.96万: ' + dt);
  console.log('✓ 日期筛选:环形 538.76万 → 295.96万');
  await evalJS(`(() => { const b = document.querySelector('[data-action="ovl-clear"]'); if (b) b.click(); })()`);
  await sleep(400);
  dt = await evalJS(`document.querySelector('.donut-total').textContent`);
  assert(dt === '538.76万', '清除后应恢复 538.76万: ' + dt);
  console.log('✓ 清除筛选恢复全部');

  // ---- 4. 点击柱(对比图)→ 跳批次;点击折线点 → 跳批次 ----
  await evalJS(`document.querySelector('.bar').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(500);
  const ac1 = await evalJS(`JSON.stringify({ hash: location.hash, editorOpen: !document.getElementById('view-editor').hidden })`);
  const a1 = JSON.parse(ac1);
  assert(a1.hash.startsWith('#estimate/') && a1.editorOpen, '点击柱未跳转: ' + ac1);
  console.log('✓ 对比柱点击跳转 ' + a1.hash);
  await evalJS(`location.hash = '#charts'`);
  await waitFor(`!document.getElementById('view-charts').hidden`);
  await sleep(300);
  await evalJS(`document.querySelector('.dot').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(500);
  const ac2 = await evalJS(`JSON.stringify({ hash: location.hash, editorOpen: !document.getElementById('view-editor').hidden })`);
  const a2 = JSON.parse(ac2);
  assert(a2.hash.startsWith('#estimate/') && a2.editorOpen, '点击折线点未跳转: ' + ac2);
  console.log('✓ 每平方折线点点击跳转 ' + a2.hash);

  console.log('\n✅ 全部图表测试通过(页面异常:' + (pageErrors.length ? pageErrors : '无') + ')');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
