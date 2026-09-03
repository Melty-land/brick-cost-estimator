/**
 * 预算表工作表 —— 把估算单映射为 A–L 版式的可编辑网格,
 * 版式与《砖成本材料预算表_黑白打印版.xlsx》一致(标题/表头/底料·面料配比/材料清单/成本核算)。
 *
 * 计算列的默认公式与本系统计算口径一致:
 *   - 单价 = 元/公斤(用户录入,如 0.258 元/kg = 258 元/吨);数量 = 公斤
 *   - 金额 = 单价×数量(公斤),直乘不换算
 *   - 材料吨价(元/吨) = 本期用料金额合计 ÷ 本期用料数量合计 × 1000
 *   - 占比一律按"使用数量"口径;模数 = 止模-始模+1;成本总价①/② 双口径
 * 默认公式可被用户覆盖(随估算单持久化),覆盖后仍可被引用/重算。
 *
 * 浏览器:window.Sheet(依赖 window.Formula);Node:module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./formula.js'));
  else root.Sheet = factory(root.Formula);
})(typeof self !== 'undefined' ? self : this, function (Formula) {
  'use strict';

  var COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  var COL_COUNT = 12;
  var TITLE = '浙江陆创新材料科技有限公司砖成本材料预算表';

  function key(col, row) { return col + row; }

  // ---- 必填项定义(用户确认:表头/材料单价数量/锅数/部分成本核算参数) ----
  var REQUIRED_PATHS = {
    name: 1, code: 1, startDate: 1, endDate: 1, author: 1,
    potBottom: 1, potTop: 1,
    'calc.length': 1, 'calc.width': 1, 'calc.height': 1,
    'calc.perPieceWeight': 1, 'calc.perModuleCount': 1, 'calc.moldManual': 1,
    'calc.perPalletCount': 1, 'calc.perPalletSqm': 1
  };
  var PATH_LABELS = {
    name: '名称规格', code: '预算表编号', startDate: '开始日期', endDate: '结束日期', author: '编制人',
    potBottom: '底料锅数', potTop: '面料锅数',
    'calc.length': '砖长', 'calc.width': '砖宽', 'calc.height': '砖高',
    'calc.perPieceWeight': '每块重量', 'calc.perModuleCount': '每模块数', 'calc.moldManual': '模数',
    'calc.perPalletCount': '每托块数', 'calc.perPalletSqm': '每托平方'
  };
  function isRequiredPath(path) {
    if (REQUIRED_PATHS[path]) return true;
    return /^rows\.\d+\.(price|qtyPerPot)$/.test(path);
  }
  function pathToLabel(path) {
    if (PATH_LABELS[path]) return PATH_LABELS[path];
    var m = /^rows\.(\d+)\.(price|qtyPerPot)$/.exec(path);
    if (m) return '材料' + (Number(m[1]) + 1) + (m[2] === 'price' ? '单价' : '每锅数量');
    return path;
  }
  function numOrBlank(v) {
    if (v === null || v === undefined || v === '') return '';
    var n = Number(v);
    return isFinite(n) ? n : String(v);
  }
  function getByPath(obj, path) {
    var parts = path.split('.');
    var o = obj;
    for (var i = 0; i < parts.length && o != null; i++) o = o[parts[i]];
    return o;
  }
  var NUM_TEXT = /^-?\d*\.?\d+$/;

  /**
   * 由估算单构建网格。
   * @returns { rows: [[cellDef|null x12]], addrCells: {addr: def}, meta }
   * cellDef: { addr, kind:'label'|'blank'|'input'|'formula', text?, path?, v?, f?, span?, cls?, inputType? }
   */
  function buildSheet(est) {
    est = est || {};
    var rowsArr = est.rows || [];
    var bottom = [], top = [];
    rowsArr.forEach(function (r, i) {
      if (r.zone === '面料') top.push({ r: r, i: i });
      else bottom.push({ r: r, i: i });
    });
    var bCount = bottom.length, tCount = top.length;
    var Z = Math.max(bCount, tCount);

    var addrCells = {};
    function mk(col, row, def) {
      if (col < 0 || col >= COL_COUNT) return null;
      def.addr = COLS[col] + row;
      addrCells[def.addr] = def;
      return def;
    }
    function lab(col, row, text, cls, span) {
      return mk(col, row, { kind: 'label', text: text, cls: cls || 'lab', span: span || 1 });
    }
    function inp(col, row, path, v, inputType, span) {
      var def = { kind: 'input', path: path, v: v, inputType: inputType || 'num', span: span || 1, cls: 'in' };
      if (isRequiredPath(path)) def.required = true;
      return mk(col, row, def);
    }
    function fx(col, row, f, span, isPct, derive) {
      return mk(col, row, { kind: 'formula', f: f, span: span || 1, cls: 'fx', pct: !!isPct, derive: derive });
    }

    var rows = [];
    function addRow() {
      var row = [];
      for (var c = 0; c < COL_COUNT; c++) row.push(null);
      rows.push(row);
      return rows.length;
    }
    function place(r, col, def) {
      if (def) {
        rows[r - 1][col] = def;
        if (def.span > 1) for (var c = col + 1; c < col + def.span && c < COL_COUNT; c++) rows[r - 1][c] = null;
      }
    }

    // ===== 行 1:标题 =====
    var r = addRow();
    place(r, 0, { kind: 'label', text: TITLE, span: COL_COUNT, cls: 'title' });

    // ===== 行 2:表头信息(名称规格 | 预算表编号 | 开始日期 | 结束日期 | 编制人) =====
    r = addRow();
    place(r, 0, lab(0, r, '名称规格', 'lab', 1));
    place(r, 1, inp(1, r, 'name', est.name != null ? String(est.name) : '', 'text', 1));
    place(r, 2, lab(2, r, '预算表编号', 'lab', 1));
    place(r, 3, inp(3, r, 'code', est.code != null ? String(est.code) : '', 'text', 1));
    place(r, 4, lab(4, r, '开始日期', 'lab', 1));
    place(r, 5, inp(5, r, 'startDate', est.startDate || '', 'date', 2));
    place(r, 7, lab(7, r, '结束日期', 'lab', 1));
    place(r, 8, inp(8, r, 'endDate', est.endDate || '', 'date', 2));
    place(r, 10, lab(10, r, '编制人', 'lab', 1));
    place(r, 11, inp(11, r, 'author', est.author || '', 'text', 1));

    // ===== 行 3:每块砖规格(长/宽/高 手动必填;面积/体积自动) =====
    r = addRow();
    var brickRow = r;
    place(r, 0, lab(0, r, '砖长(mm)', 'lab', 1));
    place(r, 1, inp(1, r, 'calc.length', numOrBlank(getByPath(est, 'calc.length')), 'num', 1));
    place(r, 2, lab(2, r, '砖宽(mm)', 'lab', 1));
    place(r, 3, inp(3, r, 'calc.width', numOrBlank(getByPath(est, 'calc.width')), 'num', 1));
    place(r, 4, lab(4, r, '砖高(mm)', 'lab', 1));
    place(r, 5, inp(5, r, 'calc.height', numOrBlank(getByPath(est, 'calc.height')), 'num', 1));
    place(r, 6, lab(6, r, '砖面积(m²)', 'lab', 1));
    place(r, 7, fx(7, r, '=IF(B' + brickRow + '*D' + brickRow + '=0,"",B' + brickRow + '*D' + brickRow + '/1000000)'));
    place(r, 8, lab(8, r, '砖体积(m³)', 'lab', 1));
    place(r, 9, fx(9, r, '=IF(B' + brickRow + '*D' + brickRow + '*F' + brickRow + '=0,"",B' + brickRow + '*D' + brickRow + '*F' + brickRow + '/1000000000)'));

    // ===== 行 4-5:配比区标题与表头 =====
    r = addRow();
    place(r, 0, lab(0, r, '底料配比(单位:公斤)', 'sech', 6));
    place(r, 6, lab(6, r, '面料配比(单位:公斤)', 'sech', 6));
    r = addRow();
    ['序号', '材料名称', '单价', '数量', '金额', '占比'].forEach(function (h, i) {
      place(r, i, lab(i, r, h, 'hdr', 1));
      place(r, i + 6, lab(i + 6, r, h, 'hdr', 1));
    });

    // ===== 行 5..:配比数据 =====
    var zoneStart = r + 1;
    var zoneEnd = zoneStart + Math.max(Z - 1, 0);
    var potRow = zoneEnd + 1; // 锅数行行号(占比公式需要引用锅数)
    var bLast = zoneStart + Math.max(bCount, 1) - 1;   // 底料数量列(D)末行
    var tLast = zoneStart + Math.max(tCount, 1) - 1;   // 面料数量列(J)末行
    // 全材料总用量分母 = 底料每锅×底料锅数 + 面料每锅×面料锅数
    var DEN = '($B$' + potRow + '*SUM(D$' + zoneStart + ':D$' + bLast + ')+$H$' + potRow + '*SUM(J$' + zoneStart + ':J$' + tLast + '))';
    for (var zr = zoneStart; zr <= zoneEnd; zr++) {
      r = addRow();
      var bi = zr - zoneStart, ti = zr - zoneStart;
      if (bi < bCount) {
        var b = bottom[bi];
        place(r, 0, lab(0, r, String(bi + 1), 'seq', 1));
        place(r, 1, lab(1, r, b.r.name, 'mat', 1));
        place(r, 2, inp(2, r, 'rows.' + b.i + '.price', numOrBlank(b.r.price), 'num', 1));
        place(r, 3, inp(3, r, 'rows.' + b.i + '.qtyPerPot', numOrBlank(b.r.qtyPerPot), 'num', 1));
        place(r, 4, fx(4, r, '=C' + zr + '*D' + zr, 1));                       // 金额 = 单价×数量(公斤,不换算)
        place(r, 5, fx(5, r, '=IF(' + DEN + '=0,0,D' + zr + '*$B$' + potRow + '/' + DEN + ')', 1, true));
      }
      if (ti < tCount) {
        var t = top[ti];
        place(r, 6, lab(6, r, String(bCount + ti + 1), 'seq', 1));
        place(r, 7, lab(7, r, t.r.name, 'mat', 1));
        place(r, 8, inp(8, r, 'rows.' + t.i + '.price', numOrBlank(t.r.price), 'num', 1));
        place(r, 9, inp(9, r, 'rows.' + t.i + '.qtyPerPot', numOrBlank(t.r.qtyPerPot), 'num', 1));
        place(r, 10, fx(10, r, '=I' + zr + '*J' + zr, 1));                     // 金额 = 单价×数量(公斤,不换算)
        place(r, 11, fx(11, r, '=IF(' + DEN + '=0,0,J' + zr + '*$H$' + potRow + '/' + DEN + ')', 1, true));
      }
    }

    // ===== 锅数行 =====
    r = addRow();
    place(r, 0, lab(0, r, '底料锅数', 'lab', 1));
    place(r, 1, inp(1, r, 'potBottom', numOrBlank(est.potBottom), 'num', 5));
    place(r, 6, lab(6, r, '面料锅数', 'lab', 1));
    place(r, 7, inp(7, r, 'potTop', numOrBlank(est.potTop), 'num', 5));

    // ===== 配比合计行 =====
    var sumRow = potRow + 1;
    r = addRow();
    place(r, 0, lab(0, r, '底料合计', 'lab', 1));
    place(r, 1, fx(1, r, '=SUM(E' + zoneStart + ':E' + (zoneStart + Math.max(bCount, 1) - 1) + ')', 5));
    place(r, 6, lab(6, r, '面料合计', 'lab', 1));
    place(r, 7, fx(7, r, '=SUM(K' + zoneStart + ':K' + (zoneStart + Math.max(tCount, 1) - 1) + ')', 5));

    // ===== 材料清单(单位:公斤) =====
    r = addRow(); // 空行
    r = addRow();
    place(r, 0, lab(0, r, '材料清单(单位:公斤)', 'sech', 12));
    r = addRow();
    var listCols = ['序号', '材料名称', '上存材料(公斤)', '本期进料(公斤)', '库存材料(公斤)', '单价', '数量(公斤)', '金额', '本期用料单价', '本期用料数量(公斤)', '本期用料金額', '占比'];
    listCols.forEach(function (h, i) { place(r, i, lab(i, r, h, 'hdr', 1)); });

    var list = bottom.concat(top);
    var listStart = r + 1;
    var listEnd = listStart + list.length - 1;
    var listSumRow = list.length ? listEnd + 1 : null;

    list.forEach(function (item, li) {
      r = addRow();
      var isBottom = item.r.zone !== '面料';
      var zr2 = zoneStart + (isBottom ? bottom.indexOf(item) : top.indexOf(item));
      var qtyCol = isBottom ? 'D' : 'J';
      var potCol = isBottom ? 'B' : 'H';
      place(r, 0, lab(0, r, String(li + 1), 'seq', 1));
      place(r, 1, lab(1, r, item.r.name, 'mat', 1));
      place(r, 2, inp(2, r, 'rows.' + item.i + '.stockOnHand', numOrBlank(item.r.stockOnHand), 'num', 1));
      place(r, 3, inp(3, r, 'rows.' + item.i + '.stockIn', numOrBlank(item.r.stockIn), 'num', 1));
      place(r, 4, fx(4, r, '=C' + r + '+D' + r, 1));
      place(r, 5, fx(5, r, '=' + (isBottom ? 'C' : 'I') + zr2, 1));
      place(r, 6, inp(6, r, 'rows.' + item.i + '.qty', numOrBlank(item.r.qty), 'num', 1));
      place(r, 7, fx(7, r, '=F' + r + '*G' + r, 1));
      place(r, 8, fx(8, r, '=F' + r, 1));
      place(r, 9, fx(9, r, '=' + qtyCol + zr2 + '*$' + potCol + potRow, 1));  // 本期用料数量(公斤)=配比×锅数,不换算
      place(r, 10, fx(10, r, '=I' + r + '*J' + r, 1));
      place(r, 11, fx(11, r, '=IF(J' + r + '=0,0,J' + r + '/$J$' + listSumRow + ')', 1, true));
    });

    // ===== 材料清单合计行 =====
    if (list.length) {
      r = addRow();
      place(r, 0, lab(0, r, '合计', 'lab', 2));
      var sumCols = [2, 3, 4, 6, 7, 9, 10, 11];
      sumCols.forEach(function (c) {
        place(r, c, fx(c, r, '=SUM(' + COLS[c] + listStart + ':' + COLS[c] + listEnd + ')', 1));
      });
    }

    // ===== 成本核算 =====
    r = addRow(); // 空行
    r = addRow();
    place(r, 0, lab(0, r, '成本核算', 'sech', 12));

    var R1 = r + 1;
    r = addRow();
    // 每块重量/每模块数/模数(手工)/每托块数 为手动;每平方重量、每立方重量按公式自动
    var perPiece = getByPath(est, 'calc.perPieceWeight');
    place(r, 0, lab(0, r, '每块重量(kg)', 'lab', 1));
    place(r, 1, inp(1, r, 'calc.perPieceWeight', numOrBlank(perPiece), 'num', 1));
    place(r, 2, lab(2, r, '每模块数', 'lab', 1));
    place(r, 3, inp(3, r, 'calc.perModuleCount', numOrBlank(getByPath(est, 'calc.perModuleCount')), 'num', 1));
    place(r, 4, lab(4, r, '模数(手工)', 'lab', 1));
    place(r, 5, inp(5, r, 'calc.moldManual', numOrBlank(getByPath(est, 'calc.moldManual')), 'num', 1));
    place(r, 6, lab(6, r, '每平方重量(kg)', 'lab', 1));
    place(r, 7, fx(7, r, '=IF(B' + R1 + '*H' + brickRow + '=0,"",B' + R1 + '/H' + brickRow + ')', 1, false, 'calc.perSqmWeight'));
    place(r, 8, lab(8, r, '每立方重量(kg)', 'lab', 1));
    place(r, 9, fx(9, r, '=IF(B' + R1 + '*J' + brickRow + '=0,"",B' + R1 + '/J' + brickRow + ')', 1, false, 'calc.perCubicWeight'));
    place(r, 10, lab(10, r, '每托块数', 'lab', 1));
    place(r, 11, inp(11, r, 'calc.perPalletCount', numOrBlank(getByPath(est, 'calc.perPalletCount')), 'num', 1));

    var R2 = r + 1;
    r = addRow();
    place(r, 0, lab(0, r, '每托平方', 'lab', 1));
    place(r, 1, inp(1, r, 'calc.perPalletSqm', numOrBlank(getByPath(est, 'calc.perPalletSqm')), 'num', 1));
    place(r, 2, lab(2, r, '每托重量(kg)', 'lab', 1));
    place(r, 3, fx(3, r, '=IF(B' + R2 + '*H' + R1 + '=0,"",B' + R2 + '*H' + R1 + ')', 1, false, 'calc.perPalletWeight'));
    place(r, 4, lab(4, r, '计划数', 'lab', 1));
    place(r, 5, fx(5, r, '=IF(F' + R1 + '*D' + R1 + '*H' + brickRow + '=0,"",F' + R1 + '*D' + R1 + '*H' + brickRow + ')', 1, false, 'calc.planCount'));
    place(r, 6, lab(6, r, '实际数', 'lab', 1));
    place(r, 7, inp(7, r, 'calc.actualCount', numOrBlank(getByPath(est, 'calc.actualCount')), 'num', 1));
    place(r, 8, lab(8, r, '成品率', 'lab', 1));
    place(r, 9, fx(9, r, '=IF(F' + R2 + '=0,"",IF(H' + R2 + '="","",H' + R2 + '/F' + R2 + '))', 1, true, 'calc.yieldRate'));
    place(r, 10, lab(10, r, '材料吨价(元/吨)', 'lab', 1));
    // 材料吨价 = 本期用料金额合计 ÷ 本期用料数量合计 × 1000(元/吨;单价按元/kg 录入,乘 1000 换算为吨价)
    place(r, 11, fx(11, r, '=IF(J' + (listSumRow || listStart) + '=0,"",K' + (listSumRow || listStart) + '/J' + (listSumRow || listStart) + '*1000)', 1, false, 'calc.tonPrice'));

    var R3 = r + 1;
    r = addRow();
    // 每平方价 = 本期用料金额合计 ÷ 实际数(实际数为空则用计划数)(自动)
    place(r, 0, lab(0, r, '每平方价', 'lab', 1));
    place(r, 1, fx(1, r, '=IF(H' + R2 + '="",IF(F' + R2 + '=0,"",K' + (listSumRow || listStart) + '/F' + R2 + '),K' + (listSumRow || listStart) + '/H' + R2 + ')', 1, false, 'calc.perSqmPrice'));
    place(r, 2, lab(2, r, '始模', 'lab', 1));
    place(r, 3, inp(3, r, 'calc.startMold', numOrBlank(getByPath(est, 'calc.startMold')), 'num', 1));
    place(r, 4, lab(4, r, '止模', 'lab', 1));
    place(r, 5, inp(5, r, 'calc.endMold', numOrBlank(getByPath(est, 'calc.endMold')), 'num', 1));
    place(r, 6, lab(6, r, '模数(自动)', 'lab', 1));
    place(r, 7, fx(7, r, '=IF(D' + R3 + '*F' + R3 + '=0,"",F' + R3 + '-D' + R3 + '+1)', 5));

    var R4 = r + 1;
    r = addRow();
    place(r, 0, lab(0, r, '成本总价①(本期用料金额合计)', 'lab', 1));
    place(r, 1, fx(1, r, '=K' + (listSumRow || listStart), 5));
    place(r, 6, lab(6, r, '成本总价②(材料吨价×用料总量·吨)', 'lab', 1));
    // ② = 材料吨价(元/吨) × 用料总量(吨 = 公斤/1000);默认与 ① 一致(交叉复核)
    place(r, 7, fx(7, r, '=L' + R2 + '*J' + (listSumRow || listStart) + '/1000', 5));

    var maxRow = r;

    return {
      rows: rows,
      addrCells: addrCells,
      meta: {
        maxRow: maxRow, brickRow: brickRow, zoneStart: zoneStart, zoneEnd: zoneEnd,
        potRow: potRow, sumRow: sumRow, R1: R1, R2: R2, R3: R3, R4: R4,
        listStart: listStart, listEnd: listEnd, listSumRow: listSumRow
      }
    };
  }

  /**
   * 求值网格(支持用户覆盖公式/静态值)。
   * @param est 估算单
   * @param overrides { f:{addr:公式文本}, v:{addr:静态值文本} }
   */
  function evaluate(est, overrides) {
    overrides = overrides || { f: {}, v: {} };
    var sheet = buildSheet(est);
    var addrCells = sheet.addrCells;

    // 公式单元格集合 = 默认公式列 + 被覆盖为公式的单元格
    var formulaAddrs = [];
    Object.keys(addrCells).forEach(function (a) {
      var d = addrCells[a];
      if (d.kind === 'formula' || overrides.f[a] !== undefined) formulaAddrs.push(a);
    });
    var effF = {};
    formulaAddrs.forEach(function (a) {
      effF[a] = overrides.f[a] !== undefined ? overrides.f[a] : addrCells[a].f;
    });

    // 依赖:depMap[a] = a 引用的其他公式单元格
    var depMap = {};
    formulaAddrs.forEach(function (a) { depMap[a] = []; });
    formulaAddrs.forEach(function (a) {
      Formula.parseRefs(effF[a]).forEach(function (ref) {
        if (ref !== a && formulaAddrs.indexOf(ref) >= 0) depMap[a].push(ref);
      });
    });

    // DFS 拓扑排序 + 环标记
    var state = {}, inCycle = {}, order = [], path = [];
    function dfs(a) {
      state[a] = 1;
      path.push(a);
      (depMap[a] || []).forEach(function (dep) {
        if (!state[dep]) dfs(dep);
        else if (state[dep] === 1) {
          var idx = path.indexOf(dep);
          for (var k = idx; k < path.length; k++) inCycle[path[k]] = 1;
        }
      });
      path.pop();
      state[a] = 2;
      if (!inCycle[a]) order.push(a);
    }
    formulaAddrs.forEach(function (a) { if (!state[a]) dfs(a); });

    var values = {};
    formulaAddrs.forEach(function (a) { if (inCycle[a]) values[a] = Formula.err('#CYCLE!'); });

    var ctx = {
      getValue: function (ref) {
        var a = String(ref).toUpperCase();
        if (Object.prototype.hasOwnProperty.call(values, a)) return values[a];
        if (overrides.v[a] !== undefined) {
          var t = String(overrides.v[a]);
          return NUM_TEXT.test(t) ? Number(t) : t;
        }
        var d = addrCells[a];
        if (!d) return null;
        if (d.kind === 'input') return (d.v === '' || d.v === null || d.v === undefined) ? null : d.v;
        if (d.kind === 'label') return d.text !== undefined ? d.text : null;
        return null;
      }
    };
    order.forEach(function (a) {
      values[a] = Formula.evalText(effF[a], ctx);
    });

    return {
      sheet: sheet, values: values, addrCells: addrCells, effF: effF,
      cycles: Object.keys(inCycle), formulaAddrs: formulaAddrs
    };
  }

  /** 单元格当前生效的公式文本(无覆盖且非公式列 -> null) */
  function effectiveFormula(def, overrides) {
    var a = def.addr;
    if (!overrides) return def.kind === 'formula' ? def.f : null;
    if (overrides.f[a]) return overrides.f[a];
    if (overrides.v[a] !== undefined) return null;
    return def.kind === 'formula' ? def.f : null;
  }

  return {
    buildSheet: buildSheet, evaluate: evaluate, effectiveFormula: effectiveFormula,
    COLS: COLS, COL_COUNT: COL_COUNT, TITLE: TITLE,
    isRequiredPath: isRequiredPath, pathToLabel: pathToLabel
  };
});
