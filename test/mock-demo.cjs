/**
 * 幂等组装"演示+验证"数据(手动工具,不在自动测试/seed 流程内):
 *  - 基础:当前库(可为 seed-demo 后 e1/e2)+ 用户真实单 estimate3(+其产品 product2,若缺失)
 *  - 追加 5 组模拟砖型产品与 11 个模拟估算单(多孔/透水/路缘石/植草/连锁块;跨 2026-07~12)
 *  - 模拟产品 id 固定(mprod-dk/ts/ly/zc/ls),可重复运行不重复添加
 * 用法:node test/mock-demo.cjs(需服务在跑;不会删除已有数据)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sheet = require('../public/js/sheet.js');

const API = 'http://127.0.0.1:8237/';
async function call(p, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(p + ' HTTP ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
let cnt = 0;
const uid = () => 'r' + Date.now().toString(36) + (cnt++).toString(36) + Math.random().toString(36).slice(2, 6);
const setPath = (obj, p, v) => {
  const parts = String(p).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = v;
};
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

const PRODUCTS = [
  { id: 'mprod-dk', name: '多孔砖 240×115×90', code: 'DK-240', recipe: [['黑水泥', 120], ['3-6', 180], ['5-10', 150], ['机制砂', 220], ['石粉', 60], ['染料', 1.5]] },
  { id: 'mprod-ts', name: '透水砖 300×150×60', code: 'TS-300', recipe: [['黑水泥', 90], ['5-10', 260], ['机制砂', 140], ['金刚黑', 3], ['增强剂', 2]] },
  { id: 'mprod-ly', name: '路缘石 500×150×200', code: 'LY-500', recipe: [['白水泥', 80], ['普砂', 320], ['精白砂', 90], ['染料', 4]] },
  { id: 'mprod-zc', name: '植草砖 400×300×80', code: 'ZC-400', recipe: [['3-6', 220], ['5-10', 180], ['机制砂', 150], ['黑水泥', 110], ['增强剂', 2.5]] },
  { id: 'mprod-ls', name: '连锁块 200×100×60', code: 'LS-200', recipe: [['黑水泥', 100], ['普砂', 240], ['精白砂', 70], ['金刚黑', 2], ['染料', 1]] }
];
const PRICE = { '黑水泥': 0.26, '白水泥': 0.42, '3-6': 0.07, '5-10': 0.07, '机制砂': 0.06, '石粉': 0.05, '普砂': 0.065, '精白砂': 0.08, '金刚黑': 1.2, '增强剂': 3.5, '染料': 8.6 };
// 每组:[砖型id, 批次列表:[{code,name,date,potB,potT,sh,si,calc}]]
const BATCHES = [
  { pid: 'mprod-dk', batches: [
    { code: 'DK-001', name: '多孔砖 240×115×90 2026-07-10', date: '2026-07-10', potB: 40, potT: 15, sh: 200, si: 120, calc: { length: 240, width: 115, height: 90, perPieceWeight: 3.2, perModuleCount: 24, moldManual: 6, perPalletCount: 300, perPalletSqm: 8.28, actualCount: 9000 } },
    { code: 'DK-002', name: '多孔砖 240×115×90 2026-08-12', date: '2026-08-12', potB: 45, potT: 16, sh: 100, si: 200, calc: { length: 240, width: 115, height: 90, perPieceWeight: 3.2, perModuleCount: 24, moldManual: 6, perPalletCount: 300, perPalletSqm: 8.28, actualCount: 9500 } },
    { code: 'DK-003', name: '多孔砖 240×115×90 2026-09-08', date: '2026-09-08', potB: 50, potT: 18, sh: 60, si: 220, calc: { length: 240, width: 115, height: 90, perPieceWeight: 3.2, perModuleCount: 24, moldManual: 6, perPalletCount: 300, perPalletSqm: 8.28, actualCount: 10000 } }
  ] },
  { pid: 'mprod-ts', batches: [
    { code: 'TS-101', name: '透水砖 300×150×60 2026-07-05', date: '2026-07-05', potB: 60, potT: 20, sh: 300, si: 150, calc: { length: 300, width: 150, height: 60, perPieceWeight: 5.16, perModuleCount: 18, moldManual: 8, perPalletCount: 384, perPalletSqm: 17.28, actualCount: 5000 } },
    { code: 'TS-102', name: '透水砖 300×150×60 2026-10-02', date: '2026-10-02', potB: 65, potT: 22, sh: 120, si: 260, calc: { length: 300, width: 150, height: 60, perPieceWeight: 5.16, perModuleCount: 18, moldManual: 8, perPalletCount: 384, perPalletSqm: 17.28, actualCount: 5200 } }
  ] },
  { pid: 'mprod-ly', batches: [
    { code: 'LY-201', name: '路缘石 500×150×200 2026-08-01', date: '2026-08-01', potB: 25, potT: 10, sh: 500, si: 200, calc: { length: 500, width: 150, height: 200, perPieceWeight: 30, perModuleCount: 6, moldManual: 10, perPalletCount: 60, perPalletSqm: 0.225, actualCount: 800 } },
    { code: 'LY-202', name: '路缘石 500×150×200 2026-11-15', date: '2026-11-15', potB: 28, potT: 12, sh: 300, si: 250, calc: { length: 500, width: 150, height: 200, perPieceWeight: 30, perModuleCount: 6, moldManual: 10, perPalletCount: 60, perPalletSqm: 0.225, actualCount: 850 } }
  ] },
  { pid: 'mprod-zc', batches: [
    { code: 'ZC-301', name: '植草砖 400×300×80 2026-09-20', date: '2026-09-20', potB: 35, potT: 12, sh: 400, si: 180, calc: { length: 400, width: 300, height: 80, perPieceWeight: 12, perModuleCount: 8, moldManual: 4, perPalletCount: 120, perPalletSqm: 0.96, actualCount: 2000 } },
    { code: 'ZC-302', name: '植草砖 400×300×80 2026-12-05', date: '2026-12-05', potB: 38, potT: 14, sh: 150, si: 300, calc: { length: 400, width: 300, height: 80, perPieceWeight: 12, perModuleCount: 8, moldManual: 4, perPalletCount: 120, perPalletSqm: 0.96, actualCount: 2100 } }
  ] },
  { pid: 'mprod-ls', batches: [
    { code: 'LS-401', name: '连锁块 200×100×60 2026-10-10', date: '2026-10-10', potB: 55, potT: 20, sh: 80, si: 300, calc: { length: 200, width: 100, height: 60, perPieceWeight: 2.4, perModuleCount: 40, moldManual: 6, perPalletCount: 500, perPalletSqm: 1.2, actualCount: 6000 } },
    { code: 'LS-402', name: '连锁块 200×100×60 2026-12-18', date: '2026-12-18', potB: 60, potT: 24, sh: 200, si: 350, calc: { length: 200, width: 100, height: 60, perPieceWeight: 2.4, perModuleCount: 40, moldManual: 6, perPalletCount: 500, perPalletSqm: 1.2, actualCount: 6500 } }
  ] }
];

async function main() {
  const login = await call('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  const token = login.token;
  let cur = await call('api/data', 'GET', null, token);
  const M = {};
  cur.materials.forEach((m) => { M[m.name] = m; });

  // 用户真实单 estimate3 与产品 product2 兜底(若当前库被 seed-demo 覆盖则补回)
  const ucPath = path.join(__dirname, '..', 'data', '.userdata-cache.json');
  if (fs.existsSync(ucPath)) {
    const uc = JSON.parse(fs.readFileSync(ucPath, 'utf8'));
    const e3 = uc.estimates.find((x) => x.id === 'estimate3');
    const p2 = uc.products.find((x) => x.id === 'product2');
    if (e3 && !cur.estimates.some((x) => x.id === 'estimate3')) cur.estimates.push(JSON.parse(JSON.stringify(e3)));
    if (p2 && !cur.products.some((x) => x.id === 'product2')) cur.products.push(JSON.parse(JSON.stringify(p2)));
  }

  // 5 模拟产品(幂等:已存在则跳过)
  const codeToNew = { 'DK-240': 'mprod-dk', 'TS-300': 'mprod-ts', 'LY-500': 'mprod-ly', 'ZC-400': 'mprod-zc', 'LS-200': 'mprod-ls' };
  // 清理历史杂 id(pmtri*)
  const renameOld = {};
  cur.products.forEach((p) => { if (/^pmtri[A-Za-z0-9]+$/.test(p.id) && codeToNew[p.code]) renameOld[p.id] = codeToNew[p.code]; });
  cur.products.forEach((p) => { if (renameOld[p.id]) p.id = renameOld[p.id]; });
  cur.estimates.forEach((e) => { if (e.productId && renameOld[e.productId]) e.productId = renameOld[e.productId]; });

  PRODUCTS.forEach((p) => {
    if (!cur.products.some((x) => x.id === p.id)) {
      cur.products.push({ id: p.id, name: p.name, code: p.code, recipe: p.recipe.map(([n, q]) => ({ materialId: M[n].id, qtyPerPot: q })) });
    }
  });

  // 估算单(幂等:按 code 跳过)
  const estCodes = new Set(cur.estimates.map((e) => e.code));
  BATCHES.forEach((g) => {
    g.batches.forEach((b) => {
      if (estCodes.has(b.code)) return;
      const rows = PRODUCTS.find((p) => p.id === g.pid).recipe.map(([name, qty]) => {
        const m = M[name];
        return { id: uid(), materialId: m.id, name: m.name, zone: m.zone, qtyPerPot: qty, price: PRICE[name] || 0.1, stockOnHand: b.sh, stockIn: b.si, qty: 0 };
      });
      const est = {
        id: 'mock-' + b.code.toLowerCase().replace(/[^a-z0-9]/g, ''),
        productId: g.pid, status: 'ready', name: b.name, code: b.code,
        startDate: b.date, endDate: b.date, author: 'admin',
        potBottom: b.potB, potTop: b.potT, rows: rows,
        calc: Object.assign({ perPieceWeight: '', perModuleCount: '', moldManual: 5, perPalletCount: '', perPalletSqm: '', actualCount: '', startMold: 1, endMold: 5, perSqmWeight: '', perCubicWeight: '', perPalletWeight: '', planCount: '', yieldRate: '', tonPrice: '', perSqmPrice: '' }, b.calc)
      };
      // derive 回写(等同编辑器保存)
      const res = Sheet.evaluate(est, { f: {}, v: {} });
      Object.keys(res.addrCells).forEach((addr) => {
        const def = res.addrCells[addr];
        if (def && def.derive && res.values[addr] !== undefined) {
          const val = res.values[addr];
          if (!(val && typeof val === 'object' && val.err)) setPath(est, def.derive, val === '' || val === null ? '' : (typeof val === 'number' ? val : String(val)));
        }
      });
      cur.estimates.push(est);
      cur.seq.estimate = (cur.seq.estimate || 0) + 1;
    });
  });

  // 清理杂 id 估算单(mock\d+-\w 旧格式)防重复
  cur.estimates = cur.estimates.filter((e) => !/^mock\d+-/.test(e.id));
  cur.seq.estimate = cur.estimates.length;

  await call('api/data', 'PUT', cur, token);
  const d = await call('api/data', 'GET', null, token);
  console.log('组装完成:估算单 ' + d.estimates.length + '(estimate3=' + d.estimates.some((x) => x.id === 'estimate3') +
    ', mock=' + d.estimates.filter((x) => x.id.indexOf('mock-') === 0).length + '),产品 ' + d.products.length);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
