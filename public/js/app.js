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

  // ---------- 视图切换(hash 路由,支持深链) ----------
  function switchView(name) {
    if (name === 'users' && (!currentUser || currentUser.role !== 'admin')) {
      toast('仅管理员可访问用户管理');
      location.hash = '#estimates';
      return;
    }
    currentView = name;
    $$('.view').forEach(function (s) { s.hidden = s.id !== 'view-' + name; });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === name); });
    if (name === 'materials') renderMaterials();
    else if (name === 'products') renderProducts();
    else if (name === 'estimates') renderEstimates();
    else if (name === 'charts') renderCharts();
    else if (name === 'compare') renderCompare();
    else if (name === 'users') renderUsers();
  }

  /** 根据 location.hash 切换视图:#materials / #products / #estimates / #compare / #users / #estimate/<id> / #new-estimate[/<产品id>] */
  function applyHash() {
    // 未登录或数据未加载(登出/会话过期后 hash 变化)时不渲染业务视图
    if (!currentUser || !data) return;
    const h = location.hash.replace(/^#/, '');
    const parts = h.split('/');
    const name = parts[0];
    const id = parts[1];
    if (name === 'estimate' && id) { openEstimateEditor(id); return; }
    if (name === 'new-estimate') { openEstimateEditor(null, id); return; }
    if (name === 'editor') { estDraft = null; location.hash = '#estimates'; return; }
    if (name === 'materials' || name === 'products' || name === 'estimates' || name === 'charts' || name === 'compare' || name === 'users') {
      switchView(name);
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
        '<td><button class="danger small" data-action="del-material" data-id="' + m.id + '">删除</button></td>' +
      '</tr>';
    }).join('');
    v.innerHTML =
      '<h2 class="sec-title">材料管理</h2>' +
      '<p style="color:#666;font-size:12px">材料名称与所属区(底料/面料)。被产品配方或估算单引用的材料不能删除。已预置原表 11 种材料。</p>' +
      '<div class="list-actions">' +
        '<input id="new-mat-name" type="text" placeholder="材料名称,如:黑水泥">' +
        '<select id="new-mat-zone"><option value="底料">底料</option><option value="面料">面料</option></select>' +
        '<button class="primary" data-action="add-material">添加材料</button>' +
      '</div>' +
      '<table class="grid"><thead><tr><th class="l">材料名称</th><th>所属区</th><th>操作</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="3" class="empty-hint">暂无材料</td></tr>') + '</tbody></table>';
  }

  // ---------- 产品与配方 ----------
  function renderProducts() {
    const v = $('#view-products');
    const list = data.products.map(function (p) {
      return '<tr>' +
        '<td class="l">' + esc(p.name) + '</td>' +
        '<td>' + esc(p.code || '—') + '</td>' +
        '<td>' + p.recipe.length + ' 种</td>' +
        '<td><button class="small" data-action="edit-product" data-id="' + p.id + '">编辑配方</button> ' +
            '<button class="danger small" data-action="del-product" data-id="' + p.id + '">删除</button></td>' +
      '</tr>';
    }).join('');
    const form = productFormDraft ? renderProductForm() : '';
    v.innerHTML =
      '<h2 class="sec-title">产品与配方</h2>' +
      form +
      '<div class="list-actions"><button class="primary" data-action="new-product">新建产品</button></div>' +
      '<table class="grid"><thead><tr><th class="l">名称规格</th><th>产品编号</th><th>配方材料数</th><th>操作</th></tr></thead>' +
      '<tbody>' + (list || '<tr><td colspan="4" class="empty-hint">暂无产品,点击"新建产品"创建</td></tr>') + '</tbody></table>';
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
        '<button class="small" data-action="pf-add-row">添加材料</button>' +
        '<button class="primary" data-action="save-product">保存产品</button>' +
        '<button data-action="cancel-product">取消</button>' +
      '</div></div>';
  }

  // ---------- 估算单列表 ----------
  function renderEstimates() {
    const v = $('#view-estimates');
    const prodOpts = data.products.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + '（' + esc(p.code || '无编号') + '）</option>';
    }).join('');
    const rows = data.estimates.slice().reverse().map(function (e) {
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
        '<td>' +
          '<button class="small" data-action="view-estimate" data-id="' + e.id + '">查看/编辑</button> ' +
          '<button class="small" data-action="clone-estimate" data-id="' + e.id + '">复制</button> ' +
          '<button class="danger small" data-action="del-estimate" data-id="' + e.id + '">删除</button>' +
        '</td>' +
      '</tr>';
    }).join('');
    v.innerHTML =
      '<h2 class="sec-title">估算单(批次)</h2>' +
      '<div class="list-actions">' +
        '<span>基于产品新建:</span>' +
        '<select id="new-est-prod"><option value="">(空白估算单)</option>' + prodOpts + '</select>' +
        '<button class="primary" data-action="new-estimate">新建估算单</button>' +
      '</div>' +
      '<table class="grid"><thead><tr>' +
        '<th class="l">名称规格</th><th>产品编号</th><th>状态</th><th>开始日期</th><th>结束日期</th><th>编制人</th>' +
        '<th>底料/面料锅数</th><th>成本总价①</th><th>成本总价②</th><th>操作</th>' +
      '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="10" class="empty-hint">暂无估算单,点击"新建估算单"创建</td></tr>') + '</tbody></table>';
  }

  // ---------- 估算单编辑器 ----------
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
      name: p ? p.name : '', code: p ? p.code : '',
      startDate: today(), endDate: '', author: '',
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
    switchView('editor');
    renderEstimateEditor();
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
        '<button data-action="editor-back">← 返回估算单列表</button>' +
        '<h3 class="editor-title">' + (d.id ? '编辑估算单 · 表格模式' : '新建估算单 · 表格模式') + '</h3>' +
        '<span class="tag ' + (d.status === 'ready' ? 'tag-ready' : 'tag-draft') + '" id="editor-status-tag">' + (d.status === 'ready' ? '可用表格' : '草稿') + '</span>' +
        '<button data-action="editor-save-draft">存为草稿</button>' +
        '<button class="primary" data-action="editor-save">保存为可用表格(需填完必填)</button>' +
        '<button data-action="editor-save-copy">保存为副本</button>' +
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
    const inputEl = $('#fx-input');
    // preventScroll:避免把顶部公式栏滚进视口导致页面跳顶
    if (inputEl && gridSel && !inputEl.disabled) inputEl.focus({ preventScroll: true });
  }
  function commitFx() {
    const inputEl = $('#fx-input');
    if (!inputEl || !gridSel || !gridCache) return;
    const def = gridCache.addrCells[gridSel];
    if (!def) return;
    if (inputEl.value === fxContent(def)) return; // 未改动,跳过(避免把默认公式误存为覆盖)
    gridDirty = true;
    const text = inputEl.value;
    const t = String(text).trim();
    if (t.charAt(0) === '=') {
      try { Formula.parse(t.slice(1)); } catch (e) { /* 允许保存;格子显示 #PARSE! */ }
      delete gridOverV[gridSel];
      gridOverF[gridSel] = t;
    } else if (def.kind === 'input') {
      delete gridOverF[gridSel];
      delete gridOverV[gridSel];
      setByPath(estDraft, def.path, text === '' ? '' : (/^-?\d*\.?\d+$/.test(text) ? Number(text) : text));
    } else {
      delete gridOverF[gridSel];
      if (text === '') delete gridOverV[gridSel];
      else gridOverV[gridSel] = text;
    }
    gridEval();
    paintAll(gridCache);
    updateFxBar();
  }
  function clearGridOverrides(msg) {
    gridOverF = {};
    gridOverV = {};
    if (msg) toast(msg);
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
      estDraft.code = p.code || '';
      gridDirty = true;
      clearGridOverrides('已按产品配方导入材料行,公式覆盖已清空');
      renderEstimateEditor();
      toast('已导入产品配方:' + p.name + '(' + rows.length + ' 个材料)');
    };
    if (estDraft.rows.length) {
      showConfirm('确认导入产品配方', '当前估算单已有 ' + estDraft.rows.length + ' 行材料,导入产品「' + p.name + '」会替换为按该配方生成的 ' + p.recipe.length + ' 行(名称规格/产品编号一并更新)。继续吗?', doApply, null);
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
  /** 同产品编号相邻批次的衔接校验(日期不重叠 + 模数递增) */
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

  /**
   * 保存估算单。
   * @param status 'draft' | 'ready'
   * @param asCopy 是否另存副本
   * @param after 保存完成后跳转的 hash(空则回估算单列表)
   * @returns boolean 是否真正写入(false=校验不通过)
   */
  function saveEstimate(status, asCopy, after) {
    const missing = requiredMissing();
    if (status === 'ready' && missing.length) {
      toast('还有 ' + missing.length + ' 项必填未填写(如 ' + missing[0].label + ' ' + missing[0].addr + '),只能保存为草稿');
      return false;
    }
    const d = finalizeDraft();
    d.status = status;
    const issues = adjacentIssues(d);
    function commit() {
      if (asCopy || !d.id) { Store.addEstimate(d); estDraft = d; }
      else { Store.updateEstimate(d.id, d); estDraft.status = status; }
      Store.save().then(function () {
        gridDirty = false;
        toast((status === 'ready' ? '已保存为可用表格' : '已保存为草稿') + (asCopy ? '(副本)' : ''));
        if (after) location.hash = after;
        else location.hash = '#estimates';
      }).catch(function (err) { toast('保存失败:' + err.message); });
    }
    if (issues.length) {
      showConfirm('相邻批次衔接提醒', issues.join('\n') + '\n\n仍要保存吗?', commit, function () {});
      return true;
    }
    commit();
    return true;
  }

  // ---------- 退出编辑器三选弹窗 ----------
  function requestLeave(hashTarget) {
    const editorEl = document.getElementById('view-editor');
    const inEditor = editorEl && !editorEl.hidden && estDraft;
    if (!inEditor || !gridDirty) { performNav(hashTarget); return true; }
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
    gridDirty = false;
    gridPendingNav = null;
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
        return '<tr><td class="l">' + label + '</td>' + comps.map(function (x) {
          return '<td>' + fn(x) + '</td>';
        }).join('') + '</tr>';
      };
      const rows = [
        fieldRow('产品编号', function (x) { return esc(x.e.code || '—'); }),
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

  // ---------- 图表预览 ----------
  function renderCharts() {
    const v = $('#view-charts');
    const estimates = data.estimates.slice().reverse(); // 新→旧
    if (!estimates.length) {
      v.innerHTML = '<h2 class="sec-title">图表预览</h2>' +
        '<p class="empty-hint">暂无估算单。请先在"估算单"页创建估算单后再查看图表。</p>';
      return;
    }
    // 环形图:选中的批次(默认最新)
    if (!chartEstId || !estimates.some(function (e) { return e.id === chartEstId; })) chartEstId = estimates[0].id;
    const selComp = Charts.computeAll(estimates.filter(function (e) { return e.id === chartEstId; }))[0];
    const donutItems = selComp.c.rows.map(function (r) { return { name: r.name, value: r.usageAmount }; });
    const selOpts = estimates.map(function (e) {
      return '<option value="' + e.id + '"' + (e.id === chartEstId ? ' selected' : '') + '>' +
        Charts.esc(e.name || e.id) + '（' + Charts.esc(e.startDate || '无日期') + '）</option>';
    }).join('');

    // 柱状图 / 折线图:按开始日期升序
    const chrono = estimates.slice().sort(function (a, b) {
      const da = a.startDate || '', db = b.startDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const shortLabel = function (e) {
      const nm = e.name || e.id;
      return [nm.length > 10 ? nm.slice(0, 10) + '…' : nm, e.startDate || ''];
    };
    const groups = chrono.map(function (e) {
      const c = CostCalc.compute(e);
      return { id: e.id, label: shortLabel(e), a: c.calc.costTotal1, b: c.calc.costTotal2 };
    });

    // 材料汇总(跨批次,按名称合并;用量单位公斤)
    const matMap = new Map();
    chrono.forEach(function (e) {
      const c = CostCalc.compute(e);
      c.rows.forEach(function (r) {
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

    v.innerHTML =
      '<h2 class="sec-title">图表预览</h2>' +
      '<div class="chart-grid">' +
        '<div class="chart-card">' +
          '<div class="chart-head"><h3>材料成本构成(本期用料金额)</h3>' +
            '<select id="chart-est-select">' + selOpts + '</select></div>' +
          Charts.donutHTML(donutItems, selComp.c.calc.costTotal1, selComp.e.id) +
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
        Store.save().then(function () { toast('已更新所属区'); });
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
      case 'add-material': {
        const name = $('#new-mat-name').value.trim();
        const zone = $('#new-mat-zone').value;
        if (!name) { toast('请输入材料名称'); return; }
        Store.addMaterial(name, zone);
        Store.save().then(function () { renderMaterials(); toast('已添加材料:' + name); });
        break;
      }
      case 'del-material': {
        if (!confirm('确认删除该材料?')) return;
        const r = Store.deleteMaterial(id);
        if (!r.ok) { toast(r.reason); return; }
        Store.save().then(function () { renderMaterials(); toast('已删除'); });
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
        Store.save().then(function () { renderProducts(); toast('已删除产品'); });
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
          if (editingProductId) {
            Store.updateProduct(editingProductId, JSON.parse(JSON.stringify(productFormDraft)));
          } else {
            Store.addProduct(pname, productFormDraft.code, JSON.parse(JSON.stringify(productFormDraft.recipe)));
          }
          Store.save().then(function () {
            editingProductId = null;
            productFormDraft = null;
            renderProducts();
            toast('产品已保存');
          });
        };
        showConfirm('确认保存产品配方', '确定保存产品「' + pname + '」(配方 ' + recipeCount + ' 个材料)吗?', doSave, null);
        break;
      }
      case 'cancel-product':
        editingProductId = null;
        productFormDraft = null;
        renderProducts();
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
        Store.save().then(function () { renderEstimates(); toast('已复制为新估算单'); });
        break;
      case 'del-estimate':
        if (!confirm('确认删除该估算单?')) return;
        Store.deleteEstimate(id);
        Store.save().then(function () { renderEstimates(); toast('已删除'); });
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
      case 'editor-add-material': {
        const sel = $('#editor-add-mat');
        if (!sel || !sel.value) { toast('没有可添加的材料'); return; }
        const m = Store.materialById(sel.value);
        estDraft.rows.push({
          id: uid(), materialId: m.id, name: m.name, zone: m.zone,
          qtyPerPot: '', price: '', stockOnHand: '', stockIn: '', qty: ''
        });
        gridDirty = true;
        clearGridOverrides('材料行结构已变化,已清空公式覆盖');
        renderEstimateEditor();
        break;
      }
      case 'editor-del-mat':
        if (!confirm('确认移除该材料行?')) return;
        estDraft.rows.splice(Number(btn.dataset.idx), 1);
        gridDirty = true;
        clearGridOverrides('材料行结构已变化,已清空公式覆盖');
        renderEstimateEditor();
        break;
      case 'db-snapshot':
        fetch('/api/db/backup', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) toast('快照备份完成:' + j.file);
            else toast('快照失败:' + (j.error || ''));
          }).catch(function () { toast('快照失败:无法连接服务'); });
        break;
      case 'db-export': {
        fetch('/api/db/export', { method: 'POST' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
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
          }).catch(function () { toast('导出失败:无法连接服务'); });
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
        fetch('/api/db/import', { method: 'POST', body: reader.result })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            f.value = '';
            if (j.ok) { toast('导入成功,即将刷新数据'); setTimeout(function () { location.reload(); }, 600); }
            else toast('导入失败:' + (j.error || ''));
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
        currentUser = null;
        data = null;
        estDraft = null;
        $('#user-area').hidden = true;
        $('#tab-users').hidden = true;
        location.hash = '';
        showAuth('login');
        toast('已退出登录');
      });
    }
  });

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

  // ---------- 登录 / 注册 / 用户管理 ----------
  let authMode = 'login';
  function showAuth(mode) {
    authMode = mode || 'login';
    $('#auth-screen').style.display = 'flex';
    $('#auth-submit').textContent = authMode === 'login' ? '登 录' : '注 册';
    $('#auth-sub').textContent = authMode === 'login'
      ? '请登录后使用(默认账号 admin / admin123)'
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
  }
  async function afterAuth() {
    renderUserBar();
    data = await Store.load();
    hideAuth();
    if (!location.hash) {
      const latest = data.estimates.length ? data.estimates[data.estimates.length - 1].id : null;
      location.hash = latest ? '#estimate/' + latest : '#estimates';
      return;
    }
    applyHash();
  }
  function handleAuthExpired() {
    Store.token = '';
    currentUser = null;
    $('#user-area').hidden = true;
    $('#tab-users').hidden = true;
    showAuth('login');
    toast('登录已过期,请重新登录');
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
            '<button class="small" data-action="users-reset-pw" data-username="' + esc(u.username) + '">重置密码</button> ' +
            (u.username !== currentUser.username
              ? '<button class="danger small" data-action="users-del" data-username="' + esc(u.username) + '">删除</button>' : '') +
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
          '<button class="primary" data-action="users-add">新增用户</button>' +
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
    if (!Store.token && /[?&]autologin=1/.test(location.search)) {
      try { currentUser = await Store.login('admin', 'admin123'); }
      catch (err) { /* 继续走正常登录页 */ }
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
