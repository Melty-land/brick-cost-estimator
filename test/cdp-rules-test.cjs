/**
 * CDP 规则测试(第 3/4/5 轮反馈):必填高亮、未填完只能存草稿、退出三选弹窗、相邻批次衔接校验。
 * 运行:node test/cdp-rules-test.cjs(结束后请运行 seed-demo 复位数据)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9238;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '#new-estimate'
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
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const cellText = (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); return el ? el.textContent : null; })()`);
  const cellHasNeed = (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); return !!(el && el.classList.contains('need')); })()`);
  const setFx = async (addr, text) => {
    await evalJS(`(() => {
      const el = document.querySelector('td[data-addr="${addr}"]');
      if (!el) return;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await evalJS(`(() => {
      const el = document.getElementById('fx-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(text))});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(150);
  };
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);

  // 空估算单:必填高亮
  if (!(await waitFor(`!document.getElementById('view-editor').hidden && !!document.querySelector('td[data-addr="B2"]')`))) {
    console.error('✗ 空白估算单未打开'); process.exit(1);
  }
  const needCount0 = await evalJS(`document.querySelectorAll('td.need').length`);
  const warnBar0 = await evalJS(`document.getElementById('editor-required-bar').className.includes('warn')`);
  if (needCount0 < 5 || !warnBar0) { console.error('✗ 必填高亮缺失: need=' + needCount0); process.exit(1); }
  console.log('✓ 空白单:必填格黄底高亮(' + needCount0 + ' 个)且提示条为警示状态');

  // 填入 0(单价/用量确实为 0 的场景)应视为"已填写",高亮取消
  await setFx('B7', '0'); // 底料锅数填 0
  if (await cellHasNeed('B7')) { console.error('✗ 填入 0 仍被判为未填写'); process.exit(1); }
  await setFx('B7', '');
  if (!(await cellHasNeed('B7'))) { console.error('✗ 清空后应恢复高亮'); process.exit(1); }
  console.log('✓ 必填校验:0 视为已填写;清空恢复高亮');

  // 填写部分必填(名称 L2 编制人, C? 直接填 author/name),高亮取消
  await setFx('B2', '规则测试砖');
  await setFx('L2', '王五');
  if (await cellHasNeed('B2') || await cellHasNeed('L2')) { console.error('✗ 填入后高亮未取消'); process.exit(1); }
  console.log('✓ 填入后高亮取消(B2 名称 / L2 编制人)');

  // 保存为可用表格 -> 被拦截(仍有必填缺失),停留在编辑器
  await click('[data-action="editor-save"]');
  await sleep(400);
  const stillEditor = await evalJS(`!document.getElementById('view-editor').hidden`);
  if (!stillEditor) { console.error('✗ 未填完却保存成功(应被拦截)'); process.exit(1); }
  console.log('✓ 未填完必填 → 保存为可用表格被拦截,仍在编辑器');

  // 存为草稿 -> 列表出现草稿标记
  await click('[data-action="editor-save-draft"]');
  await waitFor(`!document.getElementById('view-estimates').hidden`);
  const draftRow = await evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('#view-estimates tbody tr'));
    const r = rows.find(tr => tr.textContent.includes('规则测试砖'));
    return r ? r.textContent.includes('草稿') : false;
  })()`);
  if (!draftRow) { console.error('✗ 草稿保存/标记失败'); process.exit(1); }
  console.log('✓ 草稿已保存并带"草稿"标记');

  // ---- 相邻批次校验:把 e1(同编号 BZ-240)的结束日期改到 e2 开始之后 ----
  await evalJS(`location.hash = '#estimate/e1'`);
  await waitFor(`!document.getElementById('view-editor').hidden && !!document.querySelector('td[data-addr="I2"]')`);
  await setFx('I2', '2026-10-15'); // e1 结束 10-15 晚于 e2 开始 10-01
  await click('[data-action="editor-save-draft"]');
  await sleep(500);
  const confirmShown = await evalJS(`!document.getElementById('confirm-modal').hidden`);
  if (!confirmShown) { console.error('✗ 相邻衔接未触发确认'); process.exit(1); }
  const confirmMsg = await evalJS(`document.getElementById('confirm-msg').textContent`);
  if (!confirmMsg.includes('日期')) { console.error('✗ 提醒内容异常: ' + confirmMsg); process.exit(1); }
  console.log('✓ 相邻批次校验触发确认(内容含日期冲突:' + confirmMsg.split('\n')[0] + ')');
  await click('#confirm-ok'); // 仍要保存
  await waitFor(`!document.getElementById('view-estimates').hidden`);
  console.log('✓ 确认后草稿已保存');

  // 再次修改 e1 -> 取消保存(应留在编辑器)
  await evalJS(`location.hash = '#estimate/e1'`);
  await waitFor(`!document.getElementById('view-editor').hidden`);
  await setFx('I2', '2026-10-31'); // 与 e2 开始重叠
  await click('[data-action="editor-save-draft"]');
  await sleep(500);
  const confirmShown2 = await evalJS(`!document.getElementById('confirm-modal').hidden`);
  if (!confirmShown2) { console.error('✗ 二次校验未触发'); process.exit(1); }
  await click('#confirm-cancel');
  await sleep(300);
  const backInEditor = await evalJS(`!document.getElementById('view-editor').hidden`);
  if (!backInEditor) { console.error('✗ 取消后应留在编辑器'); process.exit(1); }
  console.log('✓ 取消确认后未保存,留在编辑器');

  // 退出弹窗三选:dirty 状态点返回 -> 弹窗,选"不保存"
  await click('[data-action="editor-back"]');
  await sleep(300);
  const exitShown = await evalJS(`!document.getElementById('exit-modal').hidden`);
  if (!exitShown) { console.error('✗ 退出三选弹窗未出现'); process.exit(1); }
  await evalJS(`document.querySelector('[data-exit-choice="discard"]').click()`);
  await waitFor(`!document.getElementById('view-estimates').hidden`);
  console.log('✓ 退出三选弹窗:选"不保存"已返回列表');

  console.log('\n✅ 全部规则流程测试通过(页面异常:' + (pageErrors.length ? pageErrors : '无') + ')');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
