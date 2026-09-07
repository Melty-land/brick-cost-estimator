/**
 * 砖成本材料预算 —— 纯计算模块(无 DOM 依赖,可在 Node 中直接单测)
 *
 * 浏览器暴露: window.CostCalc
 * Node 导出:  module.exports
 *
 * 单位约定(用户已确认):
 *   单价       = 元/公斤(录入 0.258 元/kg = 258 元/吨)
 *   配比数量   = 公斤/锅
 *   材料清单   = 公斤(全表公斤直乘,不换算)
 *   材料吨价   = 元/吨(自动 = 金额合计 ÷ 用量合计 × 1000)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CostCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZONES = { BOTTOM: '底料', TOP: '面料' };
  var KG_PER_TON = 1000;

  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** 安全除法:分母为 0 时返回 0 */
  function safeDiv(a, b) {
    a = num(a); b = num(b);
    return b === 0 ? 0 : a / b;
  }

  /** 期末库存材料 = 上存材料 + 本期进料 - 本期用料数量(公斤)(用户口径;可为负=用料超出库存) */
  function closingStock(stockOnHand, stockIn, usageKg) {
    return num(stockOnHand) + num(stockIn) - num(usageKg);
  }

  /**
   * 计算一个估算单的全部派生值。
   *
   * @param {object} est
   *   rows: [{ id, name, zone('底料'|'面料'), qtyPerPot(每锅公斤), price(元/吨),
   *            stockOnHand(上存,吨), stockIn(进料,吨), qty(清单数量G,吨) }]
   *   potBottom / potTop : 底料锅数 / 面料锅数
   *   tonPrice           : 材料吨价(元/吨,成本核算区手工输入)
   *   startMold / endMold: 始模 / 止模
   * @returns {{ rows, bottom, top, listTotals, calc }}
   *   bottom/top = 配比区:{ rows:[{...r, amount(元/锅), ratio}], qtyTotal, amountTotal }
   *   rows       = 材料清单:{...r, stock, amount, usageKg, usageTon, usagePrice, usageAmount, ratio}
   *   listTotals = 清单合计
   *   calc       = { mold, costTotal1, costTotal2 }
   */
  function compute(est) {
    est = est || {};
    var potBottom = num(est.potBottom);
    var potTop = num(est.potTop);
    var rows = (est.rows || []).map(function (r, i) {
      return {
        id: r.id,
        name: r.name,
        zone: r.zone === ZONES.TOP ? ZONES.TOP : ZONES.BOTTOM,
        idx: i,
        qtyPerPot: num(r.qtyPerPot),
        price: num(r.price),
        stockOnHand: num(r.stockOnHand),
        stockIn: num(r.stockIn),
        qty: num(r.qty)
      };
    });

    function zoneRows(z) {
      return rows.filter(function (r) { return r.zone === z; });
    }

    // ---- 配比区(每锅,数量:公斤;金额:元 = 单价×数量,全表按公斤直乘不换算) ----
    // 配比区占比口径与网格默认公式一致:每锅×锅数 ÷ (底料Σ×底锅 + 面料Σ×面锅),跨区按锅数加权
    function recipeSection(sectionRows, potCount, denom) {
      var qtyTotal = sectionRows.reduce(function (s, r) { return s + r.qtyPerPot; }, 0);
      var amountTotal = sectionRows.reduce(function (s, r) { return s + r.qtyPerPot * r.price; }, 0);
      return {
        rows: sectionRows.map(function (r) {
          return {
            id: r.id, name: r.name, zone: r.zone, idx: r.idx,
            qtyPerPot: r.qtyPerPot, price: r.price,
            amount: r.qtyPerPot * r.price,
            ratio: safeDiv(r.qtyPerPot * potCount, denom)   // 每锅×锅数 ÷ 全材料加权总和
          };
        }),
        qtyTotal: qtyTotal,
        amountTotal: amountTotal
      };
    }
    var bottomRows = zoneRows(ZONES.BOTTOM), topRows = zoneRows(ZONES.TOP);
    var qtyPotSum = function (zs, pot) { return zs.reduce(function (s, r) { return s + r.qtyPerPot * pot; }, 0); };
    var denomAll = qtyPotSum(bottomRows, potBottom) + qtyPotSum(topRows, potTop); // 跨区按锅数加权分母
    var bottom = recipeSection(bottomRows, potBottom, denomAll);
    var top = recipeSection(topRows, potTop, denomAll);

    // ---- 材料清单(公斤;全表公斤直乘,不换算) ----
    var list = rows.map(function (r) {
      var pot = r.zone === ZONES.BOTTOM ? potBottom : potTop;
      var usageKg = r.qtyPerPot * pot;          // 本期用料数量(公斤)= 每锅×锅数
      return {
        id: r.id, name: r.name, zone: r.zone, idx: r.idx,
        qtyPerPot: r.qtyPerPot, price: r.price,
        stockOnHand: r.stockOnHand, stockIn: r.stockIn, qty: r.qty,
        // 库存材料 = 上存材料 + 本期进料 - 本期用料数量(公斤)(用户口径;可为负)
        stock: closingStock(r.stockOnHand, r.stockIn, usageKg),
        amount: r.price * r.qty,                 // 金额 = 单价 × 数量(公斤)
        usageKg: usageKg,
        usageTon: usageKg,                        // 兼容旧字段名,现为公斤数值
        usagePrice: r.price,                      // 本期用料单价 = 单价
        usageAmount: r.price * usageKg,           // 本期用料金额(公斤直乘)
        ratio: 0
      };
    });
    var usageTotal = list.reduce(function (s, r) { return s + r.usageKg; }, 0);
    list.forEach(function (r) {
      r.ratio = safeDiv(r.usageKg, usageTotal);  // 占比按使用数量(公斤)口径
    });

    function sum(f) { return list.reduce(function (s, r) { return s + f(r); }, 0); }
    var listTotals = {
      stockOnHand: sum(function (r) { return r.stockOnHand; }),
      stockIn: sum(function (r) { return r.stockIn; }),
      stock: sum(function (r) { return r.stock; }),
      qty: sum(function (r) { return r.qty; }),
      amount: sum(function (r) { return r.amount; }),
      usageKg: usageTotal,
      usageTon: usageTotal,
      usageAmount: sum(function (r) { return r.usageAmount; }),
      ratio: sum(function (r) { return r.ratio; })
    };

    // ---- 成本核算区 ----
    // 成本核算字段在 UI 中存放于 est.calc.*;兼容旧数据也读顶层 est.*
    var calcFields = est.calc || {};
    var smRaw = calcFields.startMold !== undefined ? calcFields.startMold : est.startMold;
    var emRaw = calcFields.endMold !== undefined ? calcFields.endMold : est.endMold;
    var sm = (smRaw === '' || smRaw == null) ? null : num(smRaw);
    var em = (emRaw === '' || emRaw == null) ? null : num(emRaw);
    var mold = (sm !== null && em !== null) ? em - sm + 1 : null;

    var tonPriceRaw = calcFields.tonPrice !== undefined ? calcFields.tonPrice : est.tonPrice;
    var calc = {
      mold: mold,
      costTotal1: listTotals.usageAmount,                        // 口径①:本期用料金额合计
      // 口径②:材料吨价(元/吨) × 用料总量(吨 = 公斤/1000);与 ① 交叉一致
      costTotal2: num(tonPriceRaw) * listTotals.usageKg / 1000
    };

    return { rows: list, bottom: bottom, top: top, listTotals: listTotals, calc: calc };
  }

  return { compute: compute, safeDiv: safeDiv, num: num, ZONES: ZONES, KG_PER_TON: KG_PER_TON, closingStock: closingStock };
});
