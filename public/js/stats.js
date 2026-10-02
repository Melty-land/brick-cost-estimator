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

    // 先按时间段 + 产品筛选批次(材料筛选不参与批次筛选)
    const screened = [];
    estimates.forEach(function (est) {
      const date = est.startDate || '';
      // 时间段:无日期的批次不纳入时间段筛选(避免误纳入)
      if (from && (!date || date < from)) return;
      if (to && (!date || date > to)) return;
      const mp = matchProduct(est, products);
      if (types.length && types.indexOf(mp.name) < 0) return;
      screened.push({ est: est, date: date, mp: mp });
    });

    // 全局最新命中批次(日期最大;空日期视为最早)→ 用于「最新批次结存」列
    let latest = null;
    screened.forEach(function (s) {
      if (!latest) { latest = s; return; }
      if ((s.date || '') > (latest.date || '')) latest = s;
    });
    const latestMap = new Map();  // name -> 该批次内该材料结存合计
    if (latest) {
      const lc = CostCalc.compute(latest.est);
      (lc.rows || []).forEach(function (r) {
        const nm = r.name || '';
        latestMap.set(nm, (latestMap.get(nm) || 0) + num(r.stock));
      });
    }

    screened.forEach(function (s) {
      const est = s.est, date = s.date, mp = s.mp;
      const c = CostCalc.compute(est);
      const potB = num(est.potBottom);
      const potT = num(est.potTop);
      meta.estCount++;
      if (!mp.matched) meta.unmatched++;

      (c.rows || []).forEach(function (r) {
        const zone = r.zone === '面料' ? '面料' : '底料';
        const pots = zone === '面料' ? potT : potB;
        const usageKg = num(r.usageKg);
        const amount = num(r.usageAmount);
        const closing = num(r.stock);
        const name = r.name || '';

        // 剩余材料累计(全部材料;输出时再按材料筛选过滤)
        if (!stockMap.has(name)) {
          stockMap.set(name, { name: name, zone: zone, stockOnHand: 0, stockIn: 0, usageKg: 0, zones: {}, ids: {} });
        }
        const acc = stockMap.get(name);
        acc.stockOnHand += num(r.stockOnHand);
        acc.stockIn += num(r.stockIn);
        acc.usageKg += usageKg;
        acc.zones[zone] = 1;
        acc.ids[est.id || est.code || ''] = 1;

        // 明细:材料筛选只影响展示行(小计随展示行,保证界面数字与屏幕行一致)
        if (mats.length && mats.indexOf(name) < 0) return;
        meta.totalKg += usageKg;
        meta.totalAmount += amount;
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
          closing: closing,
          stockOnHand: num(r.stockOnHand),   // 原值,供界面 data 属性与核对
          stockIn: num(r.stockIn)
        });
      });
    });

    // 明细排序:日期降序(空日期视为最早)→ 产品编号升序 → 用料降序
    detail.sort(function (a, b) {
      const da = a.date || '', db = b.date || '';
      if (da !== db) return da < db ? 1 : -1;
      if (a.productCode !== b.productCode) return a.productCode < b.productCode ? -1 : 1;
      return b.usageKg - a.usageKg;
    });

    // 剩余材料:累计剩余升序(最缺在前);最新批次结存取全局最新命中批次(该批次不含此材料则为 null)
    const stock = Array.from(stockMap.values())
      .filter(function (s) { return !mats.length || mats.indexOf(s.name) >= 0; })
      .map(function (s) {
        const zones = Object.keys(s.zones).sort().join('/');
        return {
          name: s.name,
          zone: zones,
          stockOnHand: s.stockOnHand,
          stockIn: s.stockIn,
          usageKg: s.usageKg,
          closingTotal: s.stockOnHand + s.stockIn - s.usageKg,
          latestClosing: latestMap.has(s.name) ? latestMap.get(s.name) : null,
          estCount: Object.keys(s.ids).length
        };
      })
      .sort(function (a, b) { return a.closingTotal - b.closingTotal; });

    meta.rowCount = detail.length;
    return { detail: detail, stock: stock, meta: meta };
  }

  return { matchProduct: matchProduct, buildUsage: buildUsage };
});
