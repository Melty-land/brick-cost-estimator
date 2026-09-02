/**
 * 验证修复:①点击表格底部单元格不再导致页面跳顶(preventScroll)
 * ②页面运行零异常 ③favicon 以内联 data URI 声明(浏览器不再请求 /favicon.ico)
 * 运行:node test/cdp-fix-check.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9237;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '#estimate/e1'
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

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
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
  await cdp('Runtime.enable', {});
  await cdp('Log.enable', {});
  async function waitFor(expr, tries = 50) {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }

  if (!(await waitFor(`!!document.querySelector('td[data-addr="B34"]') && !document.getElementById('view-editor').hidden`))) {
    console.error('✗ 编辑器未就绪'); process.exit(1);
  }
  console.log('✓ 编辑器就绪');

  // 1) favicon 内联声明
  const icon = await evalJS(`(() => {
    const l = document.querySelector('link[rel="icon"]');
    return l ? (l.href.startsWith('data:') ? 'data-uri' : l.href) : 'none';
  })()`);
  if (icon !== 'data-uri') { console.error('✗ favicon 未内联: ' + icon); process.exit(1); }
  console.log('✓ favicon 已内联为 data URI,浏览器不再请求 /favicon.ico(消除 404)');

  // 2) 滚动到底部后点击远端单元格(成本总价 B34),页面不应跳顶
  await evalJS(`window.scrollTo(0, document.body.scrollHeight);`);
  await sleep(300);
  const before = await evalJS(`window.scrollY`);
  await evalJS(`(() => {
    const el = document.querySelector('td[data-addr="B34"]');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(300);
  const after = await evalJS(`window.scrollY`);
  const fxName = await evalJS(`document.getElementById('fx-name').textContent`);
  if (fxName !== 'B34') { console.error('✗ 点击未选中 B34: ' + fxName); process.exit(1); }
  if (Math.abs(before - after) > 60) {
    console.error(`✗ 页面发生跳顶:滚动前 ${before} → 滚动后 ${after}`); process.exit(1);
  }
  console.log(`✓ 点击远端单元格不再跳顶(滚动保持: ${before} → ${after}),且正确选中 B34`);

  // 3) 连续点击多个单元格(含公式格/输入格)后无页面异常
  for (const addr of ['F6', 'K28', 'H34', 'J32', 'C17', 'E6']) {
    await evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
    await sleep(80);
  }
  await sleep(400);
  if (exceptions.length || consoleErrors.length) {
    console.error('✗ 页面出现异常/错误: ' + JSON.stringify({ exceptions, consoleErrors })); process.exit(1);
  }
  console.log('✓ 交互后页面零异常、零 console 错误');

  // 4) 弹窗可见性:页面加载后退出/确认弹窗必须隐藏(修复 [hidden] 被 display:flex 覆盖的 bug)
  const modalVisible = (id) => evalJS(`(() => { const el = document.getElementById('${id}');
    return !!(el && getComputedStyle(el).display !== 'none'); })()`);
  const exitShownOnLoad = await modalVisible('exit-modal');
  const confirmShownOnLoad = await modalVisible('confirm-modal');
  if (exitShownOnLoad || confirmShownOnLoad) {
    console.error('✗ 页面加载时弹窗应隐藏: exit=' + exitShownOnLoad + ' confirm=' + confirmShownOnLoad); process.exit(1);
  }
  console.log('✓ 页面加载时退出/确认弹窗均隐藏');

  // 制造未保存改动 -> 点返回 -> 退出弹窗出现;点"取消"应能关闭并留在编辑器
  await evalJS(`(() => {
    const el = document.querySelector('td[data-addr="C6"]');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await evalJS(`(() => {
    const el = document.getElementById('fx-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '501');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(200);
  const c5now = await evalJS(`(() => { const el = document.querySelector('td[data-addr="C6"]'); return el ? el.textContent : null; })()`);
  if (c5now !== '501') { console.error('✗ C6 编辑未生效: ' + c5now); process.exit(1); }
  await evalJS(`(() => { const b = document.querySelector('[data-action="editor-back"]'); if (b) b.click(); })()`);
  await sleep(300);
  const dbg = await evalJS(`JSON.stringify({
    hiddenAttr: document.getElementById('exit-modal').hidden,
    disp: getComputedStyle(document.getElementById('exit-modal')).display,
    editorHidden: document.getElementById('view-editor').hidden,
    hash: location.hash
  })`);
  if (!(await modalVisible('exit-modal'))) { console.error('✗ 有改动退出时应出现弹窗: ' + dbg); process.exit(1); }
  console.log('✓ 有未保存改动退出时弹窗正常出现');
  await evalJS(`document.querySelector('[data-exit-choice="cancel"]').click()`);
  await sleep(300);
  if (await modalVisible('exit-modal')) { console.error('✗ 点击"取消"后弹窗仍无法关闭'); process.exit(1); }
  const stillEditor = await evalJS(`!document.getElementById('view-editor').hidden`);
  if (!stillEditor) { console.error('✗ 取消后应留在编辑器'); process.exit(1); }
  console.log('✓ 点击"取消"弹窗可关闭且留在编辑器');
  // 再点返回选"不保存",恢复干净状态
  await evalJS(`(() => { const b = document.querySelector('[data-action="editor-back"]'); if (b) b.click(); })()`);
  await sleep(300);
  await evalJS(`document.querySelector('[data-exit-choice="discard"]').click()`);
  await waitFor(`!document.getElementById('view-estimates').hidden`);
  console.log('✓ 退出三选流程正常(不保存返回列表)');

  console.log('\n✅ 修复验证通过');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('验证失败:', e); process.exit(1); });
