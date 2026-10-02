/**
 * 用料明细与剩余材料聚合模块(纯计算,无 DOM 依赖,可在 Node 中单测)
 *
 * 浏览器暴露: window.Stats
 * Node 导出:   module.exports
 *
 * 口径(与预算表一致):
 *   本期用料数量 = 每锅数量 × 对应区锅数(公斤)
 *   期末结存     = 上存材料 + 本期进料 − 本期用料数量(可为负)
 *   占比         = 该行用料 ÷ 该批次本期用料数量合计
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'));
  else root.Stats = factory(root.CostCalc);
})(typeof self !== 'undefined' ? self : this, function (CostCalc) {
  'use strict';

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /**
   * 产品自动匹配(三级):productId → 名称规格 → 预算表编号
   * @returns {{ code:string, name:string, matched:boolean }}
   */
  function matchProduct(est, products) {
    const list = products || [];
    est = est || {};
    if (est.productId) {
      const byId = list.filter(function (p) { return p.id === est.productId; })[0];
      if (byId) return { code: byId.code || '', name: byId.name || '', matched: true };
    }
    if (est.name) {
      const byName = list.filter(function (p) { return p.name === est.name; })[0];
      if (byName) return { code: byName.code || '', name: byName.name || '', matched: true };
    }
    if (est.code) {
      const byCode = list.filter(function (p) { return p.code === est.code; })[0];
      if (byCode) return { code: byCode.code || '', name: byCode.name || '', matched: true };
    }
    return { code: est.code || '', name: '未匹配产品', matched: false };
  }

  /**
   * 构建用料明细与剩余材料
   * @param {{estimates:Array,products:Array,materials:Array}} data
   * @param {{from?:string,to?:string,types?:string[],mats?:string[]}} filter
   *        types = 产品名数组(空=全部);mats = 材料名数组(空=全部)
   * @returns {{ detail:Array, stock:Array, meta:Object }}
   */
  function buildUsage(data, filter) {
    data = data || {};
    filter = filter || {};
    const estimates = data.estimates || [];
    const products = data.products || [];
    const from = filter.from || '';
    const to = filter.to || '';
    const types = filter.types || [];
    const mats = filter.mats || [];

    const detail = [];
    const meta = { estCount: 0, rowCount: 0, totalKg: 0, totalAmount: 0, unmatched: 0 };
    const stockMap = new Map();   // name -> 累计
    const lastMap = new Map();    // name -> [{ date, closing }] 按批次

    estimates.forEach(function (est) {
      const date = est.startDate || '';
      // 时间段:无日期的批次不纳入时间段筛选(避免误纳入)
      if (from && (!date || date < from)) return;
      if (to && (!date || date > to)) return;
      const mp = matchProduct(est, products);
      if (types.length && types.indexOf(mp.name) < 0) return;

      const c = CostCalc.compute(est);
      const potB = num(est.potBottom);
      const potT = num(est.potTop);
      meta.estCount++;
      if (!mp.matched) meta.unmatched++;

      // 本批次内按材料合计(同材料跨区时用于最新批次结存)
      const perBatch = new Map();

      (c.rows || []).forEach(function (r) {
        const zone = r.zone === '面料' ? '面料' : '底料';
        const pots = zone === '面料' ? potT : potB;
        const usageKg = num(r.usageKg);
        const amount = num(r.usageAmount);
        const closing = num(r.stock);
        const name = r.name || '';

        // 小计:始终按全部材料统计(材料筛选不缩小合计)
        meta.totalKg += usageKg;
        meta.totalAmount += amount;

        // 剩余材料累计(全部材料;输出时再按材料筛选过滤)
        if (!stockMap.has(name)) {
          stockMap.set(name, { name: name, zone: zone, stockOnHand: 0, stockIn: 0, usageKg: 0, ids: {} });
        }
        const acc = stockMap.get(name);
        acc.stockOnHand += num(r.stockOnHand);
        acc.stockIn += num(r.stockIn);
        acc.usageKg += usageKg;
        acc.zone = acc.zone || zone;
        acc.ids[est.id || est.code || ''] = 1;

        if (!perBatch.has(name)) perBatch.set(name, 0);
        perBatch.set(name, perBatch.get(name) + closing);

        // 明细:材料筛选只影响展示行
        if (mats.length && mats.indexOf(name) < 0) return;
        detail.push({
          code: est.code || '',
          date: date,
          productCode: mp.code,
          productName: mp.name,
          materialName: name,
          zone: zone,
          qtyPerPot: num(r.qtyPerPot),
          pots: pots,
          usageKg: usageKg,
          price: num(r.price),
          amount: amount,
          ratio: num(r.ratio),
          closing: closing
        });
      });

      perBatch.forEach(function (closing, name) {
        if (!lastMap.has(name)) lastMap.set(name, []);
        lastMap.get(name).push({ date: date, closing: closing });
      });
    });

    // 明细排序:日期降序(空日期视为最早)→ 产品编号升序 → 用料降序
    detail.sort(function (a, b) {
      const da = a.date || '', db = b.date || '';
      if (da !== db) return da < db ? 1 : -1;
      if (a.productCode !== b.productCode) return a.productCode < b.productCode ? -1 : 1;
      return b.usageKg - a.usageKg;
    });

    // 剩余材料:累计剩余升序(最缺在前)
    const stock = Array.from(stockMap.values())
      .filter(function (s) { return !mats.length || mats.indexOf(s.name) >= 0; })
      .map(function (s) {
        const seq = (lastMap.get(s.name) || []).slice().sort(function (x, y) {
          const dx = x.date || '', dy = y.date || '';
          if (dx === dy) return 0;
          return dx < dy ? -1 : 1;
        });
        const last = seq.length ? seq[seq.length - 1].closing : null;
        return {
          name: s.name,
          zone: s.zone,
          stockOnHand: s.stockOnHand,
          stockIn: s.stockIn,
          usageKg: s.usageKg,
          closingTotal: s.stockOnHand + s.stockIn - s.usageKg,
          latestClosing: last,
          estCount: Object.keys(s.ids).length
        };
      })
      .sort(function (a, b) { return a.closingTotal - b.closingTotal; });

    meta.rowCount = detail.length;
    return { detail: detail, stock: stock, meta: meta };
  }

  return { matchProduct: matchProduct, buildUsage: buildUsage };
});
