/**
 * sheet.js 一致性测试:网格默认公式的求值结果必须与本系统 CostCalc 输出一致(元/吨换算、占比按数量、模数与成本总价)。
 * 运行:node test/sheet.test.cjs
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Sheet = require('../public/js/sheet.js');
const Calc = require('../public/js/calc.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));

function near(a, b, eps) {
  assert.ok(Math.abs(a - b) < (eps || 1e-6), `期望 ${a} ≈ ${b}`);
}

for (const e of data.estimates) {
  const res = Sheet.evaluate(e, { f: {}, v: {} });
  const V = res.values;
  const m = res.sheet.meta;
  const c = Calc.compute(e);

  const bottomRows = c.bottom.rows, topRows = c.top.rows;
  const b0 = bottomRows[0], t0 = topRows[0];
  const black = c.rows.find((r) => r.name === '黑水泥');
  const white = c.rows.find((r) => r.name === '白水泥');

  // 配比区金额 E/K = 单价×数量(公斤,不做/1000 换算)
  const bSumE = bottomRows.reduce((s, r) => s + r.qtyPerPot * r.price, 0);
  const tSumK = topRows.reduce((s, r) => s + r.qtyPerPot * r.price, 0);
  near(V['E' + res.sheet.meta.zoneStart], b0.qtyPerPot * b0.price, 1e-9);
  near(V['K' + res.sheet.meta.zoneStart], t0.qtyPerPot * t0.price, 1e-9);
  // 合计行 B/H = 金额合计(无换算)
  near(V['B' + m.sumRow], bSumE, 1e-9);
  near(V['H' + m.sumRow], tSumK, 1e-9);
  // 配比占比(跨底/面料,每锅×锅数占总和)应与材料清单"本期用料数量占比"一致
  near(V['F' + res.sheet.meta.zoneStart], black.ratio, 1e-9);
  near(V['L' + res.sheet.meta.zoneStart], white.ratio, 1e-9);

  // 材料清单:库存/金额/单价联动/本期用料数量/金额/占比
  near(V['E' + m.listStart], black.stock, 1e-9);
  near(V['H' + m.listStart], black.amount, 1e-9);
  near(V['I' + m.listStart], black.price, 1e-9);
  near(V['J' + m.listStart], black.usageTon, 1e-9);
  near(V['K' + m.listStart], black.usageAmount, 1e-9);
  near(V['L' + m.listStart], black.ratio, 1e-9);
  // 面料第一行:白水泥
  const wlIdx = m.listStart + c.bottom.rows.length; // 底料在前
  near(V['J' + wlIdx], white.usageTon, 1e-9);
  near(V['K' + wlIdx], white.usageAmount, 1e-9);
  // 合计行
  near(V['J' + m.listSumRow], c.listTotals.usageTon, 1e-9);
  near(V['K' + m.listSumRow], c.listTotals.usageAmount, 1e-9);

  // 成本核算:模数 & 成本总价①②(模数公式格位于 H 列)
  near(V['H' + m.R3], c.calc.mold, 1e-9);
  near(V['B' + m.R4], c.calc.costTotal1, 1e-6);
  near(V['H' + m.R4], c.calc.costTotal2, 1e-6);

  // 砖长宽高 -> 面积/体积 及派生公式(每平方重量/每立方重量/每托重量/计划数/成品率)
  const area = V['H' + m.brickRow];      // 长×宽÷1e6 (m²)
  const vol = V['J' + m.brickRow];       // 长×宽×高÷1e9 (m³)
  near(area, 0.0276, 1e-9);
  near(vol, 0.0014628, 1e-9);
  const perPiece = Number(e.calc.perPieceWeight);
  near(V['H' + m.R1], perPiece / area, 1e-6);   // 每平方重量 = 每块重量/面积
  near(V['J' + m.R1], perPiece / vol, 1e-4);    // 每立方重量 = 每块重量/体积
  near(V['D' + m.R2], Number(e.calc.perPalletSqm) * V['H' + m.R1], 1e-6); // 每托重量 = 每托平方×每平方重量
  near(V['F' + m.R2], Number(e.calc.moldManual) * Number(e.calc.perModuleCount) * area, 1e-9); // 计划数 = 模数×每模块数×单砖面积
  assert.strictEqual(V['J' + m.R2], '');        // 实际数为空 -> 成品率空

  console.log('✓ ' + e.id + ' 网格默认公式与 CostCalc 完全一致(底料合计 ' + V['B' + m.sumRow].toFixed(2) +
    ' / 面料 ' + V['H' + m.sumRow].toFixed(2) + ' / 用量 ' + V['J' + m.listSumRow].toFixed(2) +
    ' 公斤 / ①' + V['B' + m.R4].toFixed(2) + ' / ②' + V['H' + m.R4].toFixed(2) + ' / 模数 ' + V['H' + m.R3] + ')');
}

// ---------- 覆盖公式测试 ----------
const e1 = data.estimates[0];
// 覆盖黑水泥金额公式(打 9 折):=C6*D6*0.9 -> 100000*0.9=90000,合计减少 10000(配比区首行现为第 6 行)
{
  const res = Sheet.evaluate(e1, { f: { E6: '=C6*D6*0.9' }, v: {} });
  near(res.values.E6, 90000, 1e-9);
  const plain = Sheet.evaluate(e1, { f: {}, v: {} });
  near(plain.values.B13 - res.values.B13, 10000, 1e-9);
  console.log('✓ 覆盖公式:黑水泥金额 =C6*D6*0.9 = 90000,合计联动 B13 减少 10000');
}
// 覆盖输入格为公式:D6(黑水泥 200kg) -> 用 =D7(3-6 的 150kg),黑水泥金额 = 500*150 = 75000
{
  const res = Sheet.evaluate(e1, { f: { D6: '=D7' }, v: {} });
  near(res.values.E6, 75000, 1e-9);
  console.log('✓ 输入格可覆盖公式:D6=D7 后 E6 = C6*150 = 75000');
}
// 循环检测
{
  const res = Sheet.evaluate(e1, { f: { E6: '=F6*2', F6: '=E6/10' }, v: {} });
  assert.strictEqual(res.values.E6.err, '#CYCLE!');
  assert.strictEqual(res.values.F6.err, '#CYCLE!');
  console.log('✓ 循环引用:E6<->F6 均标记 #CYCLE!');
}
// 空估算单不崩
{
  const res = Sheet.evaluate({ rows: [], potBottom: '', potTop: '', calc: {}, name: '' }, { f: {}, v: {} });
  assert.ok(res.sheet.meta.maxRow > 0);
  console.log('✓ 空估算单网格可构建与求值(maxRow=' + res.sheet.meta.maxRow + ')');
}
// 布局坐标(种子数据 5底/6面/11清单;含新增砖规格行后整体下移一行):配比行6-11/锅数12/合计13/清单17-27/合计28
{
  const m = Sheet.evaluate(e1, { f: {}, v: {} }).sheet.meta;
  assert.strictEqual(m.zoneStart, 6);
  assert.strictEqual(m.potRow, 12);
  assert.strictEqual(m.sumRow, 13);
  assert.strictEqual(m.listStart, 17);
  assert.strictEqual(m.listSumRow, 28);
  console.log('✓ 布局坐标与原始表一致(配比行5-10/锅数11/合计12/清单16-26/合计27)');
}

console.log('✅ sheet.js 全部一致性测试通过');
