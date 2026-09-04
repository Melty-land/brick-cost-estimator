/**
 * CDP 引用追踪高亮测试(点击单元格 → 公式影响链高亮):
 *  1) 点公式格(E6 =C6*D6)→ 来源 C6/D6 加 trace-src(绿),下游 B13 加 trace-dep(橙)
 *  2) 点区域合计格(B13 =SUM(E6:E10))→ 5 个来源全高亮
 *  3) 点输入格(C6)→ 结果链全部加 trace-dep(E6→B13→K17→B34…)
 *  4) 输入格被覆盖成公式后,按公式格追踪(来源生效)
 *  5) 标签格点击无高亮、零异常
 * 运行:node test/cdp-trace-test.cjs(需服务在跑;基于演示数据 e1,建议先 seed-demo;
 *      本测试结束后会自动把改动还原为演示初始值,无需外部复位)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9353;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    APP + '?autologin=1#estimate/e1'
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
  const consoleErrs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrs.push(m.params);
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
  const click = (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); if (!el) return 'missing'; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok'; })()`);
  const traceState = () => evalJS(`(() => ({
    sel: (document.querySelector('td.sel') || {}).dataset ? document.querySelector('td.sel').dataset.addr : null,
    src: Array.from(document.querySelectorAll('td.trace-src')).map(td => td.dataset.addr),
    dep: Array.from(document.querySelectorAll('td.trace-dep')).map(td => td.dataset.addr)
  }))()`);
  const setFx = async (addr, text) => {
    await click(addr);
    await evalJS(`(() => {
      const el = document.getElementById('fx-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(250);
  };
  function assert(cond, msg) { if (!cond) { console.error('✗ ' + msg); process.exit(1); } }

  assert(await waitFor(`!!document.querySelector('td[data-addr="E6"]') && !document.getElementById('view-editor').hidden`), '编辑器未打开');
  console.log('✓ 估算单(e1)编辑器已打开');

  // ---- 1. 点公式格 E6(=C6*D6) ----
  await click('E6');
  await sleep(300);
  let st = await traceState();
  assert(st.sel === 'E6', '选中格应为 E6,实得 ' + st.sel);
  assert(st.src.indexOf('C6') >= 0 && st.src.indexOf('D6') >= 0, 'E6 来源应含 C6、D6,实得 ' + JSON.stringify(st.src));
  assert(st.dep.indexOf('B13') >= 0, 'E6 下游应含 B13(底料合计),实得 ' + JSON.stringify(st.dep));
  console.log('✓ 公式格 E6:来源 C6/D6 绿色高亮,下游 B13 橙色高亮');

  // ---- 2. 点区域合计格 B13(SUM E6:E10) ----
  await click('B13');
  await sleep(300);
  st = await traceState();
  const expectSrc = ['E6', 'E7', 'E8', 'E9', 'E10'];
  assert(expectSrc.every((a) => st.src.indexOf(a) >= 0), 'B13 区域来源应含 E6..E10,实得 ' + JSON.stringify(st.src));
  console.log('✓ 合计公式格 B13:SUM 区域 5 个来源全部高亮');

  // ---- 3. 点输入格 C6 → 结果链橙高亮 ----
  await click('C6');
  await sleep(300);
  st = await traceState();
  assert(st.dep.indexOf('E6') >= 0, 'C6 从属应含 E6(配比金额)');
  assert(st.dep.indexOf('B13') >= 0, 'C6 从属应含 B13(合计)');
  assert(st.dep.indexOf('B34') >= 0, 'C6 从属应含 B34(成本总价①)——整条结果链应高亮');
  console.log('✓ 输入格 C6:' + st.dep.length + ' 个结果格橙高亮(链条直至成本总价)');

  // ---- 4. 输入格覆盖成公式后按公式追踪 ----
  await setFx('D6', '=C6*3');
  st = await traceState();
  assert(st.src.indexOf('C6') >= 0, 'D6 覆盖为公式后来源应含 C6,实得 ' + JSON.stringify(st.src));
  console.log('✓ 输入格被覆盖为公式后,点击按公式格追踪(=C6*3 → C6 绿)');
  await setFx('D6', '200'); // 还原演示初始值
  st = await traceState();
  assert(st.dep.indexOf('E6') >= 0, '还原为输入格后应从属模式(含 E6)');
  console.log('✓ 还原输入格后追踪恢复为"从属"模式');

  // ---- 5. 标签格点击 → 无高亮 ----
  const anyLab = await evalJS(`(() => { const td = Array.from(document.querySelectorAll('td.sg.lab, td.sg.mat, td.sg.title')).find(x => x.dataset.addr); return td ? td.dataset.addr : null; })()`);
  if (anyLab) {
    await click(anyLab);
    await sleep(250);
    st = await traceState();
    assert(st.src.length === 0 && st.dep.length === 0, '标签格不应触发追踪高亮');
    console.log('✓ 标签格点击无追踪高亮');
  }

  // ---- 6. 零 console 错误 ----
  assert(consoleErrs.length === 0, '页面 console 错误:' + JSON.stringify(consoleErrs).slice(0, 300));
  console.log('✓ 页面零异常');

  console.log('\n✅ 全部引用追踪高亮测试通过');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗ 追踪测试失败:', e); process.exit(1); });
