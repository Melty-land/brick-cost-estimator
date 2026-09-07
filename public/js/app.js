/**
 * 砖成本估算系统 —— 前端主逻辑(材料管理 / 产品配方 / 估算单 / 历史对比)
 * 依赖: calc.js(计算)、store.js(数据层)
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  let data = null;                 // 全量数据 {materials, products, estimates, seq}
  let currentUser = null;          // 当前登录用户 {username,nickname,role}
  let currentView = 'materials';
  let editingProductId = null;     // 正在编辑的产品 id
  let productFormDraft = null;     // 产品表单草稿 {name, code, recipe:[{materialId,qtyPerPot}]}
  let estDraft = null;             // 估算单编辑草稿
  const compareSel = new Set();    // 对比勾选的估算单 id
  let chartEstId = null;           // 图表页环形图选中的估算单 id
  let chartMatMode = 'amount';     // 图表页材料汇总模式: 'amount' 金额 / 'kg' 用量(公斤)
  let lastChartsSig = null;        // 上次渲染的图表数据指纹(懒加载缓存)
  let lastChartId = null;          // 上次渲染时选中的估算单
  let lastMatMode = null;          // 上次渲染时的汇总模式
  let estDateFrom = '';            // 估算单列表日期筛选:开始日期(YYYY-MM-DD,空=不限)
  let estDateTo = '';              // 估算单列表日期筛选:结束日期(空=不限)
  // ---- 成本总揽 / 图表预览 共用筛选(2026-09)----
  let ovlFrom = '';                // 时间段:开始日期(含)
  let ovlTo = '';                  // 时间段:结束日期(含)
  let ovlTypes = [];               // 砖型(型号/名称)多选:空=全部
  let ovlMats = [];                // 材料名称多选:空=全部
  let ovlCur = 'overview';         // 当前筛选所属页(overview|charts),用于互相跳转时带同一筛选
  // ---- 表格编辑器(Excel 化)状态 ----
  let gridOverF = {};              // 单元格公式覆盖 {addr: '=...'}
  let gridOverV = {};              // 单元格静态覆盖 {addr: 文本}
  let gridSel = null;              // 当前选中单元格
  let gridCache = null;            // 最近一次 Sheet.evaluate 结果
  let gridDirty = false;           // 编辑器是否有未保存改动
  let gridPendingNav = null;       // 等待退出弹窗确认后跳转的目标(hash)

  // ---------- 工具 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(v, d) {
    const n = Number(v);
    if (!isFinite(n)) return '0';
    return n.toLocaleString('zh-CN', {
      minimumFractionDigits: d == null ? 2 : d,
      maximumFractionDigits: d == null ? 2 : d
    });
  }
  function pct(v) {
    const n = Number(v);
    const x = isFinite(n) ? n * 100 : 0;
    return x.toFixed(2) + '%';
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- 内联 SVG 图标集(零依赖;iOS 线性风格,stroke 当前色) ----------
  const ICON_PATHS = {
    'plus': '<path d="M12 5v14M5 12h14"/>',
    'trash': '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    'edit': '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 6l4 4"/>',
    'copy': '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    'back': '<path d="M15 5l-7 7 7 7"/>',
    'view': '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    'download': '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    'printer': '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6v-7z"/>',
    'upload': '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
    'camera': '<path d="M4 7h3l2-2h6l2 2h3v12H4V7z"/><circle cx="12" cy="13" r="3.5"/>',
    'inbox': '<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6zM3 13h5l2 2h4l2-2h5"/>',
    'search': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    'calendar': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    'chart': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'calc': '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
    'logout': '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
    'folder': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    'check': '<path d="M4 12l5 5L20 6"/>',
    'users': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5a3.5 3.5 0 0 1 0 7M17 20a6 6 0 0 0-2.2-4.7"/>'
  };
  /** 内联 SVG 图标(线性、1.8 描边、currentColor)。name 不存在时返回空。 */
  function icon(name, size) {
    const p = ICON_PATHS[name];
    if (!p) return '';
    const s = size || 15;
    return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  /** 按钮文本带图标:icon + 文字(无文本则纯图标) */
  function btnIcon(name, text) {
    return icon(name) + (text ? '<span>' + esc(text) + '</span>' : '');
  }

  /** 按路径写入: 'rows.0.qtyPerPot' / 'calc.tonPrice' */
  function setByPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur == null) return;
      cur = cur[parts[i]];
    }
    if (cur != null) cur[parts[parts.length - 1]] = value;
  }

  /** 当前正在编辑的草稿对象(估算单编辑器优先,否则产品表单) */
  function currentDraft() {
    const editor = document.getElementById('view-editor');
    if (editor && !editor.hidden) return estDraft;
    return productFormDraft;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /** 保存并刷新/提示;统一处理失败与登录过期(避免未捕获的 Promise 拒绝)。errFn 在失败时调用(用于恢复按钮态) */
  function saveAndRefresh(okFn, errFn) {
    Store.save().then(okFn || function () {}).catch(function (err) {
      toast('保存失败:' + (err && err.message ? err.message : '未知错误'));
      if (errFn) errFn();
      if (err && (err.status === 401 || err.status === 403)) handleAuthExpired();
    });
  }

  // ---------- 视图切换(hash 路由,支持深链) ----------
  function switchView(name) {
    if (name === 'users' && (!currentUser || currentUser.role !== 'admin')) {
      toast('仅管理员可访问用户管理');
      location.hash = '#estimates';
      return;
    }
    currentView = name;
    document.body.classList.toggle('editor-wide', name === 'editor');
    $$('.view').forEach(function (s) { s.hidden = s.id !== 'view-' + name; });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === name); });
    if (name === 'materials') renderMaterials();
    else if (name === 'products') renderProducts();
    else if (name === 'estimates') renderEstimates();
    else if (name === 'charts') renderCharts();
    else if (name === 'overview') renderOverview();
    else if (name === 'compare') renderCompare();
    else if (name === 'users') renderUsers();
  }

  let lastEditorHash = null; // 记录当前编辑的估算单 hash(用于 hashchange 脏守卫还原)
  /** 根据 location.hash 切换视图:#materials / #products / #estimates / #compare / #users / #estimate/<id> / #new-estimate[/<产品id>] */
  function applyHash() {
    // 未登录或数据未加载(登出/会话过期后 hash 变化)时不渲染业务视图
    if (!currentUser || !data) return;
    const h = location.hash.replace(/^#/, '');
    const parts = h.split('/');
    const name = parts[0];
    const id = parts[1];
    // 直接 hash 变化(浏览器后退/手动改地址)离开有未保存改动的编辑器时,弹三选,取消则还原
    const editorEl = document.getElementById('view-editor');
    if (editorEl && !editorEl.hidden && estDraft && gridDirty &&
        !(name === 'estimate' || name === 'new-estimate') && lastEditorHash && lastEditorHash !== location.hash) {
      gridPendingNav = location.hash;
      const missing = requiredMissing();
      $('#exit-missing').textContent = missing.length
        ? '⚠ 尚有 ' + missing.length + ' 项必填未填(如 ' + missing.slice(0, 3).map(function (x) { return x.label + ' ' + x.addr; }).join('、') + '),此状态下只能保存为草稿。'
        : '✓ 必填项已填完,可保存为可用表格。';
      $('#exit-modal').hidden = false;
      // 先还原到原编辑器 hash;用户在弹窗中的选择由 exitChoice 处理(存草稿/保存/不保存)
      history.replaceState(null, '', location.pathname + location.search + lastEditorHash);
      return;
    }
    if (name === 'estimate' && id) { openEstimateEditor(id); return; }
    if (name === 'new-estimate') { openEstimateEditor(null, id); return; }
    if (name === 'editor') { estDraft = null; location.hash = '#estimates'; return; }
    if (name === 'materials' || name === 'products' || name === 'estimates' || name === 'charts' || name === 'overview' || name === 'compare' || name === 'users') {
      switchView(name);
      return;
    }
    // 成本总揽/图表 跨页跳转(同源新窗口带筛选):#ovl-charts / #ovl-overview
    if (name === 'ovl-charts' || name === 'ovl-overview') {
      const target = name === 'ovl-charts' ? 'charts' : 'overview';
      try {
        const raw = sessionStorage.getItem('ovlFilter');
        if (raw) {
          const f = JSON.parse(raw);
          ovlFrom = f.from || ''; ovlTo = f.to || '';
          ovlTypes = Array.isArray(f.types) ? f.types : [];
          ovlMats = Array.isArray(f.mats) ? f.mats : [];
          sessionStorage.removeItem('ovlFilter');
        }
      } catch (e) { /* 忽略 */ }
      ovlCur = target;
      if (target === 'charts') { lastChartsSig = null; }
      location.hash = '#' + target; // 规整为常规 hash,再渲染目标视图
      return;
    }
    switchView('materials');
  }

  // ---------- 材料管理 ----------
  function renderMaterials() {
    const v = $('#view-materials');
    const rows = data.materials.map(function (m) {
      return '<tr>' +
        '<td class="l">' + esc(m.name) + '</td>' +
        '<td><select data-zone-of="' + m.id + '">' +
          '<option value="底料"' + (m.zone === '底料' ? ' selected' : '') + '>底料</option>' +
          '<option value="面料"' + (m.zone === '面料' ? ' selected' : '') + '>面料</option>' +
        '</select></td>' +
        '<td class="row-actions"><button class="danger small" data-action="del-material" data-id="' + m.id + '">' + btnIcon('trash', '删除') + '</button></td>' +
      '</tr>';
    }).join('');
    v.innerHTML =
      '<h2 class="sec-title">材料管理</h2>' +
      '<p style="color:#666;font-size:12px">材料名称与所属区(底料/面料)。被产品配方或估算单引用的材料不能删除。已预置原表 11 种材料。</p>' +
      '<div class="list-actions">' +
        '<input id="new-mat-name" type="text" placeholder="材料名称,如:黑水泥">' +
        '<select id="new-mat-zone"><option value="底料">底料</option><option value="面料">面料</option></select>' +
        '<button class="primary" data-action="add-material">' + btnIcon('plus', '添加材料') + '</button>' +
      '</div>' +
      '<table class="grid"><thead><tr><th class="l">材料名称</th><th>所属区</th><th>操作</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="3"><div class="empty-state">' + icon('inbox', 30) +
        '<div class="empty-title">暂无材料</div>' +
        '<div class="empty-sub">添加常用原材料(如水泥/砂石/染料),供产品配方与估算单选择。</div>' +
      '</div></td></tr>') + '</tbody></table>';
  }

  // ---------- 产品与配方 ----------
  function renderProducts() {
    const v = $('#view-products');
    const list = data.products.map(function (p) {
      return '<tr>' +
        '<td class="l">' + esc(p.name) + '</td>' +
        '<td>' + esc(p.code || '—') + '</td>' +
        '<td>' + p.recipe.length + ' 种</td>' +
        '<td class="row-actions">' +
          '<button class="small" data-action="edit-product" data-id="' + p.id + '">' + btnIcon('edit', '编辑配方') + '</button> ' +
          '<button class="danger small" data-action="del-product" data-id="' + p.id + '">' + btnIcon('trash', '删除') + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');
    const form = productFormDraft ? renderProductForm() : '';
    v.innerHTML =
      '<h2 class="sec-title">产品与配方</h2>' +
      form +
      '<div class="list-actions"><button class="primary" data-action="new-product">' + btnIcon('plus', '新建产品') + '</button></div>' +
      '<table class="grid"><thead><tr><th class="l">名称规格</th><th>产品编号</th><th>配方材料数</th><th>操作</th></tr></thead>' +
      '<tbody>' + (list || '<tr><td colspan="4"><div class="empty-state">' + icon('inbox', 30) +
        '<div class="empty-title">暂无产品</div>' +
        '<div class="empty-sub">先维护好材料,再新建产品并录入每锅配方用量。</div>' +
        '<button class="primary small" data-action="new-product">' + btnIcon('plus', '新建产品') + '</button>' +
      '</div></td></tr>') + '</tbody></table>';
  }

  function renderProductForm() {
    const d = productFormDraft;
    const rowRows = d.recipe.map(function (r, i) {
      const opts = data.materials.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === r.materialId ? ' selected' : '') + '>' +
          esc(m.name) + '（' + m.zone + '）</option>';
      }).join('');
      return '<tr>' +
        '<td><select data-path="recipe.' + i + '.materialId">' + opts + '</select></td>' +
        '<td><input type="number" step="any" min="0" data-path="recipe.' + i + '.qtyPerPot" value="' + r.qtyPerPot + '"></td>' +
        '<td><button class="danger small" data-action="pf-del-row" data-i="' + i + '">删</button></td>' +
      '</tr>';
    }).join('');
    const available = data.materials.filter(function (m) {
      return !d.recipe.some(function (r) { return r.materialId === m.id; });
    });
    return '<div class="est-card">' +
      '<h3>' + (editingProductId ? '编辑产品配方' : '新建产品') + '</h3>' +
      '<div class="meta-grid">' +
        '<label><span>名称规格</span><input type="text" data-path="name" value="' + esc(d.name) + '"></label>' +
        '<label><span>产品编号</span><input type="text" data-path="code" value="' + esc(d.code) + '"></label>' +
      '</div>' +
      '<h4 class="section-h">配方明细(每锅用量,单位:公斤)</h4>' +
      '<table class="grid"><thead><tr><th class="l">材料</th><th>每锅数量(公斤)</th><th>操作</th></tr></thead>' +
      '<tbody>' + (rowRows || '<tr><td colspan="3" class="empty-hint">配方为空</td></tr>') + '</tbody></table>' +
      '<div class="list-actions">' +
        '<select id="pf-add-mat">' + (available.map(function (m) {
          return '<option value="' + m.id + '">' + esc(m.name) + '（' + m.zone + '）</option>';
        }).join('') || '<option value="">无可用材料</option>') + '</select>' +
        '<button class="small" data-action="pf-add-row">' + btnIcon('plus', '添加材料') + '</button>' +
        '<button class="primary" data-action="save-product">' + btnIcon('check', '保存产品') + '</button>' +
        '<button data-action="cancel-product">取消</button>' +
      '</div></div>';
  }

  // ---------- 估算单列表 ----------
  /** 日期筛选命中:预算单区间 [s,e] 与筛选区间 [from,to] 有交集。
   *  空 from/to 表示不限;预算单缺一端日期时按单点区间处理;无日期的单仅在不筛选时保留。 */
  function estInRange(e, from, to) {
    if (!from && !to) return true;
    const s = String(e.startDate || '').trim();
    const en = String(e.endDate || '').trim();
    if (!s && !en) return false;                       // 无日期的草稿在筛选时排除
    const LO = '0000-01-01', HI = '9999-12-31';        // 字符串比较的"无穷"
    const s1 = s || en, s2 = en || s;                  // 预算单区间端点(缺一端则取另一端)
    const f1 = from || LO, f2 = to || HI;              // 筛选区间端点
    // 两区间不相交 ⇔ 单区间整体在筛选左( s2 < f1 )或在筛选右( s1 > f2 )
    return !(s2 < f1 || s1 > f2);
  }

  // ---------- 成本总揽 / 图表共用筛选(时间段+砖型多选+材料多选) ----------
  /** 估算单展示名(砖型/型号):优先取关联产品名,否则取估算单 name */
  function estTypeName(e) {
    if (e && e.name) return String(e.name);
    const p = e && e.productId ? data.products.find(function (x) { return x.id === e.productId; }) : null;
    return p && p.name ? String(p.name) : (e.code || '未命名');
  }
  /** 全部可筛选型号(按估算单 name 去重,保序) */
  function allTypes() {
    const seen = {}, out = [];
    (data.estimates || []).forEach(function (e) {
      const t = estTypeName(e);
      if (!seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out;
  }
  /** 全部可筛选材料(材料库 + 估算单内引用,按名去重) */
  function allMatNames() {
    const seen = {}, out = [];
    (data.materials || []).forEach(function (m) { if (!seen[m.name]) { seen[m.name] = 1; out.push(m.name); } });
    (data.estimates || []).forEach(function (e) {
      (e.rows || []).forEach(function (r) { if (r.name && !seen[r.name]) { seen[r.name] = 1; out.push(r.name); } });
    });
    return out;
  }
  /** 总揽/图表筛选:时间段 + 砖型限制批次集;材料多选只过滤材料维度内容(见 matAggregate/donut 等) */
  function ovlFiltered(list) {
    list = list || data.estimates || [];
    return list.filter(function (e) {
      if (!estInRange(e, ovlFrom, ovlTo)) return false;
      if (ovlTypes.length && ovlTypes.indexOf(estTypeName(e)) < 0) return false;
      return true;
    });
  }
  /** 当前筛选下计算每个估算单的 CostCalc 结果 */
  function ovlComps() {
    return ovlFiltered().map(function (e) { return { e: e, c: CostCalc.compute(e) }; });
  }
  /** 型号维度聚合:每型号 → {批次, cost1(成本总价①合计), 平均成本, 用料公斤} */
  function typeAggregate(comps) {
    const map = new Map();
    comps.forEach(function (x) {
      const t = estTypeName(x.e);
      if (!map.has(t)) map.set(t, { type: t, n: 0, cost: 0, kg: 0 });
      const o = map.get(t);
      o.n++;
      o.cost += isFinite(x.c.calc.costTotal1) ? x.c.calc.costTotal1 : 0;
      o.kg += isFinite(x.c.listTotals.usageKg) ? x.c.listTotals.usageKg : 0;
    });
    const rows = Array.from(map.values());
    rows.forEach(function (o) { o.avg = o.n ? o.cost / o.n : 0; });
    return rows;
  }
  /** 材料维度聚合:每材料 → 用量公斤 / 金额 */
  function matAggregate(comps) {
    const map = new Map();
    comps.forEach(function (x) {
      x.c.rows.forEach(function (r) {
        if (ovlMats.length && ovlMats.indexOf(r.name) < 0) return;
        if (!map.has(r.name)) map.set(r.name, { name: r.name, kg: 0, amount: 0 });
        const o = map.get(r.name);
        o.kg += r.usageKg;
        o.amount += r.usageAmount;
      });
    });
    return Array.from(map.values());
  }

  function renderEstimates() {
    const v = $('#view-estimates');
    const prodOpts = data.products.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + '（' + esc(p.code || '无编号') + '）</option>';
    }).join('');
    const all = data.estimates.slice().reverse();
    const from = estDateFrom, to = estDateTo;
    const filtered = all.filter(function (e) { return estInRange(e, from, to); });
    const rows = filtered.map(function (e) {
      const c = CostCalc.compute(e);
      const st = e.status === 'ready' ? 'ready' : 'draft';
      return '<tr>' +
        '<td class="l">' + esc(e.name || '(未命名)') + '</td>' +
        '<td>' + esc(e.code || '—') + '</td>' +
        '<td><span class="tag ' + (st === 'ready' ? 'tag-ready' : 'tag-draft') + '">' + (st === 'ready' ? '可用' : '草稿') + '</span></td>' +
        '<td>' + esc(e.startDate || '—') + '</td>' +
        '<td>' + esc(e.endDate || '—') + '</td>' +
        '<td>' + esc(e.author || '—') + '</td>' +
        '<td>' + fmt(e.potBottom, 0) + ' / ' + fmt(e.potTop, 0) + '</td>' +
        '<td class="money">¥' + fmt(c.calc.costTotal1) + '</td>' +
        '<td class="money">¥' + fmt(c.calc.costTotal2) + '</td>' +
        '<td class="row-actions">' +
          '<button class="small" data-action="view-estimate" data-id="' + e.id + '" title="打开预算表编辑">' + btnIcon('view', '查看') + '</button> ' +
          '<button class="small" data-action="clone-estimate" data-id="' + e.id + '" title="复制为新估算单">' + btnIcon('copy', '复制') + '</button> ' +
          '<button class="danger small row-del" data-action="del-estimate" data-id="' + e.id + '" title="删除该估算单">' + btnIcon('trash', '删除') + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    // 顶部统计条(KPI 卡):统计范围与筛选同步(基于 filtered)
    const nReady = filtered.filter(function (e) { return e.status === 'ready'; }).length;
    const nDraft = filtered.length - nReady;
    const sumCost = filtered.reduce(function (s, e) {
      const c = CostCalc.compute(e);
      return s + (isFinite(c.calc.costTotal1) ? c.calc.costTotal1 : 0);
    }, 0);
    const statCard = function (label, value, cls, ic) {
      return '<div class="kpi-card' + (cls ? ' ' + cls : '') + '">' +
        '<span class="kpi-ic">' + icon(ic, 18) + '</span>' +
        '<div class="kpi-body"><span class="kpi-label">' + label + '</span>' +
        '<span class="kpi-value">' + value + '</span></div></div>';
    };
    const stats = all.length
      ? '<div class="kpi-row">' +
          statCard('估算单(批次)', fmt(filtered.length, 0), '', 'folder') +
          statCard('可用表格', fmt(nReady, 0), 'kpi-ok', 'check') +
          statCard('草稿', fmt(nDraft, 0), 'kpi-warn', 'edit') +
          statCard('成本总价①合计(元)', '¥' + fmt(sumCost, 0), 'kpi-cost', 'chart') +
        '</div>'
      : '';

    // 日期筛选条
    const hasFilter = !!(from || to);
    const filterBar =
      '<div class="date-filter">' +
        '<span class="df-label">' + icon('view', 15) + '按时间段筛选:</span>' +
        '<input type="date" id="est-date-from" value="' + esc(from || '') + '" title="开始日期(含)">' +
        '<span class="df-sep">至</span>' +
        '<input type="date" id="est-date-to" value="' + esc(to || '') + '" title="结束日期(含)">' +
        (hasFilter ? '<button class="small" id="est-date-clear" data-action="est-date-clear">' + btnIcon('trash', '清除筛选') + '</button>' : '') +
        '<span class="df-count">' + (hasFilter ? '显示 ' + filtered.length + ' / ' + all.length + ' 批次' : '共 ' + all.length + ' 批次') + '</span>' +
      '</div>';

    // 空态分两种:全库无 / 筛选无结果
    let empty;
    if (!all.length) {
      empty = '<tr><td colspan="10"><div class="empty-state">' + icon('inbox', 34) +
          '<div class="empty-title">暂无估算单</div>' +
          '<div class="empty-sub">从产品配方新建,或直接创建空白估算单开始第一张预算表。</div>' +
          '<button class="primary small" data-action="new-estimate">' + btnIcon('plus', '新建估算单') + '</button>' +
        '</div></td></tr>';
    } else if (!filtered.length) {
      empty = '<tr><td colspan="10"><div class="empty-state">' + icon('search', 34) +
          '<div class="empty-title">该时间段暂无估算单</div>' +
          '<div class="empty-sub">调整筛选日期范围,或清除筛选查看全部批次。</div>' +
          '<button class="primary small" data-action="est-date-clear">' + btnIcon('trash', '清除筛选') + '</button>' +
        '</div></td></tr>';
    } else {
      empty = rows;
    }

    v.innerHTML =
      '<h2 class="sec-title">估算单(批次)</h2>' +
      stats +
      (all.length ? filterBar : '') +
      '<div class="list-actions">' +
        '<span class="la-label">基于产品新建:</span>' +
        '<select id="new-est-prod"><option value="">(空白估算单)</option>' + prodOpts + '</select>' +
        '<button class="primary" data-action="new-estimate">' + btnIcon('plus', '新建估算单') + '</button>' +
      '</div>' +
      '<table class="grid"><thead><tr>' +
        '<th class="l">名称规格</th><th>预算表编号</th><th>状态</th><th>开始日期</th><th>结束日期</th><th>编制人</th>' +
        '<th>底料/面料锅数</th><th>成本总价①</th><th>成本总价②</th><th>操作</th>' +
      '</tr></thead>' +
      '<tbody>' + empty + '</tbody></table>';
  }

  // ---------- 估算单编辑器 ----------
  /**
   * 同预算表编号(code)中"上一个"批次:取开始日期早于本单且最近的一个(同 code、排除自身)。
   * 排序规则:startDate 升序;同日期按 id 升序,取最后一个仍早于本单的。
   */
  function prevBatchOf(code, curId) {
    if (!code) return null;
    const same = data.estimates.filter(function (e) {
      return e.id !== curId && e.code === code;
    }).sort(function (a, b) {
      const da = a.startDate || '', db = b.startDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    if (!same.length) return null;
    const curDate = (function () {
      const self = data.estimates.find(function (e) { return e.id === curId; });
      return self ? (self.startDate || '') : '';
    })();
    // 取开始日期不晚于本单的最后一个;本单无日期时取最近一个
    let prev = null;
    for (let i = 0; i < same.length; i++) {
      if (curDate && (same[i].startDate || '') > curDate) break;
      prev = same[i];
    }
    if (!prev && same.length) prev = same[same.length - 1];
    return prev;
  }

  /** 上一批次的材料库存表:{材料名 -> 期末库存公斤(上存+进料-本期用料)} */
  function prevStockMap(prevEst) {
    const out = {};
    if (!prevEst) return out;
    CostCalc.compute(prevEst).rows.forEach(function (r) {
      out[r.name] = r.stock; // calc.rows[].stock = 上存+本期进料-本期用料数量(公斤)
    });
    return out;
  }

  /** 上存材料跨批提示 HTML:同编号有上一批且材料名匹配时,提示建议上存(=上一批库存),一键填入 */
  function prevStockHTML(d, sheet) {
    if (!d || !d.code || !d.rows.length) return '';
    const prev = prevBatchOf(d.code, d.id);
    if (!prev) return '';
    const prevStock = prevStockMap(prev);
    // 本单材料清单里可编辑"上存材料"的行:按 name 匹配(材料清单含全部 rows)
    const hints = d.rows.map(function (r) {
      const ref = prevStock[r.name];
      if (ref === undefined) return null;      // 上一批没有该材料
      const curVal = (r.stockOnHand === '' || r.stockOnHand === null || r.stockOnHand === undefined) ? null : Number(r.stockOnHand);
      const differs = curVal === null || Math.abs(curVal - ref) > 1e-9;
      return { name: r.name, ref: ref, cur: curVal };
    }).filter(Boolean);
    if (!hints.length) return '';
    // 有差异才提示(全一致则不需要打扰)
    const differsAll = hints.filter(function (h) { return h.cur === null || Math.abs(h.cur - h.ref) > 1e-9; });
    if (!differsAll.length) return '';
    const chips = differsAll.map(function (h) {
      return '<span class="chip"><b>' + esc(h.name) + '</b>上一批库存 ' + fmt(h.ref, 2) + ' kg' +
        (h.cur !== null ? '(当前 ' + fmt(h.cur, 2) + ')' : '(未填)') + '</span>';
    }).join(' ');
    return '<div class="stock-prev-hint">' +
      '<span class="ic-wrap">' + icon('calendar', 16) + '</span>' +
      '<span>检测到同编号上一批次「' + esc(prev.code || '') + '」(' + esc(prev.startDate || '无日期') + ')。' +
      '按口径「上存材料 = 上一编号的库存材料(上存+进料-本期用料)」,以下材料可参考:&nbsp;</span>' +
      chips +
      '<button class="small primary" data-action="apply-prev-stock" title="把上述上存材料统一改为上一批库存值">' + btnIcon('download', '一键填入') + '</button>' +
      '</div>';
  }

  function newEstimateDraft(productId) {
    const p = productId ? data.products.find(function (x) { return x.id === productId; }) : null;
    const rows = p ? p.recipe.map(function (r) {
      const m = Store.materialById(r.materialId);
      return {
        id: uid(), materialId: r.materialId,
        name: m ? m.name : '未知材料', zone: m ? m.zone : '底料',
        qtyPerPot: r.qtyPerPot || '', price: '', stockOnHand: '', stockIn: '', qty: ''
      };
    }) : [];
    return {
      id: null, productId: p ? p.id : null,
      status: 'draft', // draft=草稿 / ready=可用表格
      name: p ? p.name : '', code: '',
      startDate: today(), endDate: '', author: currentUser ? currentUser.username : '',
      potBottom: '', potTop: '', rows: rows,
      calc: {
        perPieceWeight: '', perModuleCount: '', moldManual: '', perSqmWeight: '',
        perCubicWeight: '', perPalletCount: '', perPalletSqm: '', perPalletWeight: '',
        planCount: '', actualCount: '', yieldRate: '', tonPrice: '',
        perSqmPrice: '', startMold: '', endMold: ''
      }
    };
  }

  function openEstimateEditor(id, productId) {
    if (id) {
      const src = data.estimates.find(function (e) { return e.id === id; });
      if (!src) { toast('估算单不存在'); return; }
      estDraft = JSON.parse(JSON.stringify(src));
    } else {
      estDraft = newEstimateDraft(productId);
    }
    // 加载保存过的公式覆盖
    gridOverF = (estDraft.formulas && estDraft.formulas.f) ? JSON.parse(JSON.stringify(estDraft.formulas.f)) : {};
    gridOverV = (estDraft.formulas && estDraft.formulas.v) ? JSON.parse(JSON.stringify(estDraft.formulas.v)) : {};
    gridSel = null;
    gridCache = null;
    gridDirty = false;   // 打开/重新加载时无未保存改动
    gridPendingNav = null;
    lastEditorHash = location.hash || ('#estimate/' + (estDraft.id || ''));
    switchView('editor');
    renderEstimateEditor();
    // P2 自动草稿:若本机有同单未保存草稿(刷新/崩溃残留),自动恢复
    tryRestoreAutoDraft();
  }


  function renderEstimateEditor() {
    const v = $('#view-editor');
    const d = estDraft;
    gridEval();
    const sheet = gridCache.sheet;
    const addOpts = data.materials.filter(function (m) {
      return !d.rows.some(function (r) { return r.materialId === m.id; });
    }).map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.name) + '（' + m.zone + '）</option>';
    }).join('');
    const chips = d.rows.map(function (r, i) {
      return '<span class="chip" title="移除该材料行(将清空公式覆盖)">' + esc(r.name) +
        '<button class="chip-x" data-action="editor-del-mat" data-idx="' + i + '">✕</button></span>';
    }).join('');

    v.innerHTML =
      '<div class="toolbar">' +
        '<button data-action="editor-back">' + btnIcon('back', '返回估算单列表') + '</button>' +
        '<h3 class="editor-title">' + (d.id ? '编辑估算单 · 表格模式' : '新建估算单 · 表格模式') + '</h3>' +
        '<span class="tag ' + (d.status === 'ready' ? 'tag-ready' : 'tag-draft') + '" id="editor-status-tag">' + (d.status === 'ready' ? '可用表格' : '草稿') + '</span>' +
        '<button data-action="editor-save-draft">' + btnIcon('folder', '存为草稿') + '</button>' +
        '<button class="primary" data-action="editor-save">' + btnIcon('check', '保存为可用表格(需填完必填)') + '</button>' +
        '<button data-action="editor-save-copy">' + btnIcon('copy', '保存为副本') + '</button>' +
        '<span class="toolbar-sep" aria-hidden="true"></span>' +
        '<button data-action="editor-export-xls" title="导出为 Excel(.xls),可自选保存路径">' + btnIcon('download', '导出 Excel') + '</button>' +
        '<button data-action="editor-export-pdf" title="打印/另存为 PDF,可自选保存路径">' + btnIcon('printer', '导出 PDF') + '</button>' +
      '</div>' +
      '<div class="fxbar">' +
        '<span class="fx-name" id="fx-name">—</span>' +
        '<span class="fx-prefix">fx</span>' +
        '<input id="fx-input" type="text" spellcheck="false" autocomplete="off" ' +
          'placeholder="先点击单元格,再在此输入数值或公式;公式以 = 开头(如 =C6*D6);回车生效">' +
      '</div>' +
      '<div class="pick-bar"><label>按名称规格导入产品配方:</label>' +
        '<select id="grid-pick-product">' +
          '<option value="">(不导入,手动填写)</option>' +
          data.products.map(function (p) {
            return '<option value="' + p.id + '">' + esc(p.name) + '（' + esc(p.code || '无编号') + '）</option>';
          }).join('') +
        '</select><span class="chip-hint">选择后将自动填充该配方的材料行与每锅用量</span></div>' +
      '<div class="required-bar" id="editor-required-bar"></div>' +
      '<div class="sheet-hint">版式与《砖成本材料预算表_黑白打印版.xlsx》一致 · ' +
        '灰底=说明 · 白底=输入格 · 蓝底=公式格 · <b style="color:#a06700">黄底=必填待填写</b>;退出编辑时会弹窗选择保存方式。</div>' +
      prevStockHTML(d, sheet) +
      '<div class="sheet-scroll">' + gridTableHTML(sheet) + '</div>' +
      '<div class="list-actions">' +
        '<select id="editor-add-mat">' + (addOpts || '<option value="">无可用材料</option>') + '</select>' +
        '<button class="small" data-action="editor-add-material">添加材料行</button>' +
      '</div>' +
      '<div class="chip-bar"><span class="chip-hint">当前材料:</span>' +
        (chips || '<span style="color:#888">(无,请添加材料行)</span>') + '</div>' +
      '<p class="editor-note">改动任意输入格或覆盖公式后,所有依赖格自动重算;未填完必填项只能保存为草稿,全部填完才能保存为可用表格。</p>';

    paintAll(gridCache);
    gridSel = null;
    updateFxBar();
  }

  // ---------- 表格(Excel 化)求值与绘制 ----------
  function getPath(obj, path) {
    const parts = String(path).split('.');
    let o = obj;
    for (let i = 0; i < parts.length && o != null; i++) o = o[parts[i]];
    return o;
  }
  function gridEval() {
    gridCache = Sheet.evaluate(estDraft, { f: gridOverF, v: gridOverV });
    return gridCache;
  }
  function isFormulaShown(def) {
    if (gridOverF[def.addr]) return true;
    if (gridOverV[def.addr] !== undefined) return false;
    return def.kind === 'formula';
  }
  function rawCellValue(def) {
    if (gridOverV[def.addr] !== undefined) return gridOverV[def.addr];
    if (def.kind === 'input') {
      const val = getPath(estDraft, def.path);
      return val === null || val === undefined ? '' : val;
    }
    return '';
  }
  function numText(v) {
    if (v === 0) return '0';
    const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (Math.abs(v) >= 10000) return Number(s).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    return s;
  }
  function displayCellText(def, res) {
    if (def.kind === 'label') return def.text == null ? '' : def.text;
    let v;
    if (isFormulaShown(def)) v = res.values[def.addr];
    else v = rawCellValue(def);
    if (v === null || v === undefined || v === '') return '';
    if (v && typeof v === 'object' && v.err) return v.err;
    if (typeof v === 'number') return def.pct ? pct(v) : numText(v);
    return String(v);
  }
  function paintAll(res) {
    const v = $('#view-editor');
    if (!v) return;
    res.sheet.rows.forEach(function (row) {
      row.forEach(function (def) {
        if (!def || def.kind === 'blank') return;
        const td = v.querySelector('[data-addr="' + def.addr + '"]');
        if (!td) return;
        const txt = displayCellText(def, res);
        td.textContent = txt;
        const isErr = txt.charAt(0) === '#';
        td.classList.toggle('err', isErr);
        if (isErr) td.title = txt + '（' + def.addr + '）';
        // 必填高亮:必填输入格为空时黄色提示,填入(含 0)后取消
        if (def.required && def.kind === 'input') {
          const empty = txt === '';
          td.classList.toggle('need', empty);
          td.title = empty ? '必填:' + Sheet.pathToLabel(def.path) + '(' + def.addr + ')' : '';
        } else {
          td.classList.remove('need');
        }
      });
    });
    const missing = requiredMissing(res);
    const bar = $('#editor-required-bar');
    if (bar) {
      bar.textContent = missing.length ? '⚠ 尚有 ' + missing.length + ' 项必填未填写(如 ' + missing.slice(0, 4).map(function (x) { return x.label + ' ' + x.addr; }).join('、') + '…),此时只能保存为草稿' : '✓ 必填项已填写完毕,可保存为可用表格';
      bar.classList.toggle('warn', missing.length > 0);
    }
  }
  /** 必填项缺失清单 */
  function requiredMissing(res) {
    res = res || gridEval();
    const out = [];
    Object.keys(res.addrCells).forEach(function (addr) {
      const def = res.addrCells[addr];
      if (def && def.required && def.kind === 'input') {
        const txt = displayCellText(def, res);
        if (txt === '') out.push({ addr: addr, path: def.path, label: Sheet.pathToLabel(def.path) });
      }
    });
    return out;
  }
  function gridTableHTML(sheet) {
    let head = '<colgroup>' + Sheet.COLS.map(function (c) { return '<col class="col-' + c + '">'; }).join('') + '</colgroup>' +
      '<thead><tr>' + Sheet.COLS.map(function (c) { return '<th class="colh">' + c + '</th>'; }).join('') + '</tr></thead>';
    let body = '';
    sheet.rows.forEach(function (row) {
      body += '<tr>';
      let col = 0;
      while (col < Sheet.COL_COUNT) {
        const def = row[col];
        if (!def) { body += '<td class="void"></td>'; col++; continue; }
        const span = def.span > 1 ? ' colspan="' + def.span + '"' : '';
        if (def.kind === 'blank') { body += '<td class="void"' + span + '></td>'; col += def.span || 1; continue; }
        const editable = def.kind === 'input' || def.kind === 'formula';
        body += '<td' + (def.addr ? ' data-addr="' + def.addr + '"' : '') + span +
          ' class="sg ' + def.cls + '"' + (editable ? ' data-editable="1"' : '') + '>' +
          (def.kind === 'label' ? esc(def.text || '') : '') + '</td>';
        col += def.span || 1;
      }
      body += '</tr>';
    });
    return '<table class="sheet-grid">' + head + '<tbody>' + body + '</tbody></table>';
  }
  function updateFxBar() {
    const nameEl = $('#fx-name');
    const inputEl = $('#fx-input');
    if (!nameEl || !inputEl) return;
    const def = (gridSel && gridCache) ? gridCache.addrCells[gridSel] : null;
    if (!def || (def.kind !== 'input' && def.kind !== 'formula')) {
      nameEl.textContent = '—';
      inputEl.value = '';
      inputEl.disabled = true;
      return;
    }
    nameEl.textContent = def.addr;
    inputEl.disabled = false;
    inputEl.value = fxContent(def);
  }
  function fxContent(def) {
    if (gridOverF[def.addr]) return gridOverF[def.addr];
    if (gridOverV[def.addr] !== undefined) return String(gridOverV[def.addr]);
    if (def.kind === 'formula') return def.f;
    const raw = getPath(estDraft, def.path);
    return raw === null || raw === undefined ? '' : String(raw);
  }
  function selectCell(addr) {
    commitFx();
    gridSel = addr;
    updateFxBar();
    repaintSel();
  }
  function repaintSel() {
    const v = $('#view-editor');
    if (!v) return;
    v.querySelectorAll('td[data-editable]').forEach(function (td) {
      td.classList.toggle('sel', td.dataset.addr === gridSel);
    });
    paintTrace(v);
    const inputEl = $('#fx-input');
    // preventScroll:避免把顶部公式栏滚进视口导致页面跳顶
    if (inputEl && gridSel && !inputEl.disabled) inputEl.focus({ preventScroll: true });
  }

  // ---------- 引用追踪:点击单元格高亮与其结果相关的格子(Excel 式影响链) ----------
  // 已知引用集(供 fast path):parseRefs 的返回中含函数名与字母数字引用,统一按引用格处理前过滤。
  function addrRefsOf(effText) {
    const keys = Formula.parseRefs(effText);
    const seen = {};
    const out = [];
    keys.forEach(function (k) {
      const addr = String(k).toUpperCase();
      if (!/^[A-Z]+\d+$/.test(addr)) return;          // 过滤函数名/非地址 token
      if (seen[addr]) return;
      seen[addr] = 1;
      const def = gridCache && gridCache.addrCells ? gridCache.addrCells[addr] : null;
      if (def && def.kind !== 'blank') out.push(addr);
    });
    return out;
  }
  /** 当前选中格的影响链:src=其公式直接引用的格;dep=直接或经公式链引用它的公式格。 */
  function traceOf(addr) {
    const src = [], dep = [], seenDep = {}, seenSrc = {};
    const ac = (gridCache && gridCache.addrCells) || {};
    const effF = (gridCache && gridCache.effF) || {};
    const cur = ac[addr];
    if (!cur) return { src: src, dep: dep };
    // 1) 来源:当前格若是公式格(含被覆盖成公式),列出其引用的格子
    if (effF[addr] !== undefined || (cur.kind === 'formula' && gridOverF[addr] === undefined && gridOverV[addr] === undefined)) {
      const fText = effF[addr] !== undefined ? effF[addr]
        : (gridOverF[addr] || (cur.f !== undefined ? cur.f : ''));
      addrRefsOf(fText).forEach(function (a) {
        if (a === addr || seenSrc[a]) return;
        seenSrc[a] = 1;
        src.push(a);
      });
    } else if (cur.kind === 'input') {
      // 2) 输入格:无来源;直接看哪些公式引用它(见下方 dep)
    }
    // 3) 从属:遍历所有公式格,递归收集直接/间接引用当前格的公式格
    const visitDep = function (target, isFirst) {
      Object.keys(effF).forEach(function (a) {
        if (a === target && !isFirst) return;
        if (seenDep[a]) return;
        const refs = addrRefsOf(effF[a]);
        if (refs.indexOf(target) >= 0) {
          seenDep[a] = 1;
          dep.push(a);
          visitDep(a, false); // 该公式格若又被别的公式引用,继续向上游追踪
        }
      });
    };
    visitDep(addr, true);
    return { src: src, dep: dep };
  }
  function paintTrace(v) {
    if (!v) return;
    v.querySelectorAll('td.trace-src, td.trace-dep').forEach(function (td) {
      td.classList.remove('trace-src', 'trace-dep');
    });
    if (!gridSel || !gridCache) return;
    const t = traceOf(gridSel);
    const apply = function (list, cls) {
      list.forEach(function (a) {
        const td = v.querySelector('[data-addr="' + a + '"]');
        if (td) td.classList.add(cls);
      });
    };
    // 输入格/无公式格:橙=被哪些公式引用(结果联动);公式格:绿=它引用了谁,橙=它又被谁引用
    // 注意:输入格可被用户覆盖成公式(gridOverF),此时按公式格追踪——以 effF 是否含该格为准
    const eff = (gridCache && gridCache.effF) || {};
    const cur = gridCache.addrCells[gridSel];
    const isFxCell = eff[gridSel] !== undefined;
    if (isFxCell) {
      apply(t.src, 'trace-src');       // 公式引用的来源
      apply(t.dep, 'trace-dep');       // 引用该公式的下游公式格
    } else if (cur && cur.kind === 'input') {
      apply(t.dep, 'trace-dep');       // 该输入被哪些公式(直接/间接)使用 → 结果格
    }
  }
  function commitFx() {
    const inputEl = $('#fx-input');
    if (!inputEl || !gridSel || !gridCache) return;
    const def = gridCache.addrCells[gridSel];
    if (!def) return;
    const text = inputEl.value;
    const t = String(text).trim();
    if (t === fxContent(def)) return; // 未改动(含首尾空白),跳过
    markDirty();
    if (t.charAt(0) === '=') {
      try { Formula.parse(t.slice(1)); } catch (e) { /* 允许保存;格子显示 #PARSE! */ }
      delete gridOverV[gridSel];
      gridOverF[gridSel] = t;
    } else if (def.kind === 'input') {
      delete gridOverF[gridSel];
      delete gridOverV[gridSel];
      setByPath(estDraft, def.path, t === '' ? '' : (/^-?\d*\.?\d+$/.test(t) ? Number(t) : t));
    } else {
      delete gridOverF[gridSel];
      if (t === '') delete gridOverV[gridSel];
      else gridOverV[gridSel] = t;
    }
    gridEval();
    paintAll(gridCache);
    updateFxBar();
    paintTrace(document.getElementById('view-editor')); // 公式/取值变化后刷新影响链
  }
  function clearGridOverrides(msg) {
    gridOverF = {};
    gridOverV = {};
    if (msg) toast(msg);
  }

  // ================= 本地自动草稿(P2:防刷新/误关丢失编辑) =================
  const AUTO_KEY = 'brick_autosave_v1';
  let autoTimer = null;
  /** 标记编辑器有改动:置 dirty 并防抖 600ms 写入 localStorage */
  function markDirty() {
    gridDirty = true;
    scheduleAutoSave();
  }
  /** 保存成功/明确放弃后:清除本地草稿并复位 dirty */
  function markClean() {
    clearTimeout(autoTimer);
    autoTimer = null;
    try { localStorage.removeItem(AUTO_KEY); } catch (e) { /* 忽略 */ }
    gridDirty = false;
  }
  /** 保存成功后的轻量清理:清除已落库草稿;若保存期间又产生新改动(有排队存档)则保留 */
  function savedAutoDraft() {
    try { localStorage.removeItem(AUTO_KEY); } catch (e) { /* 忽略 */ }
    gridDirty = false;
  }
  /** 防抖存档(仅编辑器打开且有草稿时) */
  function scheduleAutoSave() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () {
      autoTimer = null;
      if (!estDraft) return;
      try {
        const payload = {
          savedAt: Date.now(),
          id: estDraft.id || null,          // 已保存单的 id;新单为 null
          isNew: !estDraft.id,
          name: estDraft.name || '',
          draft: JSON.parse(JSON.stringify(estDraft)),
          overF: JSON.parse(JSON.stringify(gridOverF || {})),
          overV: JSON.parse(JSON.stringify(gridOverV || {}))
        };
        localStorage.setItem(AUTO_KEY, JSON.stringify(payload));
      } catch (e) { /* 存储满/隐私模式忽略 */ }
    }, 600);
  }
  /** 打开估算单时尝试恢复上次未保存草稿(同 id 或同为新建且名称匹配才应用) */
  function tryRestoreAutoDraft() {
    let raw = null;
    try { raw = localStorage.getItem(AUTO_KEY); } catch (e) { return; }
    if (!raw) return;
    let p;
    try { p = JSON.parse(raw); } catch (e) { return; }
    if (!p || !p.draft) return;
    const sameId = !!(estDraft.id && p.id === estDraft.id);
    // 新单恢复需谨慎:草稿必须"改过名"(有实质标识),避免把上一张无名新单草稿套到当前空新单上
    const sameNew = !estDraft.id && p.isNew && !!p.name && p.name === (estDraft.name || '');
    if (!sameId && !sameNew) return; // 不是同一张单,不套用
    const stale = Date.now() - (p.savedAt || 0) > 7 * 24 * 3600 * 1000;
    if (stale) return; // 一周前的旧草稿不打扰
    // 套用草稿
    estDraft = p.draft;
    gridOverF = p.overF || {};
    gridOverV = p.overV || {};
    gridSel = null;
    gridCache = null;
    gridDirty = true;
    // 清除已套用的本地草稿,避免下次重复弹
    try { localStorage.removeItem(AUTO_KEY); } catch (e) { /* 忽略 */ }
    renderEstimateEditor();
    toast('已恢复上次未保存的编辑内容(' + new Date(p.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 保存的草稿)');
  }

  /** 导入已有产品配方:替换当前材料行并按配方填每锅用量 */
  function applyProductPick(productId) {
    const p = productId ? data.products.find(function (x) { return x.id === productId; }) : null;
    if (!p) { toast('未找到该产品'); return; }
    const doApply = function () {
      const rows = p.recipe.map(function (r) {
        const m = Store.materialById(r.materialId);
        return {
          id: uid(), materialId: r.materialId,
          name: m ? m.name : '未知材料', zone: m ? m.zone : '底料',
          qtyPerPot: r.qtyPerPot || '', price: '', stockOnHand: '', stockIn: '', qty: ''
        };
      });
      estDraft.rows = rows;
      estDraft.productId = p.id;
      estDraft.name = p.name;
      // 预算表编号独立于产品编号,不再随配方自动带入(由用户手动填写)
      markDirty();
      clearGridOverrides('已按产品配方导入材料行,公式覆盖已清空');
      renderEstimateEditor();
      toast('已导入产品配方:' + p.name + '(' + rows.length + ' 个材料)');
    };
    if (estDraft.rows.length) {
      showConfirm('确认导入产品配方', '当前估算单已有 ' + estDraft.rows.length + ' 行材料,导入产品「' + p.name + '」会替换为按该配方生成的 ' + p.recipe.length + ' 行(名称规格一并更新)。继续吗?', doApply, null);
    } else {
      doApply();
    }
  }

  // ---------- 保存与状态(草稿 draft / 可用表格 ready) ----------
  /** 汇总当前草稿(把公式覆盖的输入格求解值回写结构化字段,并持久化覆盖) */
  function finalizeDraft() {
    const d = JSON.parse(JSON.stringify(estDraft));
    const res = gridEval();
    Object.keys(gridOverF).forEach(function (addr) {
      const def = res.addrCells[addr];
      if (def && def.kind === 'input' && def.path) {
        const val = res.values[addr];
        if (val !== undefined && !(val && typeof val === 'object' && val.err)) {
          setByPath(d, def.path, val === '' || val === null ? '' : (typeof val === 'number' ? val : String(val)));
        }
      }
    });
    d.formulas = {};
    if (Object.keys(gridOverF).length) d.formulas.f = JSON.parse(JSON.stringify(gridOverF));
    if (Object.keys(gridOverV).length) d.formulas.v = JSON.parse(JSON.stringify(gridOverV));
    // 派生公式结果回写 calc(每平方重量/每立方重量/每托重量/计划数/成品率/面积/体积)
    Object.keys(res.addrCells).forEach(function (addr) {
      const def = res.addrCells[addr];
      if (def && def.derive && res.values[addr] !== undefined) {
        const val = res.values[addr];
        if (!(val && typeof val === 'object' && val.err)) {
          setByPath(d, def.derive, val === '' || val === null ? '' : (typeof val === 'number' ? val : String(val)));
        }
      }
    });
    return d;
  }
  function moldVal(est) {
    const v = est && est.calc ? est.calc.endMold : '';
    return (v === '' || v === null || v === undefined) ? null : Number(v);
  }
  function startMoldVal(est) {
    const v = est && est.calc ? est.calc.startMold : '';
    return (v === '' || v === null || v === undefined) ? null : Number(v);
  }
  /** 同预算表编号相邻批次的衔接校验(日期不重叠 + 模数递增) */
  function adjacentIssues(est) {
    const code = String(est.code || '').trim();
    if (!code) return [];
    const merged = [];
    data.estimates.forEach(function (x) {
      if (x.id === est.id) merged.push(est);            // 用当前编辑值替换存储版本
      else if (String(x.code || '').trim() === code) merged.push(x);
    });
    if (!merged.some(function (x) { return x.id === est.id; })) merged.push(est);
    merged.sort(function (a, b) {
      const da = a.startDate || '', db = b.startDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return String(a.id || '') < String(b.id || '') ? -1 : 1;
    });
    const idx = merged.findIndex(function (x) { return x.id === est.id; });
    const issues = [];
    if (idx > 0) {
      const prev = merged[idx - 1];
      if (prev.endDate && est.startDate && String(prev.endDate) > String(est.startDate)) {
        issues.push('前一单「' + (prev.name || prev.id) + '」结束日期 ' + prev.endDate + ' 晚于本单开始日期 ' + est.startDate + '(日期重叠)');
      }
      if (moldVal(prev) !== null && startMoldVal(est) !== null && moldVal(prev) >= startMoldVal(est)) {
        issues.push('前一单「' + (prev.name || prev.id) + '」止模 ' + prev.calc.endMold + ' 不小于本单始模 ' + est.calc.startMold + '(模数未递增)');
      }
    }
    if (idx >= 0 && idx < merged.length - 1) {
      const next = merged[idx + 1];
      if (est.endDate && next.startDate && String(est.endDate) > String(next.startDate)) {
        issues.push('后一单「' + (next.name || next.id) + '」开始日期 ' + next.startDate + ' 早于本单结束日期 ' + est.endDate + '(日期重叠)');
      }
      if (moldVal(est) !== null && startMoldVal(next) !== null && moldVal(est) >= startMoldVal(next)) {
        issues.push('后一单「' + (next.name || next.id) + '」始模 ' + next.calc.startMold + ' 不大于本单止模 ' + est.calc.endMold + '(模数未递增)');
      }
    }
    return issues;
  }

  let confirmOkCb = null, confirmCancelCb = null;
  /** 确认弹窗(通用) */
  function showConfirm(title, message, onOk, onCancel) {
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = message;
    confirmOkCb = onOk || null;
    confirmCancelCb = onCancel || null;
    $('#confirm-modal').hidden = false;
  }
  function hideConfirm() {
    $('#confirm-modal').hidden = true;
    confirmOkCb = null;
    confirmCancelCb = null;
  }

  let savingEstimate = false; // 防止重复触发保存
  /**
   * 保存估算单。
   * @param status 'draft' | 'ready'
   * @param asCopy 是否另存副本
   * @param after 保存完成后跳转的 hash(空则回估算单列表)
   * @returns boolean 是否真正写入(false=校验不通过)
   */
  function saveEstimate(status, asCopy, after) {
    // 先把公式栏未回车的内容提交到草稿,避免"输入了却没保存"
    if (document.getElementById('fx-input') && !document.getElementById('fx-input').disabled) commitFx();
    const missing = requiredMissing();
    if (status === 'ready' && missing.length) {
      toast('还有 ' + missing.length + ' 项必填未填写(如 ' + missing[0].label + ' ' + missing[0].addr + '),只能保存为草稿');
      return false;
    }
    if (savingEstimate) { toast('正在保存中,请稍候…'); return false; }
    const d = finalizeDraft();
    d.status = status;
    const issues = adjacentIssues(d);
    function commit() {
      savingEstimate = true;
      setSaveBtnLoading(true);
      // 取消"保存前改动"的排队存档(即将落库,无需再存本地草稿)
      clearTimeout(autoTimer);
      autoTimer = null;
      if (asCopy || !d.id) { Store.addEstimate(d); estDraft = d; }
      else { Store.updateEstimate(d.id, d); estDraft.status = status; }
      Store.save().then(function () {
        savedAutoDraft();
        toast((status === 'ready' ? '已保存为可用表格' : '已保存为草稿') + (asCopy ? '(副本)' : ''));
        if (after) location.hash = after;
        else location.hash = '#estimates';
      }).catch(function (err) {
        toast('保存失败:' + (err && err.message ? err.message : '请重试'));
        if (err && (err.status === 401 || err.status === 403)) handleAuthExpired();
      }).then(function () {
        savingEstimate = false;
        setSaveBtnLoading(false);
      });
    }
    if (issues.length) {
      showConfirm('相邻批次衔接提醒', issues.join('\n') + '\n\n仍要保存吗?', commit, function () {});
      return true;
    }
    commit();
    return true;
  }

  /** 保存期间给编辑器工具栏主保存按钮加上「保存中…」态 */
  function setSaveBtnLoading(on) {
    const btn = document.querySelector('[data-action="editor-save"]');
    if (!btn) return;
    if (on) { btn.dataset.origHtml = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin" aria-hidden="true"></span><span>保存中…</span>'; }
    else { btn.disabled = false; if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; } }
  }

  /** 导出当前编辑器中的预算表(Excel .xls / PDF 打印)。文件名取名称规格+预算表编号 */
  function exportCurrentSheet(kind) {
    if (!estDraft) return;
    // 先把公式栏未回车内容提交,确保导出的是所见即所得
    if (document.getElementById('fx-input') && !document.getElementById('fx-input').disabled) commitFx();
    const tableEl = document.querySelector('#view-editor .sheet-scroll table');
    if (!tableEl) { toast('当前无预算表可导出'); return; }
    const safeName = String(estDraft.name || '预算表').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const code = String(estDraft.code || '').replace(/[\\/:*?"<>|]/g, '_');
    const base = (safeName + (code ? '_' + code : '')) || '预算表';
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'pdf') {
      // 打印对话框可"另存为 PDF"并自选路径;用 sheet-scroll 容器作为打印区域
      toast('请在打印对话框中选择「另存为 PDF」并指定保存位置');
      Exporter.printSheet(document.querySelector('#view-editor .sheet-scroll'));
      return;
    }
    Exporter.exportXLS(base + '_' + stamp + '.xls', tableEl, safeName)
      .then(function (ok) { if (ok !== false) toast('已导出 Excel:' + base + '.xls'); })
      .catch(function () { toast('导出失败'); });
  }

  // ---------- 退出编辑器三选弹窗 ----------
  function requestLeave(hashTarget) {
    const editorEl = document.getElementById('view-editor');
    const inEditor = editorEl && !editorEl.hidden && estDraft;
    if (!inEditor) { performNav(hashTarget); return true; }
    // 提交公式栏未回车的内容:若有实质改动,视为脏数据
    if (document.getElementById('fx-input') && !document.getElementById('fx-input').disabled) commitFx();
    if (!gridDirty) { performNav(hashTarget); return true; }
    gridPendingNav = hashTarget;
    const missing = requiredMissing();
    $('#exit-missing').textContent = missing.length
      ? '⚠ 尚有 ' + missing.length + ' 项必填未填(如 ' + missing.slice(0, 3).map(function (x) { return x.label + ' ' + x.addr; }).join('、') + '),此状态下只能保存为草稿。'
      : '✓ 必填项已填完,可保存为可用表格。';
    $('#exit-modal').hidden = false;
    return false;
  }
  function performNav(hashTarget) {
    estDraft = null;
    gridSel = null;
    gridCache = null;
    gridPendingNav = null;
    markClean(); // 离开编辑器(discard 等)清本地草稿与 dirty
    location.hash = hashTarget;
  }
  function exitChoice(kind) {
    const target = gridPendingNav || '#estimates';
    if (kind === 'cancel') { $('#exit-modal').hidden = true; gridPendingNav = null; return; }
    $('#exit-modal').hidden = true;
    if (kind === 'discard') { performNav(target); return; }
    if (kind === 'draft') { saveEstimate('draft', false, target); return; }
    if (kind === 'ready') { saveEstimate('ready', false, target); return; }
  }

  // ---------- 成本总揽(跨批次汇总:时间段/砖型/材料 筛选) ----------
  /** 重绘当前所在页(overview 或 charts),保持筛选条不回卷 */
  function rerenderOvlCurrent() {
    const ov = document.getElementById('view-overview');
    if (ov && !ov.hidden) { renderOverview(); return; }
    const cv = document.getElementById('view-charts');
    if (cv && !cv.hidden) { lastChartsSig = null; renderCharts(); }
  }
  /** 根据全选状态同步显示(选中集为空 ⇔ 全部被选中) */
  function syncOvlCheckboxes() {
    const typesAll = !ovlTypes.length, matsAll = !ovlMats.length;
    $$('input[name="ovl-type"]').forEach(function (x) { x.checked = typesAll || ovlTypes.indexOf(x.value) >= 0; });
    $$('input[name="ovl-mat"]').forEach(function (x) { x.checked = matsAll || ovlMats.indexOf(x.value) >= 0; });
    syncOvlAllState();
  }
  function syncOvlAllState() {
    const tAll = $$('input[name="ovl-type"]');
    const tAny = tAll.some(function (x) { return !x.checked; });
    $$('input.ovl-all[data-group="ovl-type"]').forEach(function (x) { x.checked = !tAny; });
    const mAll = $$('input[name="ovl-mat"]');
    const mAny = mAll.some(function (x) { return !x.checked; });
    $$('input.ovl-all[data-group="ovl-mat"]').forEach(function (x) { x.checked = !mAny; });
  }
  /** 生成筛选条 HTML(总揽/图表页共用;目标页 target=overview|charts) */
  function ovlFilterBarHTML(target) {
    const types = allTypes(), mats = allMatNames();
    // 空数组 = 全部:全选态下子项都显示已勾选("全部"也勾),取消某子项即从全部中排除
    const checked = function (arr, val) { return !arr.length || arr.indexOf(val) >= 0 ? ' checked' : ''; };
    const chipSel = function (title, name, list, selArr) {
      return '<div class="ovl-field"><span class="ovl-label">' + esc(title) + '</span><div class="ovl-chips">' +
        '<label class="ovl-chip-all"><input type="checkbox" class="ovl-all" data-group="' + name + '"' + (selArr.length === 0 ? ' checked' : '') + '>全部</label>' +
        list.map(function (x) {
          return '<label class="ovl-chip"><input type="checkbox" name="' + name + '" value="' + esc(x) + '"' + checked(selArr, x) + '>' + esc(x) + '</label>';
        }).join('') + '</div></div>';
    };
    const hasDate = !!(ovlFrom || ovlTo), hasOther = ovlTypes.length || ovlMats.length;
    return '<div class="ovl-filter">' +
      '<div class="ovl-row">' +
        '<span class="ovl-label">' + icon('calendar', 15) + '时间段:</span>' +
        '<input type="date" id="ovl-from" value="' + esc(ovlFrom) + '">' +
        '<span class="ovl-sep">至</span>' +
        '<input type="date" id="ovl-to" value="' + esc(ovlTo) + '">' +
        '<button class="small" data-action="ovl-apply" data-page="' + target + '">应用筛选</button>' +
        ((hasDate || hasOther) ? '<button class="small" data-action="ovl-clear" data-page="' + target + '">清除</button>' : '') +
      '</div>' +
      chipSel('砖型', 'ovl-type', types, ovlTypes) +
      chipSel('材料', 'ovl-mat', mats, ovlMats) +
      '<div class="ovl-count">' + (hasDate || hasOther ? '筛选后:' : '范围:') + ' ' +
        ovlFiltered().length + ' 个批次</div>' +
    '</div>';
  }

  /** 成本总揽页 */
  function renderOverview() {
    const v = $('#view-overview');
    if (!v) return;
    const comps = ovlComps();
    const totalCost = comps.reduce(function (s, x) { return s + (isFinite(x.c.calc.costTotal1) ? x.c.calc.costTotal1 : 0); }, 0);
    const totalKg = comps.reduce(function (s, x) { return s + (isFinite(x.c.listTotals.usageKg) ? x.c.listTotals.usageKg : 0); }, 0);
    const typeRows = typeAggregate(comps).sort(function (a, b) { return b.cost - a.cost; });
    const matRows = matAggregate(comps).sort(function (a, b) { return b.amount - a.amount; });

    const kpi = function (label, val, ic) {
      return '<div class="kpi-card kpi-cost"><span class="kpi-ic">' + icon(ic, 18) + '</span>' +
        '<div class="kpi-body"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + val + '</span></div></div>';
    };
    const noData = '<p class="empty-hint">当前筛选下暂无数据。请调整筛选(时间段/砖型/材料)或先创建估算单。</p>';
    const typeTable = typeRows.length ? '<table class="grid"><thead><tr>' +
      '<th class="l">砖型(型号)</th><th>批次</th><th>成本总价①合计</th><th>平均成本/批</th><th>总用料(公斤)</th></tr></thead><tbody>' +
      typeRows.map(function (r) {
        return '<tr><td class="l">' + esc(r.type) + '</td><td>' + r.n + '</td>' +
          '<td class="money">¥' + fmt(r.cost, 0) + '</td>' +
          '<td class="money">¥' + fmt(r.avg, 2) + '</td>' +
          '<td>' + fmt(r.kg, 0) + '</td></tr>';
      }).join('') + '</tbody></table>' : noData;
    const matTable = matRows.length ? '<table class="grid"><thead><tr>' +
      '<th class="l">材料</th><th>总消耗(公斤)</th><th>消耗金额</th></tr></thead><tbody>' +
      matRows.map(function (r) {
        return '<tr><td class="l">' + esc(r.name) + '</td><td>' + fmt(r.kg, 0) + '</td>' +
          '<td class="money">¥' + fmt(r.amount, 0) + '</td></tr>';
      }).join('') + '</tbody></table>' : noData;

    v.innerHTML =
      '<h2 class="sec-title">成本总揽</h2>' +
      '<div class="ovl-toolbar">' +
        ovlFilterBarHTML('overview') +
        '<button class="primary" data-action="ovl-to-charts" title="按当前筛选在图表预览中看图(新窗口)">' + btnIcon('chart', '生成图表(打开图表预览)') + '</button>' +
      '</div>' +
      (comps.length
        ? '<div class="kpi-row">' +
            kpi('批次', comps.length, 'folder') +
            kpi('成本总价①合计', '¥' + fmt(totalCost, 0), 'chart') +
            kpi('总用料(公斤)', fmt(totalKg, 0), 'calc') +
          '</div>'
        : '') +
      '<div class="ovl-grid">' +
        '<div class="card ovl-card"><h3>按砖型统计</h3>' + typeTable + '</div>' +
        '<div class="card ovl-card"><h3>材料总消耗</h3>' + matTable + '</div>' +
      '</div>' +
      '<p class="editor-note">统计范围基于估算单批次:成本①=本期用料金额合计;平均成本=某砖型成本合计÷其批次数量;材料消耗跨批次按用量/金额汇总(自动,不含手工填的单价列)。</p>';
  }

  // ---------- 历史对比 ----------
  function renderCompare() {
    const v = $('#view-compare');
    const list = data.estimates.slice().reverse();
    const checkboxes = list.map(function (e) {
      return '<label style="margin-right:10px;font-size:13px">' +
        '<input type="checkbox" data-compare-id="' + e.id + '"' + (compareSel.has(e.id) ? ' checked' : '') + '> ' +
        esc(e.name || '(未命名)') + '（' + esc(e.startDate || '无日期') + '）</label>';
    }).join('') || '<span class="empty-hint">暂无估算单</span>';

    const sel = list.filter(function (e) { return compareSel.has(e.id); });
    let table = '';
    if (sel.length >= 2) {
      const comps = sel.map(function (e) { return { e: e, c: CostCalc.compute(e) }; });
      const head = '<tr><th class="l">字段</th>' + comps.map(function (x) {
        return '<th>' + esc(x.e.name || x.e.id) + '</th>';
      }).join('') + '</tr>';
      const fieldRow = function (label, fn) {
        return '<tr><td class="l">' + esc(label) + '</td>' + comps.map(function (x) {
          return '<td>' + fn(x) + '</td>';
        }).join('') + '</tr>';
      };
      const rows = [
        fieldRow('预算表编号', function (x) { return esc(x.e.code || '—'); }),
        fieldRow('开始日期', function (x) { return esc(x.e.startDate || '—'); }),
        fieldRow('结束日期', function (x) { return esc(x.e.endDate || '—'); }),
        fieldRow('编制人', function (x) { return esc(x.e.author || '—'); }),
        fieldRow('底料/面料锅数', function (x) { return fmt(x.e.potBottom, 0) + ' / ' + fmt(x.e.potTop, 0); }),
        fieldRow('本期用料合计(公斤)', function (x) { return fmt(x.c.listTotals.usageKg, 0); }),
        fieldRow('成本总价①(金额合计)', function (x) { return '¥' + fmt(x.c.calc.costTotal1); }),
        fieldRow('成本总价②(吨价×用量)', function (x) { return '¥' + fmt(x.c.calc.costTotal2); }),
        fieldRow('模数', function (x) { return x.c.calc.mold == null ? '—' : fmt(x.c.calc.mold, 0); }),
        fieldRow('计划数', function (x) {
          const v = x.e.calc.planCount;
          return v === '' || v === null || v === undefined ? '—' : fmt(v, 2);
        }),
        fieldRow('实际数', function (x) { return esc(x.e.calc.actualCount || '—'); }),
        fieldRow('成品率', function (x) {
          const v = x.e.calc.yieldRate;
          if (v === '' || v === null || v === undefined) return '—';
          const n = Number(v);
          return isFinite(n) && n < 2 ? pct(n) : String(v);
        }),
        fieldRow('材料吨价(元/吨)', function (x) { return esc(x.e.calc.tonPrice || '—'); }),
        fieldRow('每平方价', function (x) { return esc(x.e.calc.perSqmPrice || '—'); }),
        fieldRow('每块重量(kg)', function (x) { return esc(x.e.calc.perPieceWeight || '—'); }),
        fieldRow('每平方重量(kg)', function (x) { return esc(x.e.calc.perSqmWeight || '—'); })
      ];
      const names = Array.from(new Set(comps.reduce(function (acc, x) {
        x.e.rows.forEach(function (r) { acc.push(r.name); });
        return acc;
      }, [])));
      names.forEach(function (n) {
        rows.push(fieldRow('用料·' + n, function (x) {
          const r = x.e.rows.find(function (rr) { return rr.name === n; });
          if (!r) return '—';
          const rc = x.c.rows.find(function (rr) { return rr.id === r.id; });
          return rc ? fmt(rc.usageKg, 0) + ' 公斤 / ¥' + fmt(rc.usageAmount) : '—';
        }));
      });
      table = '<div class="comp-table-wrap"><table class="grid"><thead>' + head + '</thead><tbody>' +
        rows.join('') + '</tbody></table></div>';
    } else if (sel.length === 1) {
      table = '<p class="compare-note">已选 1 个,再勾选至少 1 个估算单即可对比(需 ≥2 个)。</p>';
    } else {
      table = '<p class="compare-note">请勾选 2 个及以上估算单进行对比。</p>';
    }
    v.innerHTML = '<h2 class="sec-title">历史对比</h2>' +
      '<div class="list-actions">' + checkboxes + '</div>' + table;
  }

  // ---------- 图表预览(懒加载:数据与选择未变时复用已渲染 DOM,不重复重算) ----------
  function chartsSig() {
    return data.estimates.map(function (e) {
      return e.id + '|' + e.name + '|' + e.startDate + '|' + e.status + '|' + (e.rows ? e.rows.length : 0) + '|' + (e.calc ? e.calc.costTotal1 : '');
    }).join('~');
  }
  function renderCharts() {
    const v = $('#view-charts');
    const sig = chartsSig() + '~' + ovlFrom + '~' + ovlTo + '~' + ovlTypes.join(',') + '~' + ovlMats.join(',') + '~' + chartEstId + '~' + chartMatMode;
    if (v && !v.hidden && v.innerHTML && lastChartsSig === sig) {
      return;
    }
    // 筛选后的估算单(新→旧;图表默认用全部可用批次)
    const estimates = ovlFiltered().slice().reverse();
    const hasFilter = !!(ovlFrom || ovlTo || ovlTypes.length || ovlMats.length);
    const filterBar = ovlFilterBarHTML('charts');
    const linkToOv = '<button class="small" data-action="ovl-to-overview" title="按当前筛选到成本总揽查看汇总(新窗口)">' + btnIcon('view', '到成本总揽') + '</button>';
    const head = '<h2 class="sec-title">图表预览</h2>' +
      '<div class="ovl-toolbar">' + filterBar +
        linkToOv +
        '<span class="chart-note" style="margin-left:auto">当前范围' + (hasFilter ? '(已筛选)' : '(全部批次)') + ' · ' + estimates.length + ' 批</span>' +
      '</div>';

    if (!estimates.length) {
      v.innerHTML = head + '<p class="empty-hint">当前筛选下暂无估算单。请调整筛选,或在"估算单"页创建后再查看图表。</p>';
      lastChartsSig = sig;
      return;
    }

    // ---- 环形图:跨批次材料成本构成(所有筛选内批次按材料合计本期用料金额)----
    const donutMap = new Map();
    estimates.forEach(function (e) {
      const c = CostCalc.compute(e);
      c.rows.forEach(function (r) {
        if (ovlMats.length && ovlMats.indexOf(r.name) < 0) return;
        if (!donutMap.has(r.name)) donutMap.set(r.name, 0);
        donutMap.set(r.name, donutMap.get(r.name) + (isFinite(r.usageAmount) ? r.usageAmount : 0));
      });
    });
    const donutItems = Array.from(donutMap.entries()).map(function (kv) { return { name: kv[0], value: kv[1] }; })
      .sort(function (a, b) { return b.value - a.value; });
    const donutTotal = donutItems.reduce(function (s, it) { return s + it.value; }, 0);

    // ---- 柱状图 / 折线图:按开始日期升序(筛选后各批次)----
    const chrono = estimates.slice().sort(function (a, b) {
      const da = a.startDate || '', db = b.startDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const shortLabel = function (e) {
      const nm = Charts.esc(e.name || e.id);
      return [nm.length > 10 ? nm.slice(0, 10) + '…' : nm, e.startDate || ''];
    };
    const groups = chrono.map(function (e) {
      const c = CostCalc.compute(e);
      return { id: e.id, label: shortLabel(e), a: c.calc.costTotal1, b: c.calc.costTotal2 };
    });

    // ---- 材料汇总(跨批次,按名称合并)----
    const matMap = new Map();
    estimates.forEach(function (e) {
      const c = CostCalc.compute(e);
      c.rows.forEach(function (r) {
        if (ovlMats.length && ovlMats.indexOf(r.name) < 0) return;
        if (!matMap.has(r.name)) matMap.set(r.name, { kg: 0, amount: 0 });
        const o = matMap.get(r.name);
        o.kg += r.usageKg;
        o.amount += r.usageAmount;
      });
    });
    const matItems = Array.from(matMap.entries()).map(function (kv) {
      return { name: kv[0], kg: kv[1].kg, amount: kv[1].amount };
    });
    const matByAmount = matItems.slice().sort(function (x, y) { return y.amount - x.amount; })
      .map(function (x) { return { name: x.name, value: x.amount }; });
    const matByKg = matItems.slice().sort(function (x, y) { return y.kg - x.kg; })
      .map(function (x) { return { name: x.name, value: x.kg }; });
    const matItemsHTML = chartMatMode === 'kg'
      ? Charts.hbarHTML(matByKg, 'kg')
      : Charts.hbarHTML(matByAmount, 'amount');

    v.innerHTML = head +
      '<div class="chart-grid">' +
        '<div class="chart-card">' +
          '<div class="chart-head"><h3>材料成本构成(跨批次 · 本期用料金额)</h3>' +
            '<span class="chart-note">全部筛选批次按材料汇总;点击扇区打开相关批次</span></div>' +
          (donutTotal > 0 ? Charts.donutHTML(donutItems, donutTotal, null) : '<p class="empty-hint">当前筛选下无用料金额数据</p>') +
        '</div>' +
        '<div class="chart-card">' +
          '<div class="chart-head"><h3>批次成本总价对比</h3><span class="chart-note">① 金额合计 / ② 吨价×用量 · 点击柱子查看批次</span></div>' +
          Charts.barHTML(groups) +
        '</div>' +
        '<div class="chart-card">' +
          '<div class="chart-head"><h3>批次成本趋势</h3><span class="chart-note">按开始日期排序' + (groups.length < 2 ? ' · 至少需 2 个批次' : '') + '</span></div>' +
          (groups.length >= 2 ? Charts.lineHTML(groups) : '<p class="empty-hint">至少需要 2 个批次才能绘制趋势</p>') +
        '</div>' +
        '<div class="chart-card">' +
          '<div class="chart-head"><h3>材料用量 / 金额汇总(跨批次)</h3>' +
            '<div class="seg" id="chart-mat-mode">' +
              '<button class="seg-btn' + (chartMatMode === 'amount' ? ' active' : '') + '" data-mode="amount">按金额</button>' +
              '<button class="seg-btn' + (chartMatMode === 'kg' ? ' active' : '') + '" data-mode="kg">按用量(公斤)</button>' +
            '</div></div>' +
          matItemsHTML +
        '</div>' +
      '</div>';
    lastChartsSig = sig;
  }

  // ---------- 事件委托 ----------
  document.addEventListener('input', function (e) {
    const el = e.target;
    if (!el.matches || !el.matches('input[data-path]')) return;
    const root = currentDraft();
    if (!root) return;
    setByPath(root, el.dataset.path, el.value);
    // 同步同一路径的其他输入框(如配比表与材料清单中的"单价")
    $$('input[data-path="' + el.dataset.path + '"]').forEach(function (o) {
      if (o !== el) o.value = el.value;
    });
  });

  document.addEventListener('change', function (e) {
    const el = e.target;
    if (!el.matches) return;
    if (el.matches('input[data-compare-id]')) {
      if (el.checked) compareSel.add(el.dataset.compareId);
      else compareSel.delete(el.dataset.compareId);
      renderCompare();
      return;
    }
    if (el.matches('select[data-path]')) {
      const root = currentDraft();
      if (!root) return;
      setByPath(root, el.dataset.path, el.value);
      return;
    }
    if (el.matches('select[data-zone-of]')) {
      const m = Store.materialById(el.dataset.zoneOf);
      if (m) {
        m.zone = el.value;
        saveAndRefresh(function () { toast('已更新所属区'); });
      }
      return;
    }
    if (el.id === 'chart-est-select') {
      chartEstId = el.value;
      renderCharts();
      return;
    }
    if (el.id === 'grid-pick-product') {
      applyProductPick(el.value);
      // 恢复为占位选项,便于下次再次选择同一产品
      const selEl = $('#grid-pick-product');
      if (selEl) selEl.value = '';
    }
    // 估算单列表日期筛选
    if (el.id === 'est-date-from' || el.id === 'est-date-to') {
      const f = $('#est-date-from'), t = $('#est-date-to');
      let fv = f ? f.value : '', tv = t ? t.value : '';
      // 非法区间(开始>结束):提示并回滚本次输入,维持原筛选
      if (fv && tv && fv > tv) {
        toast('开始日期不能晚于结束日期');
        const prevFrom = estDateFrom, prevTo = estDateTo;
        if (el.id === 'est-date-from') { estDateFrom = prevFrom; estDateTo = prevTo; fv = prevFrom; if (f) f.value = prevFrom; }
        else { estDateFrom = prevFrom; estDateTo = prevTo; tv = prevTo; if (t) t.value = prevTo; }
      }
      if (estDateFrom !== fv || estDateTo !== tv) {
        estDateFrom = fv;
        estDateTo = tv;
        renderEstimates();
      }
      return;
    }
    // 成本总揽/图表筛选:日期、多选即时生效(应用按钮用于确认后跳转)
    if (el.id === 'ovl-from' || el.id === 'ovl-to') {
      const f = $('#ovl-from'), t = $('#ovl-to');
      const fv = f ? f.value : '', tv = t ? t.value : '';
      if (fv && tv && fv > tv) { toast('开始日期不能晚于结束日期'); if (el.id === 'ovl-from') { f.value = ovlFrom; } else { t.value = ovlTo; } return; }
      ovlFrom = fv; ovlTo = tv;
      rerenderOvlCurrent();
      return;
    }
    if (el.matches('input.ovl-all[data-group]')) {
      const g = el.dataset.group;
      if (g === 'ovl-type') ovlTypes = el.checked ? [] : allTypes();
      if (g === 'ovl-mat') ovlMats = el.checked ? [] : allMatNames();
      syncOvlCheckboxes();
      rerenderOvlCurrent();
      return;
    }
    if (el.matches('input[name="ovl-type"]')) {
      const sel = Array.from(document.querySelectorAll('input[name="ovl-type"]:checked')).map(function (x) { return x.value; });
      const all = allTypes();
      ovlTypes = sel.length === all.length && all.length ? [] : sel; // 全部勾选等价于"全部"(空)
      syncOvlAllState();
      rerenderOvlCurrent();
      return;
    }
    if (el.matches('input[name="ovl-mat"]')) {
      const sel = Array.from(document.querySelectorAll('input[name="ovl-mat"]:checked')).map(function (x) { return x.value; });
      const all = allMatNames();
      ovlMats = sel.length === all.length && all.length ? [] : sel;
      syncOvlAllState();
      rerenderOvlCurrent();
      return;
    }
  });

  document.addEventListener('click', function (e) {
    // 图表联动:点击柱子/数据点/环形段 → 打开对应估算单
    const chartOpen = e.target.closest('[data-chart-open]');
    if (chartOpen) { location.hash = '#estimate/' + chartOpen.dataset.chartOpen; return; }
    // 图表联动:材料汇总切换 按金额/按用量
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn && modeBtn.closest('#chart-mat-mode')) {
      chartMatMode = modeBtn.dataset.mode;
      renderCharts();
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const i = btn.dataset.i;

    switch (action) {
      case 'ovl-clear': {
        ovlFrom = ''; ovlTo = ''; ovlTypes = []; ovlMats = [];
        ovlCur = btn.dataset && btn.dataset.page ? btn.dataset.page : 'overview';
        if (ovlCur === 'charts') { lastChartsSig = null; renderCharts(); } else renderOverview();
        break;
      }
      case 'ovl-to-charts':
      case 'ovl-to-overview': {
        const target = action === 'ovl-to-charts' ? 'charts' : 'overview';
        ovlCur = target;
        // 同源新窗口:通过 sessionStorage 传递当前筛选;新窗口应用前先读回
        try {
          sessionStorage.setItem('ovlFilter', JSON.stringify({ from: ovlFrom, to: ovlTo, types: ovlTypes, mats: ovlMats }));
        } catch (e) { /* 隐私模式等场景忽略 */ }
        const url = location.pathname + location.search + '#ovl-' + target + '?f=1';
        if (e && e.shiftKey) { location.hash = '#' + (target === 'charts' ? 'ovl-charts' : 'ovl-overview'); }
        else {
          try { window.open(url, '_blank'); } catch (err) { location.hash = '#' + (target === 'charts' ? 'ovl-charts' : 'ovl-overview'); }
        }
        break;
      }
      case 'add-material': {
        const name = $('#new-mat-name').value.trim();
        const zone = $('#new-mat-zone').value;
        if (!name) { toast('请输入材料名称'); return; }
        Store.addMaterial(name, zone);
        saveAndRefresh(function () { renderMaterials(); toast('已添加材料:' + name); });
        break;
      }
      case 'del-material': {
        if (!confirm('确认删除该材料?')) return;
        const r = Store.deleteMaterial(id);
        if (!r.ok) { toast(r.reason); return; }
        saveAndRefresh(function () { renderMaterials(); toast('已删除'); });
        break;
      }
      case 'new-product':
        editingProductId = null;
        productFormDraft = { name: '', code: '', recipe: [] };
        renderProducts();
        break;
      case 'edit-product': {
        const p = data.products.find(function (x) { return x.id === id; });
        if (!p) return;
        editingProductId = id;
        productFormDraft = JSON.parse(JSON.stringify({ name: p.name, code: p.code, recipe: p.recipe }));
        renderProducts();
        break;
      }
      case 'del-product': {
        if (!confirm('确认删除该产品?其历史估算单保留快照,但解除关联。')) return;
        Store.deleteProduct(id);
        saveAndRefresh(function () { renderProducts(); toast('已删除产品'); });
        break;
      }
      case 'pf-add-row': {
        const sel = $('#pf-add-mat');
        if (!sel || !sel.value) { toast('没有可添加的材料'); return; }
        productFormDraft.recipe.push({ materialId: sel.value, qtyPerPot: 0 });
        renderProducts();
        break;
      }
      case 'pf-del-row':
        productFormDraft.recipe.splice(Number(i), 1);
        renderProducts();
        break;
      case 'save-product': {
        if (!productFormDraft.name.trim()) { toast('请填写名称规格'); return; }
        const pname = productFormDraft.name.trim();
        const recipeCount = productFormDraft.recipe.length;
        const doSave = function () {
          const sb = document.querySelector('[data-action="save-product"]');
          if (sb) { sb.disabled = true; sb.innerHTML = '<span class="spin" aria-hidden="true"></span><span>保存中…</span>'; }
          if (editingProductId) {
            Store.updateProduct(editingProductId, JSON.parse(JSON.stringify(productFormDraft)));
          } else {
            Store.addProduct(pname, productFormDraft.code, JSON.parse(JSON.stringify(productFormDraft.recipe)));
          }
          saveAndRefresh(function () {
            editingProductId = null;
            productFormDraft = null;
            renderProducts();
            toast('产品已保存');
          }, function () { if (productFormDraft) renderProducts(); });
        };
        showConfirm('确认保存产品配方', '确定保存产品「' + pname + '」(配方 ' + recipeCount + ' 个材料)吗?', doSave, null);
        break;
      }
      case 'cancel-product':
        editingProductId = null;
        productFormDraft = null;
        renderProducts();
        break;
      case 'est-date-clear':
        estDateFrom = '';
        estDateTo = '';
        renderEstimates();
        break;
      case 'new-estimate': {
        const pid = $('#new-est-prod').value;
        location.hash = '#new-estimate/' + pid;
        break;
      }
      case 'view-estimate':
        location.hash = '#estimate/' + id;
        break;
      case 'clone-estimate':
        Store.cloneEstimate(id);
        saveAndRefresh(function () { renderEstimates(); toast('已复制为新估算单'); });
        break;
      case 'del-estimate':
        if (!confirm('确认删除该估算单?')) return;
        Store.deleteEstimate(id);
        saveAndRefresh(function () { renderEstimates(); toast('已删除'); });
        break;
      case 'editor-back':
        requestLeave('#estimates');
        break;
      case 'editor-save':
        saveEstimate('ready', false);
        break;
      case 'editor-save-draft':
        saveEstimate('draft', false);
        break;
      case 'editor-save-copy': {
        // 副本:全部必填已填则按可用表格保存,否则按草稿并提示
        const ready = requiredMissing().length === 0;
        saveEstimate(ready ? 'ready' : 'draft', true);
        break;
      }
      case 'editor-export-xls':
        exportCurrentSheet('xls');
        break;
      case 'editor-export-pdf':
        exportCurrentSheet('pdf');
        break;
      case 'editor-add-material': {
        const sel = $('#editor-add-mat');
        if (!sel || !sel.value) { toast('没有可添加的材料'); return; }
        const m = Store.materialById(sel.value);
        estDraft.rows.push({
          id: uid(), materialId: m.id, name: m.name, zone: m.zone,
          qtyPerPot: '', price: '', stockOnHand: '', stockIn: '', qty: ''
        });
        markDirty();
        clearGridOverrides('材料行结构已变化,已清空公式覆盖');
        renderEstimateEditor();
        break;
      }
      case 'editor-del-mat':
        if (!confirm('确认移除该材料行?')) return;
        estDraft.rows.splice(Number(btn.dataset.idx), 1);
        markDirty();
        clearGridOverrides('材料行结构已变化,已清空公式覆盖');
        renderEstimateEditor();
        break;
      case 'apply-prev-stock': {
        // 按"上存=上一编号批次库存"一键填入(仅改提示中列出的差异材料)
        const prev = prevBatchOf(estDraft.code, estDraft.id);
        if (!prev) { toast('未找到同编号的上一批次'); break; }
        const ref = prevStockMap(prev);
        let applied = 0;
        estDraft.rows.forEach(function (r) {
          if (ref[r.name] === undefined) return;
          const cur = (r.stockOnHand === '' || r.stockOnHand === null || r.stockOnHand === undefined) ? null : Number(r.stockOnHand);
          if (cur === null || Math.abs(cur - ref[r.name]) > 1e-9) {
            r.stockOnHand = ref[r.name];
            applied++;
          }
        });
        if (applied) {
          markDirty();
          // 清理可能存在的该列覆盖并重算
          Object.keys(gridOverV).forEach(function (a) {
            const def = gridCache && gridCache.addrCells[a];
            if (def && def.path && /\.stockOnHand$/.test(def.path)) delete gridOverV[a];
          });
          gridEval();
          paintAll(gridCache);
          renderEstimateEditor();
          toast('已按上一批次填入 ' + applied + ' 种材料的上存(库存)');
        } else {
          toast('上存材料已与上一批次一致,无需调整');
        }
        break;
      }
      case 'db-snapshot':
        Store.authedFetch('/api/db/backup', { method: 'POST' })
          .then(function (resp) { return resp.json().then(function (j) { return { j: j, status: resp.status }; }); })
          .then(function (pair) {
            const j = pair.j;
            if (j.ok) toast('快照备份完成:' + j.file);
            else if (j.error) { toast('快照失败:' + j.error); if (j.error.indexOf('登录') >= 0 || j.error.indexOf('会话') >= 0) handleAuthExpired(); }
            else toast('快照失败:HTTP ' + pair.status);
          }).catch(function () { toast('快照失败:无法连接服务'); });
        break;
      case 'db-export': {
        Store.authedFetch('/api/db/export', { method: 'POST' })
          .then(function (r) {
            if (!r.ok) {
              return r.json().then(function (j) { throw new Error((j && j.error) || 'HTTP ' + r.status); });
            }
            return Promise.all([r.blob(), Promise.resolve(r.headers.get('Content-Disposition') || '')]);
          })
          .then(function (pair) {
            const blob = pair[0], cd = pair[1];
            const m = /filename="([^"]+)"/.exec(cd);
            const name = m ? m[1] : 'brick-data.zip';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
            toast('已导出:' + name);
          }).catch(function (err) {
            if (err && err.message && (err.message.indexOf('登录') >= 0 || err.message.indexOf('会话') >= 0)) handleAuthExpired();
            toast('导出失败:' + (err && err.message ? err.message : '无法连接服务'));
          });
        break;
      }
      case 'db-import':
        $('#import-file').click();
        break;
      case 'users-add': {
        const name = $('#new-user-name').value.trim();
        const pw = $('#new-user-pw').value;
        if (!name) { toast('请输入用户名'); return; }
        if (pw.length < 6) { toast('初始密码至少 6 位'); return; }
        Store.addUser(name, pw, $('#new-user-nick').value.trim(), $('#new-user-role').value)
          .then(function () {
            $('#new-user-pw').value = '';
            renderUsers();
            toast('已新增用户:' + name);
          }).catch(function (err) {
            toast('新增失败:' + err.message);
            if (err.status === 401 || err.status === 403) handleAuthExpired();
          });
        break;
      }
      case 'users-del': {
        const uname = btn.dataset.username;
        if (!confirm('确认删除用户「' + uname + '」?')) return;
        Store.deleteUser(uname)
          .then(function () { renderUsers(); toast('已删除:' + uname); })
          .catch(function (err) { toast('删除失败:' + err.message); if (err.status === 401 || err.status === 403) handleAuthExpired(); });
        break;
      }
      case 'users-reset-pw': {
        const uname = btn.dataset.username;
        const pw = prompt('为「' + uname + '」设置新密码(≥6位):');
        if (pw === null) return;
        if (pw.length < 6) { toast('密码至少 6 位'); return; }
        Store.updateUser(uname, { password: pw })
          .then(function () { toast('已重置「' + uname + '」的密码'); })
          .catch(function (err) { toast('重置失败:' + err.message); if (err.status === 401 || err.status === 403) handleAuthExpired(); });
        break;
      }
    }
  });

  // 角色下拉即时生效(用户管理页)
  document.addEventListener('change', function (e) {
    const sel = e.target.closest && e.target.closest('select[data-role-of]');
    if (!sel) return;
    Store.updateUser(sel.dataset.roleOf, { role: sel.value })
      .then(function () { toast('已更新角色:' + sel.dataset.roleOf); })
      .catch(function (err) {
        toast('更新角色失败:' + err.message);
        if (err.status === 401 || err.status === 403) handleAuthExpired(); else renderUsers();
      });
  });

  // 导入文件选择后确认
  document.addEventListener('change', function (e) {
    const f = $('#import-file');
    if (!f || !e.target || e.target !== f || !f.files || !f.files.length) return;
    const file = f.files[0];
    const doImport = function () {
      const reader = new FileReader();
      reader.onload = function () {
        Store.authedFetch('/api/db/import', { method: 'POST', body: reader.result })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            f.value = '';
            if (j.ok) { toast('导入成功,即将刷新数据'); setTimeout(function () { location.reload(); }, 600); }
            else {
              if (j.error && (j.error.indexOf('登录') >= 0 || j.error.indexOf('会话') >= 0)) handleAuthExpired();
              toast('导入失败:' + (j.error || ''));
            }
          }).catch(function () { f.value = ''; toast('导入失败:无法连接服务'); });
      };
      reader.readAsArrayBuffer(file);
    };
    showConfirm('确认导入数据', '导入将覆盖当前业务数据(材料/产品/估算单)。导入前系统会自动做一次快照备份,可随时恢复。确定导入文件「' + file.name + '」吗?', doImport, function () { f.value = ''; });
  });

  // 退出编辑器三选弹窗 / 确认弹窗按钮
  document.addEventListener('click', function (e) {
    const b = e.target.closest('[data-exit-choice]');
    if (b) { exitChoice(b.dataset.exitChoice); return; }
    if (e.target.closest('#confirm-ok') && !$('#confirm-modal').hidden) {
      const cb = confirmOkCb;
      hideConfirm();
      if (cb) cb();
      return;
    }
    if (e.target.closest('#confirm-cancel') && !$('#confirm-modal').hidden) {
      const cb = confirmCancelCb;
      hideConfirm();
      if (cb) cb();
    }
  });

  $('#tabs').addEventListener('click', function (e) {
    const t = e.target.closest('.tab');
    if (t) requestLeave('#' + t.dataset.view);
  });

  // ---------- 登录/注册表单 ----------
  $('#auth-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const msgEl = $('#auth-msg');
    if (!username || !password) { msgEl.textContent = '请输入用户名和密码'; return; }
    msgEl.textContent = '';
    try {
      if (authMode === 'login') {
        currentUser = await Store.login(username, password);
        await afterAuth();
      } else {
        const nickname = $('#auth-nickname').value.trim();
        const user = await Store.register(username, password, nickname);
        $('#auth-username').value = username;
        $('#auth-password').value = '';
        showAuth('login');
        msgEl.textContent = '注册成功' + (user.role === 'admin' ? '(已设为管理员)' : '') + ',请登录';
      }
    } catch (err) {
      msgEl.textContent = err.message || '操作失败';
    }
  });

  document.addEventListener('click', function (e) {
    const toggle = e.target.closest('#auth-toggle');
    if (toggle) { e.preventDefault(); showAuth(authMode === 'login' ? 'register' : 'login'); return; }
    if (e.target.closest('#btn-logout')) {
      Store.logout().then(function () {
        resetSessionState();
        currentUser = null;
        $('#user-area').hidden = true;
        $('#tab-users').hidden = true;
        const impBtn = $('#sysbar-import');
        if (impBtn) impBtn.hidden = true;
        location.hash = '';
        showAuth('login');
        toast('已退出登录');
      });
    }
    // 退出系统:停止本地服务(需重新双击 启动.bat 才能再用)
    if (e.target.closest('#btn-shutdown')) {
      showConfirm('确认退出系统?',
        '点击「确认退出」将停止本地服务并关闭页面,之后需要重新双击「启动.bat」才能再次使用本系统。\n\n未保存的编辑会自动存为本机草稿,下次打开可恢复。确定退出吗?',
        function () { shutdownSystem(); }, null);
    }
  });

  /** 停止服务并进入"已退出"提示页 */
  function shutdownSystem() {
    const finish = function () {
      const tip = document.getElementById('shutdown-screen');
      if (tip) {
        tip.hidden = false;
        document.querySelectorAll('.view, #auth-screen, .app-header').forEach(function (el) { if (el) el.style.display = 'none'; });
        const m = document.getElementById('toast'); if (m) m.hidden = true;
      }
      // 尝试关闭标签页(多数浏览器仅允许关闭脚本打开的窗口;被拒则用户看到提示页后手动关)
      setTimeout(function () { try { window.close(); } catch (e) { /* 忽略 */ } }, 200);
    };
    if (Store.token) {
      fetch('/api/system/shutdown', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + Store.token }
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (j && j.ok) { finish(); } else { toast('退出系统失败,请稍后重试'); } })
        .catch(function () { toast('无法连接服务,可能已停止'); finish(); });
    } else {
      toast('未登录,无需退出系统');
    }
  }

  // ---------- 表格编辑器交互(单元格选择 / 公式栏回车 / Esc 还原) ----------
  document.addEventListener('click', function (e) {
    const v = document.getElementById('view-editor');
    if (!v || v.hidden) return;
    const td = e.target.closest && e.target.closest('td[data-addr]');
    if (!td || !v.contains(td)) return;
    if (td.dataset.editable) selectCell(td.dataset.addr);
    else { commitFx(); gridSel = null; updateFxBar(); repaintSel(); }
  });
  document.addEventListener('keydown', function (e) {
    const inputEl = $('#fx-input');
    if (!inputEl || inputEl.disabled || document.activeElement !== inputEl) return;
    if (e.key === 'Enter') { commitFx(); }
    else if (e.key === 'Escape') { updateFxBar(); }
  });

  window.addEventListener('hashchange', applyHash);
  // P2:刷新/关闭前若有未保存编辑,提醒(草稿已自动存本机,可恢复)
  window.addEventListener('beforeunload', function (e) {
    const editorEl = document.getElementById('view-editor');
    if (!editorEl || editorEl.hidden || !estDraft) return;
    if (gridDirty) {
      e.preventDefault();
      e.returnValue = ''; // 触发浏览器"离开?"提示(编辑内容已自动存本机草稿)
    }
  });

  // ---------- 登录 / 注册 / 用户管理 ----------
  let authMode = 'login';
  function showAuth(mode) {
    authMode = mode || 'login';
    $('#auth-screen').style.display = 'flex';
    $('#auth-submit').textContent = authMode === 'login' ? '登 录' : '注 册';
    $('#auth-sub').textContent = authMode === 'login'
      ? '请登录后使用'
      : '创建账号;除内置 admin 外的首个注册账号自动成为管理员';
    $('#auth-nickname-wrap').hidden = authMode !== 'register';
    $('#auth-msg').textContent = '';
    $('#auth-password').type = 'password';
    $('#auth-username').focus();
  }
  function hideAuth() { $('#auth-screen').style.display = 'none'; }
  function renderUserBar() {
    $('#user-area').hidden = false;
    $('#user-badge').textContent = (currentUser.nickname || currentUser.username) + ' · ' + (currentUser.role === 'admin' ? '管理员' : '普通用户');
    $('#tab-users').hidden = currentUser.role !== 'admin';
    // 导入恢复为管理员专属(备份快照/导出则登录即可用)
    const impBtn = $('#sysbar-import');
    if (impBtn) impBtn.hidden = currentUser.role !== 'admin';
  }
  async function afterAuth() {
    renderUserBar();
    data = await Store.load();
    hideAuth();
    if (!location.hash) {
      // 默认进入「估算单」列表界面(不再直接打开最近估算单的表格编辑器)
      location.hash = '#estimates';
      return;
    }
    applyHash();
  }
  function handleAuthExpired() {
    resetSessionState();
    Store.token = '';
    currentUser = null;
    $('#user-area').hidden = true;
    $('#tab-users').hidden = true;
    const impBtn = $('#sysbar-import');
    if (impBtn) impBtn.hidden = true;
    showAuth('login');
    toast('登录已过期,请重新登录');
  }

  /** 清空当前会话的所有内存状态(登出/会话过期共用,避免残留给下一个登录用户) */
  function resetSessionState() {
    data = null;
    estDraft = null;
    gridOverF = {};
    gridOverV = {};
    gridSel = null;
    gridCache = null;
    gridPendingNav = null;
    markClean(); // 清本地自动草稿与 dirty
    lastEditorHash = null;
    compareSel.clear();
    chartEstId = null;
    chartMatMode = 'amount';
    lastChartsSig = null;
    lastChartId = null;
    lastMatMode = null;
    estDateFrom = '';
    estDateTo = '';
    productFormDraft = null;
    editingProductId = null;
  }

  // ---------- 用户管理(仅 admin) ----------
  function renderUsers() {
    const v = $('#view-users');
    Store.listUsers().then(function (users) {
      const rows = users.map(function (u) {
        return '<tr>' +
          '<td class="l">' + esc(u.username) + (u.username === currentUser.username ? ' (我)' : '') + '</td>' +
          '<td>' + esc(u.nickname || '') + '</td>' +
          '<td><select data-role-of="' + esc(u.username) + '">' +
            '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>普通用户</option>' +
            '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>管理员</option>' +
          '</select></td>' +
          '<td>' + esc((u.createdAt || '').slice(0, 10)) + '</td>' +
          '<td>' +
            '<button class="small" data-action="users-reset-pw" data-username="' + esc(u.username) + '">' + btnIcon('edit', '重置密码') + '</button> ' +
            (u.username !== currentUser.username
              ? '<button class="danger small" data-action="users-del" data-username="' + esc(u.username) + '">' + btnIcon('trash', '删除') + '</button>' : '') +
          '</td>' +
        '</tr>';
      }).join('');
      v.innerHTML =
        '<h2 class="sec-title">用户管理(管理员)</h2>' +
        '<p style="color:#888;font-size:12px">可新增用户、修改角色、重置密码或删除;不能删除自己,且系统至少保留一名管理员。</p>' +
        '<div class="list-actions">' +
          '<input id="new-user-name" type="text" placeholder="用户名">' +
          '<input id="new-user-nick" type="text" placeholder="昵称(可选)">' +
          '<input id="new-user-pw" type="password" placeholder="初始密码(≥6位)">' +
          '<select id="new-user-role"><option value="user">普通用户</option><option value="admin">管理员</option></select>' +
          '<button class="primary" data-action="users-add">' + btnIcon('plus', '新增用户') + '</button>' +
        '</div>' +
        '<table class="grid"><thead><tr><th class="l">用户名</th><th>昵称</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    }).catch(function (err) {
      toast('加载用户失败:' + err.message);
      if (err.status === 401 || err.status === 403) handleAuthExpired();
    });
  }

  // ---------- 启动 ----------
  async function boot() {
    // 自动化测试通道:?autologin=1 直接以内置 admin 登录(仅测试/演示用)
    if (!Store.token && /(?:^|[?&])autologin=1(?:&|$)/.test(location.search)) {
      try {
        currentUser = await Store.login('admin', 'admin123');
        // 登录成功后移除 autologin 参数,避免退出登录后刷新又自动登回 admin
        const url = new URL(location.href);
        url.searchParams.delete('autologin');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (err) { /* 继续走正常登录页 */ }
    }
    if (!currentUser && Store.token) {
      try { currentUser = await Store.me(); }
      catch (err) {
        if (err.status === 401) Store.token = '';
      }
    }
    if (currentUser) {
      try { await afterAuth(); }
      catch (err) {
        if (err.status === 401) { handleAuthExpired(); return; }
        const be = $('#boot-error');
        be.hidden = false;
        be.innerHTML = '<h2>无法连接本地服务</h2>' +
          '<p>' + esc(err.message) + '</p>' +
          '<p>请先启动服务:双击 <b>启动.bat</b>(或在命令行执行 <code>node server.js</code>)。</p>';
      }
    } else {
      showAuth('login');
    }
  }
  boot();
})();
