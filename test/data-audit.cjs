/**
 * 数据审计(检查库内估算单数据是否存在错误):
 *  1) 行字段完整性:单价 / 每锅数量 / 上存 / 进料 必须为数字
 *  2) 网格公式 vs 存储 calc 一致性:砖面积/体积、每平方重量、每立方重量、计划数、成本总价①②、吨价、每平方价
 *  3) 口径:材料清单数量 = 每锅数量 × 对应区锅数;成本① = 本期用料金额合计;② = 吨价×吨(与①复核)
 *  4) 量级合理性:实际数与计划数同量纲(比值 0.3~3);每平方价为正且非异常
 * 用法:node test/data-audit.cjs(需服务在跑;发现问题 exit 1 并逐条列出)
 */
'use strict';
const Sheet = require('../public/js/sheet.js');
const Calc = require('../public/js/calc.js');

const API = 'http://127.0.0.1:8237/';
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps == null ? 1e-6 : eps);
const isn = (v) => v !== '' && v !== null && v !== undefined && isFinite(Number(v));

async function main() {
  const login = await (await fetch(API + 'api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  })).json();
  if (!login.token) throw new Error('admin 登录失败');
  const d = await (await fetch(API + 'api/data', { headers: { Authorization: 'Bearer ' + login.token } })).json();
  const prods = d.products || [];
  const issues = [];
  const bad = (e, msg) => issues.push('[' + e.id + ' ' + (e.code || '') + '] ' + msg);

  for (const e of d.estimates || []) {
    // 1) 字段完整性
    (e.rows || []).forEach((r, i) => {
      const tag = '行' + (i + 1) + ' ' + r.name;
      if (!isn(r.price)) bad(e, tag + ' 单价非数字: ' + JSON.stringify(r.price));
      if (!isn(r.qtyPerPot)) bad(e, tag + ' 每锅数量非数字: ' + JSON.stringify(r.qtyPerPot));
      if (!isn(r.stockOnHand)) bad(e, tag + ' 上存材料非数字: ' + JSON.stringify(r.stockOnHand));
      if (!isn(r.stockIn)) bad(e, tag + ' 本期进料非数字: ' + JSON.stringify(r.stockIn));
    });
    if (!(e.rows || []).length) { bad(e, '无材料行'); continue; }

    // 2/3) 网格 vs calc
    const res = Sheet.evaluate(e, { f: {}, v: {} });
    const V = res.values, m = res.sheet.meta, c = Calc.compute(e);
    const ck = (label, got, want, eps) => { if (!near(got, want, eps)) bad(e, label + ' 不一致: 网格=' + got + ' 应为=' + want); };
    const L = Number(e.calc.length), W = Number(e.calc.width), H = Number(e.calc.height);
    const area = L * W / 1e6, vol = L * W * H / 1e9;
    ck('砖面积', V['H' + m.brickRow], area, 1e-9);
    ck('砖体积', V['J' + m.brickRow], vol, 1e-9);
    ck('每平方重量', V['H' + m.R1], Number(e.calc.perPieceWeight) / area, 1e-6);
    ck('每立方重量', V['J' + m.R1], Number(e.calc.perPieceWeight) / vol, 1e-4);
    ck('计划数', V['F' + m.R2], Number(e.calc.moldManual) * Number(e.calc.perModuleCount) * area, 1e-9);
    ck('成本总价①', V['B' + m.R4], c.calc.costTotal1, 1e-6);
    ck('成本总价②(vs①复核)', V['H' + m.R4], c.calc.costTotal1, 1e-6);
    const usageKg = c.listTotals.usageKg, amt = c.listTotals.usageAmount;
    ck('材料吨价', V['L' + m.R2], usageKg ? amt / usageKg * 1000 : '', 1e-6);
    const act = Number(e.calc.actualCount), plan = Number(e.calc.planCount);
    const denom = isn(e.calc.actualCount) && act !== 0 ? act : (isn(e.calc.planCount) ? plan : 0);
    if (denom) ck('每平方价', V['B' + m.R3], amt / denom, 1e-6);
    // 材料清单数量 = 每锅 × 对应锅数
    (e.rows || []).forEach((r, i) => {
      const zone = r.zone === '面料' ? Number(e.potTop) : Number(e.potBottom);
      ck('清单' + (i + 1) + ' ' + r.name + ' 本期用料数量', V['G' + (m.listStart + i)], Number(r.qtyPerPot) * zone, 1e-9);
    });

    // 4) 量级合理性
    if (!isn(e.calc.length) || !isn(e.calc.width) || !isn(e.calc.height)) bad(e, '砖规格(长/宽/高)未填写');
    if (!isn(e.calc.perPieceWeight)) bad(e, '每块重量未填写');
    if (!isn(e.calc.perModuleCount) || Number(e.calc.perModuleCount) <= 0) bad(e, '每模块数无效');
    if (!isn(e.calc.moldManual) || Number(e.calc.moldManual) <= 0) bad(e, '模数(手工)无效');
    if (isn(e.calc.actualCount) && plan > 0) {
      const r = act / plan;
      if (r > 3 || r < 0.3) bad(e, '成品率异常: 实际数/计划数 = ' + (r * 100).toFixed(1) + '%(疑单位不一致或量级错误)');
    }
    if (isn(e.calc.perSqmPrice) && !(Number(e.calc.perSqmPrice) > 0)) bad(e, '每平方价非正: ' + e.calc.perSqmPrice);
    const ton = Number(e.calc.tonPrice);
    if (isn(e.calc.tonPrice) && !(ton > 0)) bad(e, '材料吨价非正: ' + e.calc.tonPrice);
  }

  console.log('审计 ' + (d.estimates || []).length + ' 个估算单,发现问题 ' + issues.length + ' 条');
  issues.forEach((x) => console.log('  ✗ ' + x));
  if (issues.length) process.exit(1);
  console.log('✅ 数据审计通过:字段完整、公式与口径一致、量级合理');
}
main().catch((e) => { console.error('✗ 审计失败:', e.message); process.exit(1); });
