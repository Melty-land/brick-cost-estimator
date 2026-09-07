/**
 * CDP 图表页测试(2026-09 改版:跨批次环形 + 共用筛选):
 * 1) 四图齐全;环形图为跨批次合计(538.76万 = 2,428,000+2,959,600)
 * 2) 日期筛选改变环形合计;清除筛选恢复
 * 3) 材料汇总切换 按用量(公斤)
 * 4) 点击柱状图柱子 → 跳转估算单编辑器
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

  // 等待图表页渲染(跨批次环形中心合计出现)
  if (!(await waitFor(`!!document.querySelector('.donut-total')`))) { console.error('✗ 图表页未渲染'); process.exit(1); }
  console.log('✓ 图表页已打开');

  // ---- 1. 四种图表元素数量 + 跨批次环形合计 ----
  const counts = await evalJS(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return JSON.stringify({
      donutSegs: q('.donut-seg'),
      legendItems: q('.chart-legend-item'),
      bars: q('.bar'),
      polylines: q('polyline'),
      hbars: q('.hbar'),
      donutTotal: (document.querySelector('.donut-total') || {}).textContent
    });
  })()`);
  console.log('图表元素:', counts);
  const c1 = JSON.parse(counts);
  if (c1.donutSegs < 5 || c1.legendItems < 5 || c1.bars < 2 || c1.polylines < 2 || c1.hbars < 5) {
    console.error('✗ 图表元素数量异常'); process.exit(1);
  }
  // 跨批次合计 = e1(2,428,000) + e2(2,959,600) = 5,387,600 → 538.76万
  if (c1.donutTotal !== '538.76万') { console.error('✗ 环形图中心合计异常: ' + c1.donutTotal); process.exit(1); }
  console.log('✓ 四图齐全;环形图为跨批次合计(538.76万 = 两批成本①之和)');

  // ---- 2. 日期筛选 → 环形合计变化;清除恢复 ----
  await evalJS(`(() => {
    const f = document.getElementById('ovl-from');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(f, '2026-10-01');
    f.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  let dt = await evalJS(`document.querySelector('.donut-total').textContent`);
  if (dt !== '295.96万') { console.error('✗ 筛选(≥2026-10-01)后环形合计应为 295.96万: ' + dt); process.exit(1); }
  console.log('✓ 日期筛选:环形合计 538.76万 → 295.96万(仅 2026-10 批次)');
  await evalJS(`(() => { const b = document.querySelector('[data-action="ovl-clear"]'); if (b) b.click(); })()`);
  await sleep(400);
  dt = await evalJS(`document.querySelector('.donut-total').textContent`);
  if (dt !== '538.76万') { console.error('✗ 清除筛选后应恢复 538.76万: ' + dt); process.exit(1); }
  console.log('✓ 清除筛选恢复全部批次');

  // ---- 3. 材料汇总切换 按用量(公斤) ----
  await evalJS(`document.querySelector('[data-mode="kg"]').click()`);
  await sleep(300);
  const hbarVal = await evalJS(`document.querySelector('.h-val').textContent`);
  if (!hbarVal.includes('公斤')) { console.error('✗ 切换按用量失败: ' + hbarVal); process.exit(1); }
  const segActive = await evalJS(`document.querySelector('#chart-mat-mode .seg-btn.active').textContent`);
  if (segActive !== '按用量(公斤)') { console.error('✗ 切换按钮状态异常'); process.exit(1); }
  console.log('✓ 汇总模式切换:按用量(公斤)生效,首行值含公斤单位');

  // ---- 4. 点击柱状图柱子 -> 跳转估算单编辑器 ----
  await evalJS(`document.querySelector('.bar').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(500);
  const afterClick = await evalJS(`JSON.stringify({ hash: location.hash, editorOpen: !document.getElementById('view-editor').hidden })`);
  const ac = JSON.parse(afterClick);
  if (!ac.hash.startsWith('#estimate/') || !ac.editorOpen) {
    console.error('✗ 点击柱子未跳转: ' + afterClick); process.exit(1);
  }
  console.log('✓ 柱子点击联动:跳转到 ' + ac.hash + ' 的估算单编辑器');

  console.log('\n✅ 全部图表测试通过(页面异常:' + (pageErrors.length ? pageErrors : '无') + ')');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
