/**
 * stats.js 单元测试(用料明细与剩余材料聚合)
 * 覆盖:三级产品匹配、明细行字段与口径、期末结存、剩余材料两种口径、
 *       筛选(时间段/产品/材料)、空值防 NaN、同材料跨区、空数据。
 * 运行:node test/stats.test.cjs
 */
'use strict';
const Stats = require('../public/js/stats.js');
const CostCalc = require('../public/js/calc.js');

function ok(cond, msg) {
  if (!cond) { console.error('✗ ' + msg); process.exit(1); }
  console.log('✓ ' + msg);
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---------- 固定数据(不依赖数据库) ----------
const products = [
  { id: 'p1', name: '标砖 A', code: 'A-100' },
  { id: 'p2', name: '透水砖 B', code: 'B-200' }
];
const m = (name, zone) => ({ id: 'mid-' + name, name, zone });
const materials = [m('黑水泥', '底料'), m('机制砂', '底料'), m('染料', '面料')];
const rows = (list) => list.map(([name, zone, qty, price, sh, si]) => ({
  id: 'r' + name + zone, materialId: 'mid-' + name, name, zone,
  qtyPerPot: qty, price: price, stockOnHand: sh, stockIn: si, qty: ''
}));
const est = (id, pid, name, code, date, potB, potT, list) => ({
  id: id, productId: pid, name: name, code: code, startDate: date, endDate: date, author: 'a',
  potBottom: potB, potTop: potT, status: 'ready',
  rows: rows(list),
  calc: {
    length: 240, width: 115, height: 53, perPieceWeight: 2.5, perModuleCount: 24, moldManual: 10,
    perPalletCount: 300, perPalletSqm: 8.28, actualCount: '', startMold: 1, endMold: 10
  }
});
const data = {
  products: products,
  materials: materials,
  estimates: [
    est('e1', 'p1', '标砖 A', 'A-100', '2026-09-01', 10, 5,
      [['黑水泥', '底料', 20, 0.26, 0, 100], ['机制砂', '底料', 30, 0.06, 50, 0], ['染料', '面料', 1, 8.6, 0, 0]]),
    est('e2', 'p2', '透水砖 B', 'B-200', '2026-10-01', 8, 4,
      [['黑水泥', '底料', 25, 0.26, 0, 40], ['机制砂', '底料', 40, 0.06, 0, 0]]),
    est('e3', '', '手工砖 C', 'C-300', '2026-10-05', 6, 0, [['黑水泥', '底料', 10, 0.26, 0, 0]])
  ]
};

// ---------- 1-4 产品匹配 ----------
const mp1 = Stats.matchProduct(data.estimates[0], products);
ok(mp1.code === 'A-100' && mp1.name === '标砖 A' && mp1.matched === true,
  '1 三级匹配(按 productId)');
const mp2 = Stats.matchProduct({ name: '透水砖 B', code: 'X' }, products);
ok(mp2.matched === true && mp2.code === 'B-200', '2 按产品名匹配');
const mp3 = Stats.matchProduct({ name: '其他', code: 'B-200' }, products);
ok(mp3.matched === true && mp3.code === 'B-200', '3 按预算表编号匹配');
const mp4 = Stats.matchProduct(data.estimates[2], products);
ok(mp4.code === 'C-300' && mp4.name === '未匹配产品' && mp4.matched === false,
  '4 未匹配兜底(显示预算表编号 + 未匹配产品)');

// ---------- 5-8 明细表 ----------
const r1 = Stats.buildUsage(data, {});
ok(r1.detail.length === 6, '5 明细行数 = 6(e1 三行 + e2 两行 + e3 一行)');
const e1Black = r1.detail.filter((d) => d.code === 'A-100' && d.materialName === '黑水泥')[0];
ok(e1Black && near(e1Black.usageKg, 200) && near(e1Black.amount, 52) && near(e1Black.closing, -100) &&
  near(e1Black.pots, 10) && e1Black.zone === '底料',
  '6 明细行字段(用量 200 / 金额 52 / 期末结存 -100 / 锅数 10 / 底料)');
const e1UsageKg = CostCalc.compute(data.estimates[0]).listTotals.usageKg;
ok(near(e1Black.ratio, 200 / e1UsageKg), '7 占比 = 该行用料 ÷ 该批次全材料用料合计');
const e1Dye = r1.detail.filter((d) => d.code === 'A-100' && d.materialName === '染料')[0];
ok(e1Dye && near(e1Dye.pots, 5) && near(e1Dye.usageKg, 5), '8 面料行锅数取 potTop(染料 1×5=5)');

// ---------- 9-12 剩余材料与小计 ----------
ok(r1.stock.length === 3, '9a 剩余材料表行数 = 3');
const s1 = r1.stock.filter((s) => s.name === '黑水泥')[0];
ok(s1 && near(s1.stockOnHand, 0) && near(s1.stockIn, 140) && near(s1.usageKg, 460) &&
  near(s1.closingTotal, -320) && s1.estCount === 3,
  '9b 黑水泥累计:上存 0 / 进料 140 / 用料 460 / 累计剩余 -320 / 3 批');
ok(s1 && near(s1.latestClosing, -60), '10 最新批次结存取日期最新批次(e3:0+0−60 = -60)');
ok(r1.meta.unmatched === 1, '11 未匹配产品计数 = 1');
ok(r1.meta.estCount === 3 && r1.meta.rowCount === 6 && near(r1.meta.totalKg, 1085),
  '12 小计:批次 3 / 明细 6 行 / 合计用料 1085 公斤');

// ---------- 13-15 筛选 ----------
ok(Stats.buildUsage(data, { from: '2026-10-01' }).meta.estCount === 2,
  '13 时间段筛选(≥2026-10-01 → 2 批)');
ok(Stats.buildUsage(data, { types: ['标砖 A'] }).detail.length === 3, '14 产品筛选(标砖 A → 3 行)');
const r15 = Stats.buildUsage(data, { mats: ['黑水泥'] });
ok(r15.detail.length === 3 && near(r15.meta.totalKg, 460) && near(r15.meta.totalAmount, 119.6),
  '15 材料筛选后:明细 3 行,小计按筛选后行合计(黑水泥 460 公斤 / 119.6 元),不再显示全材料合计');

// ---------- 16 空值不产生 NaN ----------
const blankEst = est('e9', 'p1', '标砖 A', 'A-100', '2026-09-02', 10, 5,
  [['黑水泥', '底料', '', null, null, '']]);
const r16 = Stats.buildUsage({ products: products, materials: materials, estimates: [blankEst] }, {});
const b16 = r16.detail[0];
ok(b16 && near(b16.usageKg, 0) && near(b16.amount, 0) && near(b16.closing, 0),
  '16a 空值行按 0 计算(用量/金额/结存 = 0)');
const flatNums = []
  .concat(r16.detail, r16.stock, [r16.meta])
  .reduce(function (acc, o) {
    Object.keys(o).forEach(function (k) { acc.push(o[k]); });
    return acc;
  }, []);
ok(flatNums.every(function (v) { return typeof v !== 'number' || isFinite(v); }),
  '16b 结果中所有数值字段均为有限数(无 NaN/Infinity)');

// ---------- 17 同材料跨区 ----------
const crossEst = est('e8', 'p1', '标砖 A', 'A-100', '2026-09-03', 10, 5,
  [['黑水泥', '底料', 20, 0.26, 0, 0], ['黑水泥', '面料', 4, 0.26, 0, 0]]);
const r17 = Stats.buildUsage({ products: products, materials: materials, estimates: [crossEst] }, {});
const blacks = r17.detail.filter((d) => d.materialName === '黑水泥');
ok(blacks.length === 2 && near(blacks[0].pots + blacks[1].pots, 15),
  '17a 同材料跨区拆为两行(锅数分别取底料/面料)');
const s17 = r17.stock.filter((s) => s.name === '黑水泥');
ok(s17.length === 1 && near(s17[0].usageKg, 200 + 20),
  '17b 剩余材料表按材料合并(黑水泥 1 行,用料 = 两行之和)');

// ---------- 18 空数据 ----------
const r18 = Stats.buildUsage({ estimates: [], products: products, materials: materials }, {});
ok(Array.isArray(r18.detail) && r18.detail.length === 0 &&
  Array.isArray(r18.stock) && r18.stock.length === 0 &&
  r18.meta.estCount === 0 && r18.meta.rowCount === 0 &&
  r18.meta.totalKg === 0 && r18.meta.totalAmount === 0 && r18.meta.unmatched === 0,
  '18 空数据返回空表与零小计');

// ---------- 19 最新批次结存:取全局最新命中批次(该批次不含此材料则为 null) ----------
const d19 = {
  products: products, materials: materials,
  estimates: [
    est('a1', 'p1', '标砖 A', 'A-100', '2026-09-01', 10, 0,
      [['黑水泥', '底料', 10, 0.26, 0, 0], ['机制砂', '底料', 10, 0.06, 0, 0]]),
    est('a2', 'p1', '标砖 A', 'A-100', '2026-10-01', 10, 0,
      [['机制砂', '底料', 10, 0.06, 0, 0]])
  ]
};
const r19 = Stats.buildUsage(d19, {});
const s19b = r19.stock.filter(function (s) { return s.name === '黑水泥'; })[0];
const s19s = r19.stock.filter(function (s) { return s.name === '机制砂'; })[0];
ok(s19b && s19b.latestClosing === null,
  '19a 最新批次(2026-10-01)不含该材料 → 最新批次结存为 null(界面显示「—」)');
ok(s19s && near(s19s.latestClosing, -100),
  '19b 最新批次含该材料 → 取该批次结存(机制砂 0+0−100 = -100)');

console.log('\n✅ stats.js 全部单元测试通过');
