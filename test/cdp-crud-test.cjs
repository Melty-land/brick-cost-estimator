/**
 * CDP CRUD 流程测试:新增材料 → 新建产品 → 基于产品新建估算单 → 保存。
 * 零依赖(Node>=22)。运行:node test/cdp-crud-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9234;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '#materials'
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
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text));
    }
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
    if (r.result && r.result.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails.text));
    }
    return r.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, tries = 40) {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const setInput = (selector, value) => evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'notfound';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  const click = (selector) => evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'notfound';
    el.click();
    return 'ok';
  })()`);

  // 覆盖 confirm,便于删除确认
  await evalJS(`window.confirm = () => true;`);

  // ---- 1. 新增材料 ----
  await waitFor(`!!document.querySelector('#new-mat-name')`);
  await setInput('#new-mat-name', '测试新材料');
  await evalJS(`(() => {
    const sel = document.querySelector('#new-mat-zone');
    sel.value = '面料';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click('[data-action="add-material"]');
  await sleep(600);
  const matExists = await evalJS(`Array.from(document.querySelectorAll('#view-materials tbody tr')).some(tr => tr.textContent.includes('测试新材料'))`);
  if (!matExists) { console.error('✗ 新增材料失败'); process.exit(1); }
  console.log('✓ 新增材料:测试新材料(面料)已出现在材料管理列表');

  // ---- 2. 新建产品 ----
  await click('.tab[data-view="products"]');
  await sleep(400);
  await click('[data-action="new-product"]');
  await sleep(300);
  await setInput('[data-path="name"]', '测试产品');
  await setInput('[data-path="code"]', 'TEST-01');
  await click('[data-action="pf-add-row"]');
  await sleep(300);
  // 选中的默认材料是第一个可用材料(黑水泥),填每锅数量
  await setInput('[data-path="recipe.0.qtyPerPot"]', 250);
  await click('[data-action="save-product"]');
  await sleep(300);
  // 保存产品带确认弹窗
  const confirmShown = await evalJS(`!document.getElementById('confirm-modal').hidden`);
  if (!confirmShown) { console.error('✗ 保存产品未弹确认'); process.exit(1); }
  await click('#confirm-ok');
  await sleep(700);
  const prodExists = await evalJS(`Array.from(document.querySelectorAll('#view-products tbody tr')).some(tr => tr.textContent.includes('测试产品'))`);
  if (!prodExists) { console.error('✗ 新建产品失败'); process.exit(1); }
  console.log('✓ 新建产品:测试产品 TEST-01(配方含黑水泥 250kg/锅)已保存');

  // ---- 3. 基于产品新建估算单 ----
  await click('.tab[data-view="estimates"]');
  await sleep(600);
  const diag = await evalJS(`(() => {
    const v = document.getElementById('view-estimates');
    const sel = document.querySelector('#new-est-prod');
    return JSON.stringify({
      viewHidden: v.hidden,
      selExists: !!sel,
      options: sel ? Array.from(sel.options).map(o => o.text + '=' + o.value) : null
    });
  })()`);
  console.log('估算单视图诊断:', diag);
  await evalJS(`(() => {
    const sel = document.querySelector('#new-est-prod');
    const target = Array.from(sel.options).find(o => o.text.includes('测试产品')) || sel.options[sel.options.length - 1];
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return target.text;
  })()`);
  await click('[data-action="new-estimate"]');
  await sleep(700);
  const editorDiag = await evalJS(`(() => {
    const v = document.getElementById('view-editor');
    const b2 = v.querySelector('td[data-addr="B2"]');
    const d5 = v.querySelector('td[data-addr="D6"]');
    return JSON.stringify({
      hash: location.hash,
      editorHidden: v.hidden,
      nameCell: b2 ? b2.textContent : null,
      qtyCell: d5 ? d5.textContent : null
    });
  })()`);
  console.log('编辑器诊断:', editorDiag, '页面异常:', pageErrors.length ? pageErrors : '无');
  const ed = JSON.parse(editorDiag);
  if (ed.editorHidden || ed.nameCell !== '测试产品' || ed.qtyCell !== '250') {
    console.error('✗ 基于产品新建估算单失败'); process.exit(1);
  }
  console.log('✓ 基于产品新建:表格自动带入 测试产品(B2) 与配方(黑水泥 250kg/锅,D6)');

  // 填锅数验证联动,然后保存(B7=底料锅数;J16=本期用料数量)
  const cellClick = (addr) => evalJS(`(() => {
    const el = document.querySelector('td[data-addr="${addr}"]');
    if (!el) return 'missing';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  const setFxCell = async (addr, text) => {
    await cellClick(addr);
    await evalJS(`(() => {
      const el = document.getElementById('fx-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(text))});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(300);
  };
  await setFxCell('B7', 20);
  const usageTon = await evalJS(`document.querySelector('td[data-addr="J12"]').textContent`);
  if (usageTon !== '5000') { console.error('✗ 新估算单联动失败: ' + usageTon); process.exit(1); }
  console.log('✓ 新估算单联动:黑水泥 250kg×20锅 = 5000 公斤(J12)');
  // 未填完必填项(单价=0、编制人等),只能保存为草稿
  await click('[data-action="editor-save-draft"]');
  await sleep(800);
  const listHasNew = await evalJS(`document.querySelector('#view-estimates') && !document.getElementById('view-estimates').hidden && Array.from(document.querySelectorAll('#view-estimates tbody tr')).some(tr => tr.textContent.includes('测试产品'))`);
  if (!listHasNew) { console.error('✗ 保存估算单失败'); process.exit(1); }
  const draftTag = await evalJS(`Array.from(document.querySelectorAll('#view-estimates tbody tr')).some(tr => tr.textContent.includes('测试产品') && tr.textContent.includes('草稿'))`);
  if (!draftTag) { console.error('✗ 草稿状态标记缺失'); process.exit(1); }
  console.log('✓ 估算单以"草稿"保存并出现在列表(带草稿标记)');

  console.log('\n✅ 全部 CRUD 流程测试通过');
  ws.close();
  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
