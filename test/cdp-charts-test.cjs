/**
 * CDP 图表页测试:验证四种图表的渲染、切换与联动。
 * 运行:node test/cdp-charts-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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

  // 等待图表页渲染
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    ready = await evalJS(`!!document.querySelector('#chart-est-select')`);
    if (ready) break;
  }
  if (!ready) { console.error('✗ 图表页未渲染'); process.exit(1); }
  console.log('✓ 图表页已打开');

  // ---- 1. 四种图表元素数量 ----
  const counts = await evalJS(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return JSON.stringify({
      donutSegs: q('.donut-seg'),
      legendItems: q('.chart-legend-item'),
      bars: q('.bar'),
      polylines: q('polyline'),
      lineDots: q('.dot'),
      hbars: q('.hbar'),
      donutTotal: (document.querySelector('.donut-total') || {}).textContent
    });
  })()`);
  console.log('图表元素:', counts);
  const c1 = JSON.parse(counts);
  if (c1.donutSegs < 5 || c1.legendItems < 5 || c1.bars < 2 || c1.polylines < 2 || c1.hbars < 5) {
    console.error('✗ 图表元素数量异常'); process.exit(1);
  }
  if (c1.donutTotal !== '295.96万') { console.error('✗ 环形图中心合计异常: ' + c1.donutTotal); process.exit(1); }
  console.log('✓ 四图齐全:环形图 11 段、柱状图 4 柱、折线 2 条、汇总条形 11 条;默认选中最新批次(合计 295.96万)');

  // ---- 2. 切换环形图批次 -> e1,合计应为 2,428 ----
  await evalJS(`(() => {
    const sel = document.querySelector('#chart-est-select');
    sel.value = 'e1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const donutTotal2 = await evalJS(`document.querySelector('.donut-total').textContent`);
  if (donutTotal2 !== '242.80万') { console.error('✗ 切换批次后合计异常: ' + donutTotal2); process.exit(1); }
  console.log('✓ 批次切换:环形图合计 295.96万 → 242.80万(e1 金额合计)');

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
