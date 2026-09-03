/**
 * CDP 主流程测试(适配 Excel 化表格编辑器):选择单元格/编辑输入/联动重算/覆盖公式/标签页/对比。
 * 运行:node test/cdp-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9233;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '?autologin=1#estimate/e1'
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
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
  async function waitFor(expr, tries = 50) {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const cellText = (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); return el ? el.textContent : null; })()`);
  const clickCell = (addr) => evalJS(`(() => {
    const el = document.querySelector('td[data-addr="${addr}"]');
    if (!el) return 'missing';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  const setFx = async (addr, text) => {
    const r = await clickCell(addr);
    if (r !== 'ok') return r;
    await evalJS(`(() => {
      const el = document.getElementById('fx-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(150);
    return 'ok';
  };
  const clickAction = (action) => evalJS(`(() => {
    const el = document.querySelector('[data-action="${action}"]');
    if (!el) return 'missing';
    el.click();
    return 'ok';
  })()`);

  const ready = await waitFor(`!!document.querySelector('td[data-addr="C6"]') && !document.getElementById('view-editor').hidden`);
  if (!ready) { console.error('✗ 编辑器未渲染'); process.exit(1); }
  console.log('✓ 估算单(e1)表格编辑器已打开');

  // ---- 1. 初始值 ----
  const init = [['B34', '2,428,000'], ['H34', '2,428,000'], ['H33', '5'], ['K17', '1,000,000'], ['E6', '100,000']];
  for (const [a, e] of init) {
    const t = await cellText(a);
    if (t !== e) { console.error(`✗ 初始 ${a} 应为 ${e},实得 ${t}`); process.exit(1); }
  }
  console.log('✓ 初始值正确:成本总价①=2,428,000、②=2,428,000(吨价×用量吨复核)、模数=5、黑水泥用料金额=1,000,000、配比金额=100,000');

  // ---- 2. 单价联动:C6 500->600 ----
  await setFx('C6', '600');
  const v = {
    e5: await cellText('E6'), k16: await cellText('K17'),
    b33: await cellText('B34'), h33: await cellText('H34'), f16: await cellText('F17')
  };
  if (v.e5 !== '120,000' || v.k16 !== '1,200,000' || v.b33 !== '2,628,000' || v.h33 !== '2,628,000' || v.f16 !== '600') {
    console.error('✗ 单价联动失败:' + JSON.stringify(v)); process.exit(1);
  }
  console.log('✓ 单价联动:配比金额 100,000→120,000、用料金额 1,000,000→1,200,000、①2,428,000→2,628,000(②同步复核)、清单单价 F17 同步 600');

  // ---- 3. 锅数联动:B12(底料锅数) 10->15 ----
  await setFx('B12', '15');
  const v2 = { j16: await cellText('J17'), b33: await cellText('B34'), h33: await cellText('H34'), j27: await cellText('J28') };
  if (v2.j16 !== '3000' || v2.b33 !== '3,482,000' || v2.h33 !== '3,482,000' || v2.j27 !== '14,130') {
    console.error('✗ 锅数联动失败:' + JSON.stringify(v2)); process.exit(1);
  }
  console.log('✓ 锅数联动:黑水泥用量 2,000→3,000 公斤、①2,628,000→3,482,000(②同步复核)、总用量 14130 公斤');

  // ---- 4. 模数联动:始模 D33=2,止模 F33=8 -> 7 ----
  await setFx('D33', '2');
  await setFx('F33', '8');
  if ((await cellText('H33')) !== '7') { console.error('✗ 模数联动失败'); process.exit(1); }
  console.log('✓ 模数联动:止模8-始模2+1=7');

  // ---- 5. 库存联动:C17(上存) 2->4,库存 E17 = 7 ----
  await setFx('C17', '4');
  if ((await cellText('E17')) !== '7') { console.error('✗ 库存联动失败'); process.exit(1); }
  console.log('✓ 库存联动:上存4+进料3=7');

  // ---- 6. 占比(每锅×锅数占全部材料比例;此时底料锅数=15、面料=8) ----
  // F6 = 200×15 / (15×830 + 8×210) = 3000/14130 = 21.23%
  if ((await cellText('F6')) !== '21.23%') { console.error('✗ 配比占比异常'); process.exit(1); }
  console.log('✓ 配比占比跨区按锅数加权:F6 = 200×15/14130 = 21.23%');

  // ---- 7. 退出弹窗:有未保存改动点返回 -> 弹三选,选"不保存" ----
  await clickAction('editor-back');
  await sleep(300);
  const modalShown = await evalJS(`!document.getElementById('exit-modal').hidden`);
  if (!modalShown) { console.error('✗ 退出弹窗未出现'); process.exit(1); }
  console.log('✓ 退出弹窗出现(有未保存改动)');
  await evalJS(`document.querySelector('[data-exit-choice="discard"]').click()`);
  await waitFor(`!document.getElementById('view-estimates').hidden`);
  await evalJS(`document.querySelector('.tab[data-view="products"]').click()`);
  await sleep(400);
  if (!(await evalJS(`!document.getElementById('view-products').hidden && !!document.querySelector('#view-products tr')`))) {
    console.error('✗ 产品页切换失败'); process.exit(1);
  }
  console.log('✓ 标签页切换正常');

  // ---- 8. 对比页 ----
  await evalJS(`location.hash = '#compare'`);
  await sleep(500);
  const chk = await evalJS(`(() => {
    const boxes = document.querySelectorAll('[data-compare-id]');
    if (boxes.length < 2) return 'few';
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    const b2 = document.querySelectorAll('[data-compare-id]');
    const t = Array.from(b2).find(cb => !cb.checked);
    t.checked = true;
    t.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  if (chk !== 'ok') { console.error('✗ 勾选失败'); process.exit(1); }
  await sleep(400);
  const compRow = await evalJS(`(() => {
    const rows = document.querySelectorAll('.comp-table-wrap tbody tr');
    for (const r of rows) if (r.textContent.includes('成本总价①')) return r.textContent.replace(/\\s+/g, ' ');
    return null;
  })()`);
  if (!compRow || !compRow.includes('¥2,428,000.00')) { console.error('✗ 对比表异常: ' + compRow); process.exit(1); }
  console.log('✓ 历史对比正常(成本总价①含 ¥2,428,000.00)');

  console.log('\n✅ 全部主流程测试通过');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
