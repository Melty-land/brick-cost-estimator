/**
 * 导出模块(零第三方依赖,离线可用)
 *  - buildSpreadsheetML(table): 预算表 → Excel 2003 SpreadsheetML(.xls)
 *  - exportXLS(filename, table): 触发保存(.xls),优先 showSaveFilePicker 让用户自选路径
 *  - printSheet(): 打印预算表(浏览器打印 → 可另存为 PDF 并自选路径)
 * 浏览器: window.Exporter; Node: module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : {});
  else root.Exporter = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {
  'use strict';
  var root = win; // 浏览器: window;Node: globalThis 占位(saveAs/print 仅在浏览器调用)

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
  }
  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function isNum(s) {
    if (typeof s === 'number') return true;
    const t = String(s).trim().replace(/,/g, '');
    return t !== '' && /^-?\d*\.?\d+$/.test(t);
  }
  function isPct(s) {
    return typeof s === 'string' && /^-?\d+(\.\d+)?%$/.test(s.trim());
  }

  /** 从预算表 DOM(.sheet-grid)抽取二维数据;按 colspan 展开,保证每行列数一致(修复跨列标题错位) */
  function collectTable(tableEl) {
    if (!tableEl) return [];
    const rows = tableEl.querySelectorAll('tr');
    const out = [];
    rows.forEach(function (tr) {
      const line = [];
      tr.querySelectorAll('td,th').forEach(function (td) {
        let t = (td.textContent || '').replace(/\u2026/g, '').trim();
        if (td.classList.contains('seq')) t = t.replace(/\s+/g, ' ');
        const span = Math.max(1, parseInt(td.getAttribute('colspan'), 10) || 1);
        line.push(t);
        for (let k = 1; k < span; k++) line.push(''); // colspan 展开为空占位,保证列对齐
      });
      out.push(line);
    });
    return out;
  }

  /**
   * 二维数组 → SpreadsheetML 2003(.xls)。
   * @param title 工作表标题(中文安全)
   */
  function buildSpreadsheetML(title, grid) {
    const t = String(title == null ? '预算表' : title).replace(/[\\/:*?"<>|]/g, '_');
    let ws = '<ss:Worksheet ss:Name="' + escAttr(t.slice(0, 30)) + '">\n<ss:Table>\n';
    const colCount = grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    for (let c = 0; c < colCount; c++) ws += '<ss:Column ss:Width="' + (c === 1 ? 90 : 60) + '"/>\n';
    grid.forEach(function (line) {
      ws += '<ss:Row>\n';
      for (let c = 0; c < colCount; c++) {
        const raw = line[c];
        const v = raw == null ? '' : raw;
        if (v === '') { ws += '<ss:Cell/>\n'; continue; }
        if (isPct(v)) {
          ws += '<ss:Cell ss:StyleID="pct"><ss:Data ss:Type="Number">' + escXml(parseFloat(v) / 100) + '</ss:Data></ss:Cell>\n';
        } else if (isNum(v)) {
          ws += '<ss:Cell ss:StyleID="num"><ss:Data ss:Type="Number">' + escXml(parseFloat(v.replace(/,/g, ''))) + '</ss:Data></ss:Cell>\n';
        } else {
          ws += '<ss:Cell ss:StyleID="txt"><ss:Data ss:Type="String">' + escXml(v) + '</ss:Data></ss:Cell>\n';
        }
      }
      ws += '</ss:Row>\n';
    });
    ws += '</ss:Table>\n</ss:Worksheet>\n';

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:x="urn:schemas-microsoft-com:office:excel">\n' +
      '<ss:Styles>\n' +
      '<ss:Style ss:ID="num"><ss:NumberFormat ss:Format="#,##0.00"/></ss:Style>\n' +
      '<ss:Style ss:ID="pct"><ss:NumberFormat ss:Format="0.00%"/></ss:Style>\n' +
      '<ss:Style ss:ID="txt"><ss:Alignment ss:Horizontal="Left"/></ss:Style>\n' +
      '</ss:Styles>\n' +
      ws +
      '</Workbook>';
  }

  /** 通过 File System Access API 让用户自选保存路径;不可用则回退 <a download> */
  async function saveAs(content, filename, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    // 优先原生"另存为"对话框(可自选路径)
    if (root.showSaveFilePicker) {
      try {
        const handle = await root.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: '保存文件', accept: { 'application/octet-stream': [filename.slice(filename.lastIndexOf('.')) || '.xls'] } }]
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // 用户取消
        // 其他错误(权限/不支持)→ 回退下载
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    return true;
  }

  /** 导出预算表为 Excel(.xls)。tableEl 为 .sheet-grid 元素 */
  async function exportXLS(filename, tableEl, sheetTitle) {
    const grid = collectTable(tableEl);
    const xml = buildSpreadsheetML(sheetTitle || filename, grid);
    const bom = '\ufeff'; // UTF-8 BOM,避免 Excel 中文乱码
    return saveAs(bom + xml, filename, 'application/vnd.ms-excel');
  }

  /** 打印预算表:临时只显示预算表并触发打印(可在打印对话框另存为 PDF) */
  function printSheet(scopeEl) {
    // 标记要打印的区域(不含编辑器工具条等)
    const marker = document.createElement('style');
    marker.id = 'print-target';
    marker.textContent =
      '@media print { body.printing * { visibility: hidden !important; }' +
      ' body.printing #print-area, body.printing #print-area * { visibility: visible !important; }' +
      ' body.printing #print-area { position: absolute; left: 0; top: 0; width: 100%; } }';
    document.head.appendChild(marker);
    const area = scopeEl && scopeEl.cloneNode ? scopeEl : document.body;
    const areaId = 'print-area';
    if (area.id !== areaId) { area.id = areaId; }
    document.body.classList.add('printing');
    // 触发打印;结束移除标记
    const cleanup = function () {
      document.body.classList.remove('printing');
      const m = document.getElementById('print-target');
      if (m) m.remove();
      document.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(function () {
      if (document.body.classList.contains('printing')) { window.print(); }
    }, 30);
    // 若同步阻塞环境无 afterprint,90s 后兜底清理
    setTimeout(function () { document.body.classList.remove('printing'); }, 90000);
  }

  return {
    collectTable: collectTable,
    buildSpreadsheetML: buildSpreadsheetML,
    saveAs: saveAs,
    exportXLS: exportXLS,
    printSheet: printSheet,
    escXml: escXml,
    isNum: isNum,
    isPct: isPct
  };
});
