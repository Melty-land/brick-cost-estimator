/**
 * calc.js 单元测试(Node 直接运行):node test/calc.test.cjs
 */
'use strict';
const assert = require('assert');
const Calc = require('../public/js/calc.js');

// ---------- 用例 1:完整估算单 ----------
const est = {
  rows: [
    { id: 'a', name: '黑水泥', zone: '底料', qtyPerPot: 200, price: 500, stockOnHand: 2, stockIn: 3, qty: 5 },
    { id: 'b', name: '机制砂', zone: '底料', qtyPerPot: 300, price: 80,  stockOnHand: 1, stockIn: 1, qty: 2 },
    { id: 'c', name: '白水泥', zone: '面料', qtyPerPot: 100, price: 600, stockOnHand: 0, stockIn: 1, qty: 1 }
  ],
  potBottom: 10, potTop: 8,
  // 与 UI 数据模型一致:成本核算字段存放于 calc.*
  calc: { tonPrice: 300, startMold: 1, endMold: 5 }
};
const c = Calc.compute(est);

// 底料配比:数量合计 500
assert.strictEqual(c.bottom.qtyTotal, 500);
// 配比占比口径 = 每锅×锅数 ÷ 跨区加权总和(200×10+300×10+100×8=5800):黑水泥 2000/5800
assert.ok(Math.abs(c.bottom.rows[0].ratio - 2000 / 5800) < 1e-12);
assert.ok(Math.abs(c.bottom.rows[1].ratio - 3000 / 5800) < 1e-12);

// 配比金额 = 单价×数量(公斤,全表不换算):黑水泥 500×200=100000;机制砂 80×300=24000
assert.strictEqual(c.bottom.rows[0].amount, 100000);
assert.strictEqual(c.bottom.rows[1].amount, 24000);
assert.strictEqual(c.bottom.amountTotal, 124000);

// 面料:白水泥 600×100=60000;占比(跨区加权)800/5800
assert.strictEqual(c.top.amountTotal, 60000);
assert.ok(Math.abs(c.top.rows[0].ratio - 800 / 5800) < 1e-12);

// 材料清单:库存 = 上存+进料
assert.strictEqual(c.rows[0].stock, 5);
assert.strictEqual(c.rows[1].stock, 2);
// 金额 = 单价 × 数量(公斤):黑水泥 500×5=2500
assert.strictEqual(c.rows[0].amount, 2500);
// 本期用料数量(公斤)= 配比×锅数:黑水泥 200×10=2000;机制砂 300×10=3000;白水泥 100×8=800
assert.strictEqual(c.rows[0].usageKg, 2000);
assert.strictEqual(c.rows[1].usageKg, 3000);
assert.strictEqual(c.rows[2].usageKg, 800);
assert.strictEqual(c.rows[0].usageTon, 2000); // 兼容字段,现为公斤
// 本期用料金额 = 单价×用量(公斤):黑水泥 500×2000=1000000;机制砂 80×3000=240000;白水泥 600×800=480000
assert.strictEqual(c.rows[0].usageAmount, 1000000);
assert.strictEqual(c.rows[1].usageAmount, 240000);
assert.strictEqual(c.rows[2].usageAmount, 480000);
// 合计
assert.strictEqual(c.listTotals.stockOnHand, 3);
assert.strictEqual(c.listTotals.stock, 8);
assert.strictEqual(c.listTotals.usageKg, 5800);
assert.strictEqual(c.listTotals.usageAmount, 1720000);
// 材料清单占比按使用数量(公斤):黑水泥 2000/5800
assert.ok(Math.abs(c.rows[0].ratio - 2000 / 5800) < 1e-12);
// 成本总价① = 本期用料金额合计;② = 材料吨价(元/吨) × 用料总量(吨 = 公斤/1000)
assert.strictEqual(c.calc.costTotal1, 1720000);
assert.strictEqual(c.calc.costTotal2, 1740); // 300 元/吨 × 5800 公斤 ÷ 1000 = 1740 元
// 模数 = 止模-始模+1
assert.strictEqual(c.calc.mold, 5);

// ---------- 用例 2:防除零 / 空单 ----------
const c0 = Calc.compute({ rows: [], potBottom: 0, potTop: 0, tonPrice: '', startMold: '', endMold: '' });
assert.strictEqual(c0.bottom.qtyTotal, 0);
assert.strictEqual(c0.bottom.amountTotal, 0);
assert.strictEqual(c0.listTotals.usageKg, 0);
assert.strictEqual(c0.listTotals.usageAmount, 0);
assert.strictEqual(c0.calc.costTotal1, 0);
assert.strictEqual(c0.calc.costTotal2, 0);
assert.strictEqual(c0.calc.mold, null);
// 空行占比不报错
const c1 = Calc.compute({ rows: [{ id: 'x', name: '染料', zone: '面料', qtyPerPot: 0, price: 0, stockOnHand: 0, stockIn: 0, qty: 0 }], potBottom: 0, potTop: 0 });
assert.strictEqual(c1.top.rows[0].ratio, 0);

// ---------- 用例 3:单价一致性(本期用料单价 = 单价) ----------
assert.strictEqual(c.rows[0].usagePrice, c.rows[0].price);

console.log('✅ calc.js 全部单元测试通过');
