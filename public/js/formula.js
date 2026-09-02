/**
 * 轻量 Excel 公式引擎(零依赖)
 *
 * 支持:
 *  - 单元格引用 A1 / $A$1 / $A1 / A$1(绝对引用符号忽略)
 *  - 区域引用 A1:B3(仅 SUM/AVG/MIN/MAX/COUNT 等区域函数可用)
 *  - 运算符 + - * / ^ 与括号;比较 = <> < > <= >=(结果为 1/0)
 *  - 函数:SUM AVERAGE/AVG MIN MAX COUNT IF ROUND ABS INT
 *  - 错误值:#DIV/0! #VALUE! #NAME? #NUM! #PARSE!
 *  - 文本:双引号或单引号包裹;数值型文本参与算术时自动转数字
 *
 * 浏览器:window.Formula;Node:module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Formula = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ERR = { DIV0: '#DIV/0!', VALUE: '#VALUE!', NAME: '#NAME?', NUM: '#NUM!', PARSE: '#PARSE!' };
  function isErr(v) { return v !== null && typeof v === 'object' && typeof v.err === 'string'; }
  function errObj(code) { return { err: code }; }

  /** 单元格引用 <-> 数字坐标 */
  function colToLetters(c) { // 1-based col -> 'A'
    var s = '';
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }
  function lettersToCol(ls) {
    var c = 0;
    for (var i = 0; i < ls.length; i++) c = c * 26 + (ls.charCodeAt(i) - 64);
    return c;
  }
  var REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;
  function parseRef(ref) {
    var m = REF_RE.exec(ref);
    if (!m) return null;
    return { col: lettersToCol(m[1].toUpperCase()), row: parseInt(m[2], 10), key: m[1].toUpperCase() + m[2] };
  }
  function refKey(col, row) { return colToLetters(col) + row; }

  // ---------------- 词法 ----------------
  function ParseError(msg) { this.message = msg; }
  ParseError.prototype = Object.create(Error.prototype);
  ParseError.prototype.name = 'ParseError';

  function tokenize(text) {
    var tokens = [], i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      var two = text.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>') { tokens.push({ t: 'cmp', v: two }); i += 2; continue; }
      if (c === '<' || c === '>' || c === '=') { tokens.push({ t: 'cmp', v: c }); i++; continue; }
      var numM = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (numM) { tokens.push({ t: 'num', v: numM[0] }); i += numM[0].length; continue; }
      if (c === '"' || c === "'") {
        var end = text.indexOf(c, i + 1);
        if (end < 0) throw new ParseError('未闭合的字符串');
        tokens.push({ t: 'str', v: text.slice(i + 1, end) });
        i = end + 1; continue;
      }
      var refM = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(text.slice(i));
      if (refM) {
        // 后面紧跟字母且无运算符,说明不是完整引用,交给上层报错
        tokens.push({ t: 'ref', v: refM[0].replace(/\$/g, '') });
        i += refM[0].length; continue;
      }
      var idM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (idM) {
        var name = idM[0].toUpperCase();
        var j = i + idM[0].length;
        while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
        if (j < n && text[j] === '(') tokens.push({ t: 'func', v: name });
        else throw new ParseError('无法识别的名称: ' + idM[0]);
        i += idM[0].length; continue;
      }
      if ('+-*/^(),:'.indexOf(c) >= 0) {
        var tt = c === ':' ? 'colon' : (c === ',' ? 'comma' : (c === '(' ? 'lp' : (c === ')' ? 'rp' : 'op')));
        tokens.push({ t: tt, v: c });
        i++; continue;
      }
      throw new ParseError('无法识别的字符: ' + c);
    }
    return tokens;
  }

  // ---------------- 语法 ----------------
  function Parser(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  Parser.prototype.peek = function () { return this.tokens[this.pos] || null; };
  Parser.prototype.next = function () { return this.tokens[this.pos++] || null; };
  Parser.prototype.expect = function (t, v) {
    var tk = this.next();
    if (!tk || tk.t !== t || (v !== undefined && tk.v !== v)) throw new ParseError('语法错误:期望 ' + (v || t));
    return tk;
  };

  Parser.prototype.parse = function () {
    var e = this.parseCmp();
    if (this.peek()) throw new ParseError('多余的字符');
    return e;
  };
  Parser.prototype.parseCmp = function () {
    var left = this.parseAdd();
    while (this.peek() && this.peek().t === 'cmp') {
      var op = this.next().v;
      var right = this.parseAdd();
      left = { kind: 'cmp', op: op, a: left, b: right };
    }
    return left;
  };
  Parser.prototype.parseAdd = function () {
    var left = this.parseMul();
    while (this.peek() && this.peek().t === 'op' && (this.peek().v === '+' || this.peek().v === '-')) {
      var op = this.next().v;
      var right = this.parseMul();
      left = { kind: 'bin', op: op, a: left, b: right };
    }
    return left;
  };
  Parser.prototype.parseMul = function () {
    var left = this.parseUnary();
    while (this.peek() && this.peek().t === 'op' && (this.peek().v === '*' || this.peek().v === '/')) {
      var op = this.next().v;
      var right = this.parseUnary();
      left = { kind: 'bin', op: op, a: left, b: right };
    }
    return left;
  };
  Parser.prototype.parseUnary = function () {
    var tk = this.peek();
    if (tk && tk.t === 'op' && tk.v === '-') { this.next(); return { kind: 'neg', a: this.parseUnary() }; }
    return this.parsePower();
  };
  Parser.prototype.parsePower = function () {
    var base = this.parsePrimary();
    var tk = this.peek();
    if (tk && tk.t === 'op' && tk.v === '^') {
      this.next();
      return { kind: 'bin', op: '^', a: base, b: this.parseUnary() };
    }
    return base;
  };
  Parser.prototype.parsePrimary = function () {
    var tk = this.next();
    if (!tk) throw new ParseError('表达式意外结束');
    if (tk.t === 'num') return { kind: 'num', v: Number(tk.v) };
    if (tk.t === 'str') return { kind: 'str', v: tk.v };
    if (tk.t === 'ref') {
      var node = { kind: 'ref', ref: tk.v };
      if (this.peek() && this.peek().t === 'colon') { // 引用:引用 -> 区域节点(仅函数参数内部出现,这里构造 range)
        this.next();
        var tk2 = this.expect('ref');
        node = { kind: 'range', a: tk.v, b: tk2.v };
      }
      return node;
    }
    if (tk.t === 'func') {
      this.expect('lp');
      var args = [];
      if (this.peek() && this.peek().t !== 'rp') {
        args.push(this.parseArg());
        while (this.peek() && this.peek().t === 'comma') { this.next(); args.push(this.parseArg()); }
      }
      this.expect('rp');
      return { kind: 'call', fn: tk.v, args: args };
    }
    if (tk.t === 'lp') {
      var inner = this.parseCmp();
      this.expect('rp');
      return inner;
    }
    throw new ParseError('表达式位置出现非法内容');
  };
  Parser.prototype.parseArg = function () {
    // 参数可为完整比较/加减表达式(如 IF 条件);逗号/右括号自然终止
    return this.parseCmp();
  };

  // ---------------- 求值 ----------------
  function flattenArg(arg, ctx) {
    if (arg.kind === 'range') {
      var a = parseRef(arg.a), b = parseRef(arg.b);
      if (!a || !b) return { list: null, err: ERR.REF };
      var r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
      var c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
      // 反向区域(A10:A1)视为空
      if (a.row > b.row || a.col > b.col) return { list: [] };
      var out = [];
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          out.push(ctx.getValue(refKey(c, r)));
        }
      }
      return { list: out };
    }
    return { list: null, val: evalNode(arg, ctx) };
  }

  var RANGEFNS = { SUM: 1, AVERAGE: 1, AVG: 1, MIN: 1, MAX: 1, COUNT: 1 };

  function evalNode(node, ctx) {
    switch (node.kind) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'ref': {
        var rv = ctx.getValue(node.ref);
        return (rv === null || rv === undefined || rv === '') ? 0 : rv; // Excel:空白格按 0
      }
      case 'range': return { err: ERR.VALUE }; // 区域不能直接作为标量
      case 'neg': {
        var nv = toNumber(evalNode(node.a, ctx));
        if (isErr(nv)) return nv;
        return -nv;
      }
      case 'bin': {
        if (node.op === '^') {
          var bv = toNumber(evalNode(node.a, ctx));
          if (isErr(bv)) return bv;
          var pv = toNumber(evalNode(node.b, ctx));
          if (isErr(pv)) return pv;
          return Math.pow(bv, pv);
        }
        var x = toNumber(evalNode(node.a, ctx));
        if (isErr(x)) return x;
        var y = toNumber(evalNode(node.b, ctx));
        if (isErr(y)) return y;
        if (node.op === '+') return x + y;
        if (node.op === '-') return x - y;
        if (node.op === '*') return x * y;
        if (node.op === '/') return y === 0 ? errObj(ERR.DIV0) : x / y;
        return errObj(ERR.VALUE);
      }
      case 'cmp': {
        var va = rawValue(evalNode(node.a, ctx));
        var vb = rawValue(evalNode(node.b, ctx));
        if (isErr(va)) return va;
        if (isErr(vb)) return vb;
        return compare(va, vb, node.op) ? 1 : 0;
      }
      case 'call': return evalCall(node, ctx);
    }
    return errObj(ERR.VALUE);
  }

  function evalCall(node, ctx) {
    var fn = node.fn;
    if (!RANGEFNS[fn] && !SCALAR_FNS[fn]) return errObj(ERR.NAME);
    if (fn === 'IF') {
      var cond = toNumber(evalNode(node.args[0], ctx));
      if (isErr(cond)) return cond;
      var thenV = evalNode(node.args[1], ctx);
      if (cond !== 0) return thenV;
      return node.args.length >= 3 ? evalNode(node.args[2], ctx) : 0;
    }
    if (fn === 'ROUND') {
      var x = toNumber(evalNode(node.args[0], ctx));
      if (isErr(x)) return x;
      var d = node.args[1] ? Math.trunc(toNumber(evalNode(node.args[1], ctx))) : 0;
      var f = Math.pow(10, d);
      var r = x * f;
      var rounded = r >= 0 ? Math.floor(r + 0.5) : Math.ceil(r - 0.5);
      return rounded / f;
    }
    if (fn === 'ABS' || fn === 'INT') {
      var av = toNumber(evalNode(node.args[0], ctx));
      if (isErr(av)) return av;
      return fn === 'ABS' ? Math.abs(av) : Math.floor(av);
    }
    // 区域类函数
    var nums = [];
    var errHit = null;
    function collect(arg) {
      var f = flattenArg(arg, ctx);
      if (f.err) { errHit = errHit || f.err; return; }
      if (f.list) {
        f.list.forEach(function (v) {
          if (isErr(v)) { errHit = errHit || v; return; }
          if (v === null || v === '') return;
          var n = toNumber(v);
          if (typeof n === 'number') nums.push(n);
        });
      } else {
        if (isErr(f.val)) { errHit = errHit || f.val; return; }
        if (fn === 'COUNT') { if (f.val !== null && typeof f.val !== 'string') nums.push(f.val); return; }
        if (f.val === null || f.val === '') return;
        var n2 = toNumber(f.val);
        if (typeof n2 === 'number') nums.push(n2);
      }
    }
    node.args.forEach(collect);
    if (errHit) return errHit;
    if (fn === 'SUM') return nums.reduce(function (s, v) { return s + v; }, 0);
    if (fn === 'AVERAGE' || fn === 'AVG') return nums.length ? nums.reduce(function (s, v) { return s + v; }, 0) / nums.length : errObj(ERR.DIV0);
    if (fn === 'MIN') return nums.length ? Math.min.apply(null, nums) : 0;
    if (fn === 'MAX') return nums.length ? Math.max.apply(null, nums) : 0;
    if (fn === 'COUNT') return nums.length;
    return errObj(ERR.VALUE);
  }
  var SCALAR_FNS = { IF: 1, ROUND: 1, ABS: 1, INT: 1 };

  /** 参与算术时的类型转换:null/''->0;boolean->1/0;数字文本->数字;其余文本->#VALUE! */
  function toNumber(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      var t = v.replace(/,/g, '');
      if (/^\s*-?\d*\.?\d+\s*$/.test(t)) return Number(t);
      return errObj(ERR.VALUE);
    }
    return errObj(ERR.VALUE);
  }
  function rawValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.err !== undefined) return v;
    return v;
  }
  function compare(a, b, op) {
    var an = (typeof a === 'number' || a === null) ? (a === null ? 0 : a) : (toNumber(a));
    var bn = (typeof b === 'number' || b === null) ? (b === null ? 0 : b) : (toNumber(b));
    var av = isErr(an) ? a : an;
    var bv = isErr(bn) ? b : bn;
    var l, r;
    if (typeof av === 'number' && typeof bv === 'number') { l = av; r = bv; }
    else { l = String(a == null ? '' : a); r = String(b == null ? '' : b); }
    switch (op) {
      case '=': return l === r;
      case '<>': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '<=': return l <= r;
      case '>=': return l >= r;
    }
    return false;
  }

  // ---------------- 公开 API ----------------
  /**
   * 解析公式文本(不含前导 '='),返回 AST 或抛出 ParseError
   */
  function parse(formulaText) {
    var tokens = tokenize(String(formulaText).trim());
    var p = new Parser(tokens);
    return p.parse();
  }

  /**
   * 求值单元格内容。
   * @param text 单元格内容(可能以 '=' 开头,也可能只是数值/文本)
   * @param ctx { getValue(refKey) -> value }
   */
  function evalText(text, ctx) {
    text = String(text == null ? '' : text);
    var t = text.trim();
    if (t.charAt(0) === '=') {
      try {
        var ast = parse(t.slice(1));
        return evalNode(ast, ctx);
      } catch (e) {
        return errObj(e instanceof ParseError ? ERR.PARSE : ERR.VALUE);
      }
    }
    // 非公式:数值文本转数字
    var nm = /^-?\d*\.?\d+$/.exec(t);
    if (nm) return Number(t);
    return text; // 原样文本(含空串)
  }

  /**
   * 提取公式内引用的单元格键集合(区域 A1:B3 展开为其中的全部单元格,供依赖排序使用)
   */
  function parseRefs(text) {
    var t = String(text == null ? '' : text).trim();
    var out = [];
    if (t.charAt(0) !== '=') return out;
    var tokens;
    try { tokens = tokenize(t.slice(1)); } catch (e) { return out; }
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk.t === 'func') { out.push(tk.v); continue; }
      if (tk.t === 'ref') {
        if (i + 2 < tokens.length && tokens[i + 1].t === 'colon' && tokens[i + 2].t === 'ref') {
          var a = parseRef(tk.v), b = parseRef(tokens[i + 2].v);
          if (a && b) {
            var cnt = 0;
            for (var rr = Math.min(a.row, b.row); rr <= Math.max(a.row, b.row); rr++) {
              for (var cc = Math.min(a.col, b.col); cc <= Math.max(a.col, b.col); cc++) {
                if (cnt++ > 20000) break;
                out.push(refKey(cc, rr));
              }
            }
          }
          i += 2;
        } else {
          out.push(tk.v.toUpperCase());
        }
      }
    }
    return out;
  }

  function isFormula(text) {
    return String(text == null ? '' : text).trim().charAt(0) === '=';
  }
  function isErrVal(v) { return isErr(v); }

  return {
    parse: parse, evalText: evalText, parseRefs: parseRefs, isFormula: isFormula,
    isErr: isErrVal, err: errObj, ERR: ERR, colToLetters: colToLetters,
    lettersToCol: lettersToCol, parseRef: parseRef, refKey: refKey
  };
});
