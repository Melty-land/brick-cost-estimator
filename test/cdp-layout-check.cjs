/**
 * CDP 版式检查(2026-09 修订):
 *  1) 材料清单区表头应为 9 概念列(已删 单价/数量(公斤)/金额),colspan 铺满 12 格;
 *  2) 清单数据行 colspan 总和 = 12(上下 12 列宽度一致);
 *  3) 关键值:本期用料金額 I17=1,000,000、合计 G28=9980 / I28=2,428,000(成本总价联动);
 *  4) 导出 collectTable 展开后每行 12 列且不含被删列。
 * 运行:node test/cdp-layout-check.cjs(需服务在跑;基于演示数据 e1,建议先 seed-demo)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9377;
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
  const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params);
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
    if (r.result && r.result.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails));
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

  assert(await waitFor(`!!document.querySelector('td[data-addr="C6"]')`), '编辑器未打开');
  await sleep(200);
  console.log('✓ 估算单(e1)编辑器已打开');

  // ---- 1/2. 表头与 colspan ----
  const dump = await evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('.sheet-grid tbody tr'));
    for (let ri = 0; ri < rows.length; ri++) {
      const tds = Array.from(rows[ri].querySelectorAll('td'));
      if (tds.map(td => td.textContent).join('|').indexOf('上存材料') >= 0) {
        const heads = tds.filter(td => td.classList.contains('hdr')).map(td => ({ t: td.textContent, cs: td.colSpan }));
        const dataTds = Array.from(rows[ri + 1].querySelectorAll('td'));
        return {
          heads: heads,
          dataSpans: dataTds.map(td => ({ a: td.dataset.addr || '', cs: td.colSpan }))
        };
      }
    }
    return null;
  })()`);
  assert(dump, '未找到材料清单表头');
  const hdrs = dump.heads.map(h => h.t);
  const wantHeads = ['序号', '材料名称', '上存材料(公斤)', '本期进料(公斤)', '库存材料(公斤)', '本期用料单价', '本期用料数量(公斤)', '本期用料金額', '占比'];
  assert(JSON.stringify(hdrs) === JSON.stringify(wantHeads), '表头应为 9 概念列,实得 ' + JSON.stringify(hdrs));
  const totalSpan = dump.dataSpans.reduce((s, c) => s + (c.cs || 1), 0);
  assert(totalSpan === 12, '数据行 colspan 总和应为 12,实得 ' + totalSpan);
  console.log('✓ 材料清单表头 9 列(单价/数量(公斤)/金额已删);数据行 colspan 总和 = 12');

  // ---- 3. 关键值 ----
  const cell = async (addr) => evalJS(`(() => { const el = document.querySelector('td[data-addr="${addr}"]'); return el ? el.textContent : null; })()`);
  assert((await cell('I17')) === '1,000,000', 'I17 本期用料金額应 1,000,000');
  assert((await cell('G28')) === '9980', 'G28 用量合计应 9980');
  assert((await cell('I28')) === '2,428,000', 'I28 金額合计应 2,428,000(成本总价①联动)');
  assert((await cell('B34')) === '2,428,000' && (await cell('H34')) === '2,428,000', '成本总价①②应 2,428,000');
  assert((await cell('K17')) === '20.04%', 'K17 占比应 20.04%');
  console.log('✓ 关键值:清单金额/合计/成本总价/占比 与修订前列值一致(数值无回归)');

  // ---- 4. 导出 collectTable:每行 12 列、无被删列 ----
  const exportChk = await evalJS(`(() => {
    const table = document.querySelector('.sheet-grid');
    const grid = window.Exporter.collectTable(table);
    const colCounts = [...new Set(grid.map(r => r.length))];
    let listHeadRow = -1;
    for (let i = 0; i < grid.length; i++) if (grid[i].some(t => t && t.indexOf('上存材料') >= 0)) { listHeadRow = i; break; }
    return { colCounts: colCounts, head: listHeadRow >= 0 ? grid[listHeadRow] : null };
  })()`);
  assert(exportChk.colCounts.length === 1 && exportChk.colCounts[0] === 12, '导出每行应展开为 12 列,实得 ' + JSON.stringify(exportChk.colCounts));
  const headCells = (exportChk.head || []).filter(Boolean); // 去掉 colspan 占位空串
  const hasBareCols = headCells.some(function (t) { return t === '单价' || t === '数量(公斤)' || t === '金额'; });
  assert(hasBareCols === false, '导出表头应无 单价/数量(公斤)/金额 裸列,实得 ' + JSON.stringify(headCells));
  console.log('✓ 导出 collectTable:每行展开 12 列,清单表头无 单价/数量(公斤)/金额');

  // ---- 5. 零异常 ----
  assert(errs.length === 0, '页面 console 错误:' + JSON.stringify(errs).slice(0, 300));
  console.log('✓ 页面零异常');

  console.log('\n✅ 版式检查全部通过(材料清单 9 列铺满 12 格,上下宽度一致)');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error('✗ 版式检查失败:', e); child.kill(); process.exit(1); });
