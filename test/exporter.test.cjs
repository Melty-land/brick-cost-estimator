/**
 * exporter.js 单元测试(Node):SpreadsheetML 生成与类型推断。
 * 运行:node test/exporter.test.cjs
 */
'use strict';
const assert = require('assert');
const Ex = require('../public/js/exporter.js');

// buildSpreadsheetML 基本结构与转义
const grid = [
  ['名称', '单价', '占比'],
  ['黑水泥', '0.258', '20.04%'],
  ['机制砂', '80', ''],
  ['文本', 'a<&b', 'x']
];
const xml = Ex.buildSpreadsheetML('测试/预算:表', grid);
// 名称清洗非法字符
assert.ok(xml.includes('ss:Worksheet ss:Name="测试_预算_表"'), '工作表名应清洗非法字符');
// 数字类型
assert.ok(xml.includes('<ss:Data ss:Type="Number">0.258</ss:Data>'), '数字单元格应为 Number');
assert.ok(xml.includes('<ss:Data ss:Type="Number">80</ss:Data>'), '整数文本应为 Number');
// 百分比 -> Number(0.2004)+ 样式
assert.ok(xml.includes('ss:StyleID="pct"') && xml.includes('<ss:Data ss:Type="Number">0.2004</ss:Data>'), '百分比应转数字');
// 文本转义
assert.ok(xml.includes('a&lt;&amp;b'), '文本需 XML 转义');
// 空单元格
assert.ok(xml.includes('<ss:Cell/>'), '空单元格输出空 Cell');
// 文本样式左对齐
assert.ok(xml.includes('ss:StyleID="txt"'), '文本单元格应带 txt 样式');
assert.ok(xml.includes('<?mso-application progid="Excel.Sheet"?>'), '应含 Excel 声明');
assert.ok(xml.includes('</Workbook>'), '应闭合');
console.log('✓ exporter 基本结构/类型/转义正确,生成 ' + xml.length + ' 字节');

// isNum / isPct 边界
assert.strictEqual(Ex.isNum('1,234.5'), true);
assert.strictEqual(Ex.isNum('1.2.3'), false);
assert.strictEqual(Ex.isNum(''), false);
assert.strictEqual(Ex.isPct('20.04%'), true);
assert.strictEqual(Ex.isPct('0.04%'), true);
assert.strictEqual(Ex.isPct('x%'), false);
assert.strictEqual(Ex.isNum(-3.5), true);
console.log('✓ 数值/百分比推断边界正确');

console.log('✅ exporter 单元测试通过');
