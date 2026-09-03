/**
 * CDP 网格编辑器测试:Excel 化表格的选择、公式栏编辑、默认公式显示、
 * 输入格编辑联动、公式覆盖/还原、循环检测、保存与默认首页。
 * 运行:node test/cdp-grid-test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9236;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP + '?autologin=1'
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
  const fxName = () => evalJS(`document.getElementById('fx-name').textContent`);
  const fxValue = () => evalJS(`document.getElementById('fx-input').value`);
  // 点击单元格
  const clickCell = (addr) => evalJS(`(() => {
    const el = document.querySelector('td[data-addr="${addr}"]');
    if (!el) return 'missing';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  // 在公式栏输入并回车(提交)
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

  // 默认首页:无 hash 时应打开最近估算单的表格编辑器
  const booted = await waitFor(`(() => {
    const v = document.getElementById('view-editor');
    return v && !v.hidden && !!document.querySelector('td[data-addr="C6"]') && location.hash.startsWith('#estimate/');
  })()`);
  if (!booted) { console.error('✗ 默认首页未打开最近估算单表格'); process.exit(1); }
  console.log('✓ 默认首页:自动打开最近估算单的 Excel 化表格(' + (await evalJS('location.hash')) + ')');

  // 切到 e1 进行数值断言
  await evalJS(`location.hash = '#estimate/e1'`);
  const onE1 = await waitFor(`(() => {
    const el = document.querySelector('td[data-addr="J28"]');
    return !!el && el.textContent === '9980';
  })()`);
  if (!onE1) { console.error('✗ 未切换到 e1'); process.exit(1); }
  console.log('✓ 已切到 e1(J28=9980)');

  // ---- 1. 初始计算值(与原始 Excel 坐标一致) ----
  const checks = [
    ['C6', '500'], ['E6', '100,000'], ['B13', '150,800'], ['F6', '20.04%'],
    ['J28', '9980'], ['K28', '2,428,000'], ['B34', '2,428,000'], ['H34', '2428'], ['H33', '5']
  ];
  for (const [addr, expect] of checks) {
    const txt = await cellText(addr);
    if (txt !== expect) { console.error(`✗ 单元格 ${addr} 期望 ${expect} 实得 ${txt}`); process.exit(1); }
  }
  console.log('✓ 初始值正确:单价/金额/合计/占比(百分比)/成本总价①②/模数 与原始口径一致');

  // ---- 2. 单元格选择 -> 公式栏 ----
  await clickCell('E6');
  if ((await fxName()) !== 'E6' || (await fxValue()) !== '=C6*D6') {
    console.error('✗ 公式栏未显示公式: ' + (await fxName()) + ' / ' + (await fxValue())); process.exit(1);
  }
  console.log('✓ 选择公式格:公式栏显示 E6 与默认公式 =C6*D6');

  // ---- 3. 编辑输入格 C6:500 -> 600,联动金额/合计/用料金额 ----
  await setFx('C6', '600');
  const e5 = await cellText('E6');
  if (e5 !== '120,000') { console.error('✗ C6=600 后 E6 应为 120,000,实得 ' + e5); process.exit(1); }
  if ((await cellText('B13')) !== '170,800') { console.error('✗ 底料合计未联动'); process.exit(1); }
  if ((await cellText('B34')) !== '2,628,000') { console.error('✗ 成本总价①未联动'); process.exit(1); }
  console.log('✓ 输入联动:C6 500→600 后 E6=120,000、B13=170,800、成本总价①=2,628,000');

  // ---- 4. 公式覆盖:E6 = =C6*D6*0.9 -> 108,000,合计减 12,000 ----
  await setFx('E6', '=C6*D6*0.9');
  if ((await cellText('E6')) !== '108,000') { console.error('✗ 覆盖公式未生效'); process.exit(1); }
  if ((await cellText('B13')) !== '158,800') { console.error('✗ 合计未随覆盖公式联动'); process.exit(1); }
  console.log('✓ 公式覆盖:E6 = =C6*D6*0.9 → 108,000,底料合计联动为 158,800');

  // ---- 5. 清空还原默认公式 ----
  await setFx('E6', '');
  if ((await cellText('E6')) !== '120,000') { console.error('✗ 清空后未还原默认公式'); process.exit(1); }
  console.log('✓ 覆盖还原:清空 E6 后恢复默认公式 =C6*D6(120,000)');

  // ---- 6. 循环引用 -> #CYCLE! ----
  await setFx('E6', '=F6*2');
  await setFx('F6', '=E6/10');
  const e5c = await cellText('E6'), f5c = await cellText('F6');
  if (e5c !== '#CYCLE!' || f5c !== '#CYCLE!') { console.error('✗ 循环未标记: ' + e5c + '/' + f5c); process.exit(1); }
  console.log('✓ 循环检测:E6↔F6 均显示 #CYCLE!');
  // 还原
  await setFx('E6', '');
  await setFx('F6', '');
  if ((await cellText('F6')) !== '20.04%') { console.error('✗ F6 还原失败'); process.exit(1); }

  // ---- 7. 恢复 C6=500 ----
  await setFx('C6', '500');
  if ((await cellText('E6')) !== '100,000' || (await cellText('B34')) !== '2,428,000') { console.error('✗ 恢复后数值不符'); process.exit(1); }
  console.log('✓ 全部还原:C6=500,E6=100,000,成本总价①=2,428,000');

  // ---- 8. 百分比展示(占比=每锅×锅数占总材料用量的比例,与清单占比一致) ----
  if ((await cellText('F6')) !== '20.04%' || (await cellText('L17')) !== '20.04%') {
    console.error('✗ 占比百分比显示异常'); process.exit(1);
  }
  console.log('✓ 占比列按百分比显示(跨区按每锅×锅数):F6=20.04%(=L17)');

  // ---- 9. 错误值显示(分母为零) ----
  await setFx('D6', '0');
  const f5 = await cellText('F6');
  if (f5 !== '0.00%') { console.error('✗ D6=0 时占比应 0.00%,实得 ' + f5); process.exit(1); }
  await setFx('D6', '200');
  console.log('✓ 分母为 0 保护:占比按 0,恢复 D6=200');

  // ---- 10. 保存 -> 数据落盘(无覆盖) ----
  await clickAction('editor-save');
  await waitFor(`!document.getElementById('view-editor').hidden === false`);
  const saved = await waitFor(`(() => {
    const v = document.getElementById('view-estimates');
    return v && !v.hidden && document.querySelectorAll('#view-estimates tbody tr').length >= 2;
  })()`);
  if (!saved) { console.error('✗ 保存后未回到列表'); process.exit(1); }
  const tk = await evalJS(`localStorage.getItem('brick_token') || ''`);
  const api = await (await fetch(APP + 'api/data', { headers: tk ? { Authorization: 'Bearer ' + tk } : {} })).json();
  const e1 = api.estimates.find((e) => e.id === 'e1');
  if (!e1 || e1.rows[0].price !== 500 || e1.status !== 'ready' ||
      (e1.formulas && (Object.keys(e1.formulas.f || {}).length || Object.keys(e1.formulas.v || {}).length))) {
    console.error('✗ 保存数据异常:' + JSON.stringify({ price: e1 && e1.rows[0].price, status: e1 && e1.status, formulas: e1 && e1.formulas })); process.exit(1);
  }
  console.log('✓ 保存为可用表格:C6 已回写 500,状态 ready,无残留公式覆盖');

  console.log('\n✅ 全部网格编辑器测试通过(页面异常:' + (pageErrors.length ? pageErrors : '无') + ')');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
