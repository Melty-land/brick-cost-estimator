/**
 * 图表模块(零依赖 SVG 手绘)—— 主界面"图表预览"页
 * 依赖: window.CostCalc
 * 提供:环形图(材料成本构成)、分组柱状图(批次成本总价对比)、
 *       折线图(批次成本趋势)、横向条形图(材料用量/金额汇总)
 */
(function (root) {
  'use strict';

  var PALETTE = ['#4c78a8', '#f58518', '#72b7b2', '#e45756', '#54a24b', '#eeca3b',
    '#b279a2', '#ff9da6', '#9d755d', '#bab0ac', '#6d4c9d', '#4c9d8f'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  /** 紧凑金额:>=1 万显示 x.xx万,否则千分位整数 */
  function fmtC(v) {
    v = num(v);
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + '万';
    return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  }
  function fmtFull(v) {
    return '¥' + num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTon(v) { return num(v).toFixed(3); }
  /** 公斤显示:整数不带小数,其余保留 2 位 */
  function fmtKg(v) {
    v = num(v);
    if (v === Math.round(v)) return v.toLocaleString('zh-CN');
    return v.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  /** 坐标轴刻度步长(1/2/5 进制) */
  function niceStep(max, n) {
    if (max <= 0) return 1;
    var raw = max / n;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
    return step * mag;
  }

  /** 汇总所有估算单的计算结果 */
  function computeAll(estimates) {
    return estimates.map(function (e) { return { e: e, c: CostCalc.compute(e) }; });
  }

  /**
   * 环形图:材料成本构成(本期用料金额)
   * @param items [{name, value}]
   * @param total 中心合计
   * @param estId 点击段跳转用
   */
  function donutHTML(items, total, estId) {
    var r = 84, sw = 34;
    var C = 2 * Math.PI * r;
    var valid = (items || []).filter(function (it) { return num(it.value) > 0; });
    var sum = valid.reduce(function (s, it) { return s + num(it.value); }, 0);
    if (sum <= 0) return '<div class="empty-hint">该批次暂无用料金额数据</div>';

    var segs = '', offset = 0;
    valid.forEach(function (it, i) {
      var len = num(it.value) / sum * C;
      segs += '<circle cx="110" cy="110" r="' + r + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] +
        '" stroke-width="' + sw + '" stroke-dasharray="' + (len - 1) + ' ' + (C - len + 1) + '"' +
        ' stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 110 110)" class="donut-seg"' +
        (estId ? ' data-chart-open="' + estId + '"' : '') + '></circle>';
      offset += len;
    });

    var legend = valid.map(function (it, i) {
      return '<div class="chart-legend-item">' +
        '<span class="swatch" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
        '<span class="l-name">' + esc(it.name) + '</span>' +
        '<span class="l-val">' + fmtFull(it.value) + '</span>' +
        '<span class="l-pct">' + (num(it.value) / sum * 100).toFixed(1) + '%</span></div>';
    }).join('');

    return '<div class="chart-wrap">' +
      '<svg viewBox="0 0 220 220" class="chart-svg donut-svg">' +
        '<circle cx="110" cy="110" r="' + r + '" fill="none" stroke="#e6e9ee" stroke-width="' + sw + '"></circle>' +
        segs +
        '<text x="110" y="104" text-anchor="middle" class="donut-total">' + fmtC(total) + '</text>' +
        '<text x="110" y="123" text-anchor="middle" class="donut-cap">合计金额(元)</text>' +
      '</svg>' +
      '<div class="chart-legend">' + legend + '</div></div>';
  }

  /**
   * 分组柱状图:各批次成本总价①/②
   * @param groups [{id, label:[主,副], a, b}]
   */
  function barHTML(groups) {
    var W = 860, H = 340, mL = 78, mR = 16, mT = 24, mB = 64;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var maxV = Math.max.apply(null, groups.map(function (g) { return Math.max(num(g.a), num(g.b)); })) || 1;
    var yMax = maxV * 1.12;
    var step = niceStep(yMax, 4);
    var n = groups.length;
    var groupW = plotW / n;
    var barW = Math.min(34, groupW * 0.30);
    var base = mT + plotH;
    var hOf = function (v) { return (num(v) / yMax) * plotH; };

    var grid = '';
    for (var t = 0; t <= yMax + 1e-9; t += step) {
      var yy = base - (t / yMax) * plotH;
      grid += '<line x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '" class="grid-line"></line>' +
        '<text x="' + (mL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" class="axis-label">' + fmtC(t) + '</text>';
    }

    var bars = '';
    groups.forEach(function (g, i) {
      var cx = mL + groupW * i + groupW / 2;
      var h1 = hOf(g.a), h2 = hOf(g.b);
      var x1 = cx - barW - 2, x2 = cx + 2;
      bars += '<rect x="' + x1 + '" y="' + (base - h1) + '" width="' + barW + '" height="' + Math.max(h1, 1) + '" fill="#4c78a8" rx="2" data-chart-open="' + g.id + '" class="bar"></rect>' +
        '<rect x="' + x2 + '" y="' + (base - h2) + '" width="' + barW + '" height="' + Math.max(h2, 1) + '" fill="#f58518" rx="2" data-chart-open="' + g.id + '" class="bar"></rect>';
      if (h1 > 14) bars += '<text x="' + (x1 + barW / 2) + '" y="' + (base - h1 - 4) + '" text-anchor="middle" class="bar-val">' + fmtC(g.a) + '</text>';
      if (h2 > 14) bars += '<text x="' + (x2 + barW / 2) + '" y="' + (base - h2 - 4) + '" text-anchor="middle" class="bar-val">' + fmtC(g.b) + '</text>';
      bars += '<text x="' + cx + '" y="' + (base + 16) + '" text-anchor="middle" class="x-label">' + esc(g.label[0]) + '</text>' +
        (g.label[1] ? '<text x="' + cx + '" y="' + (base + 30) + '" text-anchor="middle" class="x-label dim">' + esc(g.label[1]) + '</text>' : '');
    });

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">' + grid + bars +
      '<line x1="' + mL + '" y1="' + base + '" x2="' + (W - mR) + '" y2="' + base + '" class="axis-line"></line>' +
      '<line x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + base + '" class="axis-line"></line></svg>';
  }

  /**
   * 折线图:批次成本总价趋势(调用方按时间排序)
   * @param series [{id, label:[主,副], a, b}]
   */
  function lineHTML(series) {
    var W = 860, H = 340, mL = 78, mR = 16, mT = 24, mB = 56;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var maxV = Math.max.apply(null, series.map(function (s) { return Math.max(num(s.a), num(s.b)); })) || 1;
    var yMax = maxV * 1.12;
    var step = niceStep(yMax, 4);
    var n = series.length;
    var base = mT + plotH;
    var x = function (i) { return n <= 1 ? mL + plotW / 2 : mL + (plotW * i) / (n - 1); };
    var yOf = function (v) { return base - (num(v) / yMax) * plotH; };

    var grid = '';
    for (var t = 0; t <= yMax + 1e-9; t += step) {
      var yy = base - (t / yMax) * plotH;
      grid += '<line x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '" class="grid-line"></line>' +
        '<text x="' + (mL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" class="axis-label">' + fmtC(t) + '</text>';
    }

    function poly(key, color) {
      var pts = series.map(function (s, i) { return x(i) + ',' + yOf(s[key]); }).join(' ');
      var marks = series.map(function (s, i) {
        return '<circle cx="' + x(i) + '" cy="' + yOf(s[key]) + '" r="4" fill="' + color + '" data-chart-open="' + s.id + '" class="dot"></circle>';
      }).join('');
      return '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2.5"></polyline>' + marks;
    }

    var labels = series.map(function (s, i) {
      return '<text x="' + x(i) + '" y="' + (base + 16) + '" text-anchor="middle" class="x-label">' + esc(s.label[0]) + '</text>' +
        (s.label[1] ? '<text x="' + x(i) + '" y="' + (base + 30) + '" text-anchor="middle" class="x-label dim">' + esc(s.label[1]) + '</text>' : '');
    }).join('');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">' + grid +
      poly('a', '#4c78a8') + poly('b', '#f58518') + labels +
      '<line x1="' + mL + '" y1="' + base + '" x2="' + (W - mR) + '" y2="' + base + '" class="axis-line"></line>' +
      '<line x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + base + '" class="axis-line"></line></svg>';
  }

  /**
   * 横向条形图:材料汇总
   * @param items [{name, value}] 已按值降序
   * @param unit 'kg' | 'amount'
   */
  function hbarHTML(items, unit) {
    var W = 860, mL = 140, mR = 110, mT = 8;
    var rowH = 26;
    var H = mT + items.length * rowH + 8;
    var plotW = W - mL - mR;
    var maxV = Math.max.apply(null, items.map(function (it) { return num(it.value); })) || 1;
    var rows = items.map(function (it, i) {
      var w = maxV > 0 ? (num(it.value) / maxV) * plotW : 0;
      var yv = mT + i * rowH + 4;
      var valText = unit === 'kg' ? fmtKg(it.value) + ' 公斤' : fmtC(it.value) + ' 元';
      return '<text x="' + (mL - 10) + '" y="' + (yv + 13) + '" text-anchor="end" class="h-label">' + esc(it.name) + '</text>' +
        '<rect x="' + mL + '" y="' + yv + '" width="' + Math.max(w, 2) + '" height="17" rx="2" fill="' + PALETTE[i % PALETTE.length] + '" class="hbar"></rect>' +
        '<text x="' + (mL + w + 6) + '" y="' + (yv + 13) + '" class="h-val">' + valText + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">' + rows + '</svg>';
  }

  root.Charts = {
    donutHTML: donutHTML, barHTML: barHTML, lineHTML: lineHTML, hbarHTML: hbarHTML,
    computeAll: computeAll, fmtFull: fmtFull, fmtTon: fmtTon, fmtKg: fmtKg, esc: esc
  };
})(window);
