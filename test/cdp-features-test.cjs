/**
 * CDP 功能测试(②保存产品确认弹窗、⑤估算单导入产品配方):
 * 运行:node test/cdp-features-test.cjs(结束后请用 seed-demo 复位数据)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9261;
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
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const cellText = (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); return el ? el.textContent : null; })()`);
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);

  // ---- ⑤ 空白估算单中导入产品配方 p1 ----
  if (!(await waitFor(`!document.getElementById('view-editor').hidden && !!document.querySelector('#grid-pick-product')`))) {
    console.error('✗ 估算单编辑器/导入下拉未就绪'); process.exit(1);
  }
  await evalJS(`(() => {
    const sel = document.getElementById('grid-pick-product');
    sel.value = 'p1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(600);
  const nameCell = await cellText('B2');
  const codeCell = await cellText('D2');
  const qty6 = await cellText('D6');      // 底料首行(黑水泥)每锅数量
  const rowCount = await evalJS(`document.querySelectorAll('td[data-addr^="B"]').length`);
  if (nameCell !== '标砖 240×115×53' || codeCell !== 'BZ-240' || qty6 !== '200') {
    console.error('✗ 导入配方未自动填写: ' + JSON.stringify({ nameCell, codeCell, qty6 })); process.exit(1);
  }
  if (rowCount < 10) { console.error('✗ 材料行数量异常: ' + rowCount); process.exit(1); }
  console.log('✓ ⑤ 导入产品配方:名称规格/编号自动填入,材料行与每锅用量(黑水泥 D6=200)已填充');

  // 已有材料行时再次选择同一产品 -> 应弹确认;确认后替换
  await evalJS(`(() => {
    const sel = document.getElementById('grid-pick-product');
    sel.value = 'p1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  const confirmShown = await evalJS(`!document.getElementById('confirm-modal').hidden`);
  if (!confirmShown) { console.error('✗ 有材料行时导入未弹确认'); process.exit(1); }
  await click('#confirm-ok');
  await sleep(500);
  if ((await cellText('D6')) !== '200') { console.error('✗ 确认后未替换'); process.exit(1); }
  console.log('✓ ⑤ 已有材料行时导入弹确认,确认后替换完成');

  // 有未保存改动,经退出弹窗选"不保存"再进入产品页
  await click('[data-action="editor-back"]');
  await sleep(300);
  if (!(await evalJS(`!document.getElementById('exit-modal').hidden`))) { console.error('✗ 退出弹窗未出现'); process.exit(1); }
  await evalJS(`document.querySelector('[data-exit-choice="discard"]').click()`);
  await waitFor(`!document.getElementById('view-estimates').hidden`);

  // ---- ② 产品配方保存确认(新建一个产品,先取消再确认) ----
  await evalJS(`document.querySelector('.tab[data-view="products"]').click()`);
  await sleep(500);
  await click('[data-action="new-product"]');
  await sleep(300);
  const setIn = async (pathAttr, value) => evalJS(`(() => {
    const el = document.querySelector('[data-path="${pathAttr}"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await setIn('name', '确认弹窗测试砖');
  await setIn('code', 'TEST-99');
  await click('[data-action="pf-add-row"]');
  await sleep(300);
  await click('[data-action="save-product"]');
  await sleep(400);
  if (!(await evalJS(`!document.getElementById('confirm-modal').hidden`))) { console.error('✗ 保存产品未弹确认'); process.exit(1); }
  // 先取消:不应保存
  await click('#confirm-cancel');
  await sleep(400);
  const stillForm = await evalJS(`!!document.querySelector('[data-path="name"]')`);
  const savedYet = await evalJS(`Array.from(document.querySelectorAll('#view-products tbody tr')).some(tr => tr.textContent.includes('确认弹窗测试砖'))`);
  if (!stillForm || savedYet) { console.error('✗ 取消后状态异常'); process.exit(1); }
  console.log('✓ ② 保存产品弹确认;点取消不保存,留在表单');
  // 再次保存并确认 -> 保存成功
  await click('[data-action="save-product"]');
  await sleep(300);
  await click('#confirm-ok');
  await sleep(600);
  const savedAfterOk = await evalJS(`Array.from(document.querySelectorAll('#view-products tbody tr')).some(tr => tr.textContent.includes('确认弹窗测试砖'))`);
  if (!savedAfterOk) { console.error('✗ 确认后未保存'); process.exit(1); }
  console.log('✓ ② 点确认后产品保存成功');

  if (pageErrors.length) { console.error('✗ 页面异常: ' + JSON.stringify(pageErrors)); process.exit(1); }
  console.log('\n✅ 功能测试全部通过(②保存确认 / ⑤导入配方)');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
