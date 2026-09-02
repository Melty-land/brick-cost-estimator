/**
 * formula.js 单元测试
 * 运行:node test/formula.test.cjs
 */
'use strict';
const assert = require('assert');
const F = require('../public/js/formula.js');

// 简易网格上下文
function makeCtx(map) {
  return {
    getValue(key) {
      const k = String(key).toUpperCase();
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    }
  };
}

function ev(text, map) { return F.evalText(text, makeCtx(map)); }
function errOf(v) { return v && typeof v === 'object' ? v.err : null; }

// ---- 算术与引用 ----
assert.strictEqual(ev('=C5*D5', { C5: 2, D5: 3 }), 6);
assert.strictEqual(ev('=C5*D5/1000', { C5: 500, D5: 200 }), 100);
assert.strictEqual(ev('=1+2*3'), 7);
assert.strictEqual(ev('=(1+2)*3'), 9);
assert.strictEqual(ev('=2^3'), 8);
assert.strictEqual(ev('=-5+3'), -2);
assert.strictEqual(ev('=A1+B1', { A1: '5', B1: 2 }), 7);        // 数字文本参与算术
assert.strictEqual(ev('=10/4'), 2.5);
assert.strictEqual(errOf(ev('=1/0')), '#DIV/0!');
assert.strictEqual(errOf(ev('=A1+1', { A1: 'abc' })), '#VALUE!');
assert.strictEqual(ev('="名称"'), '名称');
assert.strictEqual(ev('=A1', { A1: 0 }), 0);
assert.strictEqual(ev('=C10', {}), 0);                           // 空单元格按 0
assert.strictEqual(ev('123.5'), 123.5);
assert.strictEqual(ev('abc'), 'abc');
assert.strictEqual(ev(''), '');

// ---- 比较与 IF ----
assert.strictEqual(ev('=IF(C5=0,0,E5/$B$12)', { C5: 0, E5: 5, B12: 0 }), 0);
assert.strictEqual(ev('=IF(C5=0,0,E5/$B$12)', { C5: 2, E5: 5, B12: 10 }), 0.5);
assert.strictEqual(ev('=IF(A1>0,"高","低")', { A1: 3 }), '高');
assert.strictEqual(ev('=IF(A1<>0,1,2)', { A1: 0 }), 2);
assert.strictEqual(ev('="底料"="底料"'), 1);
assert.strictEqual(ev('="底料"="面料"'), 0);
assert.strictEqual(ev('=IF("底料"="底料", 1, 0)'), 1);

// ---- 区域函数 ----
const grid1 = { A1: 1, A2: 2, A3: 3, A4: 4, B1: 'x', B2: 10 };
assert.strictEqual(ev('=SUM(A1:A4)', grid1), 10);
assert.strictEqual(ev('=SUM(A1:A4,10)', grid1), 20);
assert.strictEqual(ev('=AVERAGE(A1:A4)', grid1), 2.5);
assert.strictEqual(ev('=AVG(A1:A4)', grid1), 2.5);
assert.strictEqual(ev('=MIN(A1:A4)', grid1), 1);
assert.strictEqual(ev('=MAX(A1:A4)', grid1), 4);
assert.strictEqual(ev('=COUNT(A1:A4)', grid1), 4);
assert.strictEqual(ev('=COUNT(A1:B2)', grid1), 3);               // A1,B1(x),A2,B2 中数值 3 个
assert.strictEqual(ev('=SUM(B1:B2)', grid1), 10);                // 文本被忽略(SUM 不把 x 当 0)
assert.strictEqual(ev('=ROUND(3.14159,2)'), 3.14);
assert.strictEqual(ev('=ROUND(2.5,0)'), 3);
assert.strictEqual(ev('=ABS(-9)'), 9);
assert.strictEqual(ev('=INT(-1.7)'), -2);

// ---- 错误 ----
assert.strictEqual(errOf(ev('=SUM(A1:A1)', { A1: { err: '#DIV/0!' } })), '#DIV/0!');
assert.strictEqual(errOf(ev('=FOO(1)')), '#NAME?');
assert.strictEqual(errOf(ev('=1+')), '#PARSE!');
assert.strictEqual(errOf(ev('=(1+2')), '#PARSE!');
assert.strictEqual(errOf(ev('=A1:B2')), '#VALUE!');              // 区域做标量
assert.strictEqual(errOf(ev('=AVERAGE(A1:A1)', { A1: null })), '#DIV/0!');

// ---- 解析引用提取 ----
const refs = F.parseRefs('=C5*D5+SUM(E5:E10)+$B$12');
assert.ok(refs.includes('C5') && refs.includes('D5') && refs.includes('E5') && refs.includes('E10') && refs.includes('B12'), JSON.stringify(refs));
assert.deepStrictEqual(F.parseRefs('123'), []);
assert.deepStrictEqual(F.parseRefs('=IF(A1>0,B1,0)').filter(r => !['IF'].includes(r)).sort(), ['A1', 'B1'].sort());

// ---- 地址换算 ----
assert.strictEqual(F.refKey(3, 5), 'C5');
assert.strictEqual(F.lettersToCol('L'), 12);
assert.strictEqual(F.colToLetters(12), 'L');
assert.strictEqual(F.colToLetters(27), 'AA');
assert.deepStrictEqual(F.parseRef('L16'), { col: 12, row: 16, key: 'L16' });

console.log('✅ formula.js 全部单元测试通过');
