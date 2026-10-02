# 用料明细(含剩余材料)实施计划 —— 阶段一

> **面向 Agent 执行者:** 必需子技能:使用 subagent-driven-development(推荐)或 executing-plans 按任务逐项实现本计划。步骤使用复选框(`- [ ]`)语法跟踪进度。

**目标:** 新增「用料明细」页签:逐批逐料的用料明细表(行尾带期末结存)+ 剩余材料表,支持时间段/产品/材料筛选与两表导出。

**架构:** 聚合逻辑放独立纯函数模块 `public/js/stats.js`(Node 可直接单测,内部复用既有 `calc.js` 的 `CostCalc.compute` 保证与预算表口径完全一致);视图渲染与交互在 `app.js` 中以 `renderUsage()` + 事件分支实现;`index.html` 增页签与容器;样式沿用现有 CSS 变量。筛选状态与既有总览/图表筛选相互独立。

**技术栈:** 原生 ES5 风格 JS(与现有 app.js 一致,UMD 导出供 Node 测试)、零第三方依赖、离线;测试用 Node 内置 assert + 现有 CDP 套件(本机无头 Edge)。

**规格:** `docs/superpowers/specs/2026-10-02-material-stats-excel-io-design.md`(第三、六、七、八、九、十节与本计划对应)

## 全局约束

- 零第三方依赖、完全离线:不得引入 npm 包、CDN、外部字体;仅用浏览器内置 API 与 Node 内置模块。
- 重量单位一律称「公斤」,金额「元」;数字显示沿用现有 `fmt`/`numText` 风格(千分位、最多 2 位小数)。
- 新增文件必须同时支持浏览器(挂 `window.XXX`)与 Node(`module.exports`),照抄 `public/js/calc.js` 的 UMD 头写法。
- 页签顺序固定为:`材料管理 | 产品配方 | 估算单 | 成本总览 | 用料明细 | 图表预览 | 历史对比 | 用户管理`。
- hash 路由名固定为 `usage`(视图容器 id 固定 `view-usage`)。
- 期末结存 = `上存材料 + 本期进料 − 本期用料数量`(即 `calc.rows[].stock`),可为负,负数一律加 CSS 类 `neg` 标红。
- 占比分母固定为该批次「本期用料数量合计」(与预算表口径一致),材料筛选不改变分母。
- 提交纪律:显式 `git add` 指定文件;提交前运行 `git diff | Select-String` 自查泄露;提交信息用临时文件 `-F` 传入。

## Review Focus

- **空数据**:库中无估算单 / 估算单无材料行 / 筛选后为空 → 两表显示空提示,页面不报错(测试:`cdp-usage-test.cjs` 中断言无估算单时不抛异常、显示空提示文案)。
- **未匹配产品**:估算单 `productId` 为空或指向已删除产品,且名称规格/预算表编号都匹配不上产品 → 明细仍出现,产品编号=估算单 `code`、产品名称=「未匹配产品」(测试:`stats.test.cjs` 的三级匹配与兜底用例)。
- **负结存**:上存+进料 < 用料(演示数据恒为此情形)→ 期末结存与累计剩余显示负数并带 `neg` 类,不显示 0 或空白(测试:`stats.test.cjs` 负值断言 + `cdp-usage-test.cjs` 断言存在 `.neg`)。
- **空单元格数值**:材料行 `qtyPerPot` / `price` / `stockOnHand` / `stockIn` 为空字符串或 null → 按 0 参与计算,不产生 `NaN`;界面显示 0 而不是 `NaN`(测试:`stats.test.cjs` 用含空值的估算单断言无 `NaN`)。
- **同一材料跨区**:同一材料在底料与面料各有一行(如 estimate3 的黑水泥)→ 明细拆成两行、锅数分别取 `potBottom`/`potTop`;剩余材料表按材料名合并为一行(测试:`stats.test.cjs` 跨区用例断言明细 2 行、剩余表 1 行)。

---

### 任务 1:aggregations 纯函数模块 `stats.js`

**文件:**
- 新建:`public/js/stats.js`
- 测试:`test/stats.test.cjs`

**接口:**
- 消费:`public/js/calc.js` 的 `CostCalc.compute(est)` → `{ calc, listTotals, rows }`(Node 下 `require('../public/js/calc.js')`)
- 产出(后续任务依赖):
  - `window.Stats` / `module.exports`
  - `Stats.matchProduct(est, products) -> { code, name, matched:boolean }`
  - `Stats.buildUsage(data, filter) -> { detail, stock, meta }`
    - 入参 `data = { estimates, products, materials }`;`filter = { from:'', to:'', types:[], mats:[] }`(`types` 为产品名数组,空数组=全部;`mats` 为材料名数组,空数组=全部)
    - `detail[]`: `{ code, date, productCode, productName, materialName, zone, qtyPerPot, pots, usageKg, price, amount, ratio, closing }`
    - `stock[]`: `{ name, zone, stockOnHand, stockIn, usageKg, closingTotal, latestClosing, estCount }`
    - `meta`: `{ estCount, rowCount, totalKg, totalAmount, unmatched }`

- [ ] **步骤 1:编写失败的测试** `test/stats.test.cjs`

构造固定数据(不依赖数据库):

```js
const Stats = require('../public/js/stats.js');
const products = [
  { id: 'p1', name: '标砖 A', code: 'A-100' },
  { id: 'p2', name: '透水砖 B', code: 'B-200' }
];
const m = (name, zone) => ({ id: 'mid-' + name, name, zone });
const materials = [m('黑水泥', '底料'), m('机制砂', '底料'), m('染料', '面料')];
const rows = (list) => list.map(([name, zone, qty, price, sh, si]) => ({
  id: 'r' + name + zone, materialId: 'mid-' + name, name, zone,
  qtyPerPot: qty, price, stockOnHand: sh, stockIn: si, qty: ''
}));
const est = (id, pid, name, code, date, potB, potT, list) => ({
  id, productId: pid, name, code, startDate: date, endDate: date, author: 'a',
  potBottom: potB, potTop: potT, status: 'ready',
  rows: rows(list),
  calc: { length: 240, width: 115, height: 53, perPieceWeight: 2.5, perModuleCount: 24, moldManual: 10,
    perPalletCount: 300, perPalletSqm: 8.28, actualCount: '', startMold: 1, endMold: 10 }
});
const data = {
  products, materials,
  estimates: [
    est('e1', 'p1', '标砖 A', 'A-100', '2026-09-01', 10, 5,
      [['黑水泥', '底料', 20, 0.26, 0, 100], ['机制砂', '底料', 30, 0.06, 50, 0], ['染料', '面料', 1, 8.6, 0, 0]]),
    est('e2', 'p2', '透水砖 B', 'B-200', '2026-10-01', 8, 4,
      [['黑水泥', '底料', 25, 0.26, 0, 40], ['机制砂', '底料', 40, 0.06, 0, 0]]),
    est('e3', '', '手工砖 C', 'C-300', '2026-10-05', 6, 0, [['黑水泥', '底料', 10, 0.26, 0, 0]])
  ]
};
const near = (a, b) => Math.abs(a - b) < 1e-9;
```

断言(每个断言一个 `assert` 调用,失败即 `process.exit(1)` 并打印用例名):

1. 三级匹配:`matchProduct(data.estimates[0], products)` → `{ code:'A-100', name:'标砖 A', matched:true }`;
2. 按产品名匹配:`matchProduct({ name:'透水砖 B', code:'X' }, products)` → `matched:true, code:'B-200'`;
3. 按预算表编号匹配:`matchProduct({ name:'其他', code:'B-200' }, products)` → `matched:true`;
4. 未匹配兜底:`matchProduct(data.estimates[2], products)` → `{ code:'C-300', name:'未匹配产品', matched:false }`;
5. 明细行数:`buildUsage(data, {}).detail.length === 6`(e1 三行 + e2 两行 + e3 一行);
6. 明细行字段(e1 黑水泥行):`usageKg === 200`(20×10)、`amount === 52`(200×0.26)、`closing === -100`(0+100−200)、`pots === 10`、`zone === '底料'`;
7. 占比:该行 `ratio` 与 `200 / listTotals.usageKg(e1)` 相等(用 `CostCalc.compute(data.estimates[0]).listTotals.usageKg` 比对);
8. 面料行锅数:染料行 `pots === 5`、`usageKg === 5`;
9. 剩余材料表:行数 3(黑水泥/机制砂/染料),黑水泥 `{stockOnHand:0, stockIn:140, usageKg:200+200+60=460, closingTotal:-320, estCount:3}`;
10. 最新批次结存:黑水泥 `latestClosing` 取批次日期最新的 e3(`2026-10-05`,0+0−60 = `-60`);
11. 未匹配提示:`meta.unmatched === 1`;
12. 小计:`meta.estCount === 3`、`meta.rowCount === 6`、`meta.totalKg === 200+300+5+200+320+60 = 1085`;
13. 时间段筛选:`buildUsage(data, { from:'2026-10-01' }).meta.estCount === 2`(e2/e3);
14. 产品筛选:`buildUsage(data, { types:['标砖 A'] }).detail.length === 3`;
15. 材料筛选:`buildUsage(data, { mats:['黑水泥'] }).detail.length === 3`,且 `meta.totalKg` 仍为该筛选批次的**全材料**合计(不因材料筛选而缩小);
16. 空值不产生 NaN:构造一行 `qtyPerPot:''`、`price:null`、`stockOnHand:null`、`stockIn:''` 的估算单,断言其明细行 `usageKg === 0 && amount === 0 && closing === 0`,且 `JSON.stringify(result).indexOf('NaN') < 0`;
17. 跨区同材料:构造一行黑水泥在面料区,断言明细出现两行黑水泥(锅数分别 10/5),剩余材料表中黑水泥仅 1 行且 `usageKg` 为两行之和;
18. 空数据:`buildUsage({ estimates:[], products, materials }, {})` → `{ detail:[], stock:[], meta:{ estCount:0, rowCount:0, totalKg:0, totalAmount:0, unmatched:0 } }`。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/stats.test.cjs`
预期:FAIL,报 `Cannot find module '../public/js/stats.js'`

- [ ] **步骤 3:实现 `public/js/stats.js`**

要求(签名与行为见上;函数体自行实现,以下为必须遵守的决定):
- UMD 头照抄 `public/js/calc.js` 的写法(浏览器挂 `window.Stats`)。
- Node 下通过 `require('./calc.js')` 获取 `CostCalc`;浏览器下用 `window.CostCalc`(app.js 保证 calc.js 先加载)。
- 所有数值经内部 `num(v)` 归零处理(`Number(v)`,非有限值→0),避免 `NaN`。
- 明细行顺序:日期降序(date 为空视为最早)→ 产品编号升序 → 用料降序。
- 剩余材料表顺序:累计剩余升序(最缺在前)。
- `latestClosing`:按日期升序取最后一个含该材料的批次(日期为空排最前);无则 `null`。
- `meta.totalKg/totalAmount`:筛选后**全部明细行**合计。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/stats.test.cjs`
预期:`✅ stats.js 全部单元测试通过`

- [ ] **步骤 5:提交**

```bash
git add public/js/stats.js test/stats.test.cjs
git commit -m "feat(stats): 用料明细与剩余材料聚合模块"
```

---

### 任务 2:页签、路由与「用料明细」视图骨架

**文件:**
- 修改:`public/index.html`(页签区 ~L16-23、视图区 `<section id="view-overview">` 之后)
- 修改:`public/js/app.js`(`applyHash` 的视图名分支 ~L178-181、`switchView` 分支 ~L143-149、新增 `renderUsage()` 与状态变量)
- 修改:`public/css/style.css`(追加样式)

**接口:**
- 消费:任务 1 的 `Stats.buildUsage(data, filter)`
- 产出:
  - 视图容器 `#view-usage`(内含 `#usage-filter`、`#usage-detail`、`#usage-stock`、`#usage-export-detail`、`#usage-export-stock` 五个元素)
  - `renderUsage()`(无参,从模块级状态重绘)
  - 状态变量 `usageFrom`、`usageTo`、`usageTypes`(数组)、`usageMats`(数组)

- [ ] **步骤 1:编写失败的测试** `test/cdp-usage-test.cjs`

照抄 `test/cdp-overview-check.cjs` 的 CDP 骨架(启动无头 Edge、连 ws、`evalJS`/`waitFor`/`assert` 工具函数),断言:
1. 页签存在且顺序正确:`Array.from(document.querySelectorAll('.tab')).map(t => t.dataset.view)` 中 `usage` 紧跟在 `overview` 之后;
2. 打开 `location.hash = '#usage'` 后 `#view-usage` 可见且含 `#usage-detail` 与 `#usage-stock`;
3. 无 console error。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:FAIL(找不到 `.tab[data-view="usage"]`)

- [ ] **步骤 3:实现页签、路由与视图骨架**

- `index.html`:在「成本总览」按钮后插入 `<button class="tab" data-view="usage">用料明细</button>`;在 `#view-overview` 之后插入 `<section id="view-usage" class="view" hidden></section>`;
- `app.js`:`applyHash` 的视图名列表加入 `usage`;`switchView` 分支加入 `else if (name === 'usage') renderUsage();`;
- `renderUsage()` 首版:把 `Stats.buildUsage(data, { from: usageFrom, to: usageTo, types: usageTypes, mats: usageMats })` 结果渲染为两个容器(明细与剩余材料各一个 `<table>`),筛选条容器先渲染为静态占位(下一任务实现);
- 声明状态变量(默认空)。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/index.html public/js/app.js public/css/style.css test/cdp-usage-test.cjs
git commit -m "feat(usage): 用料明细页签与视图骨架"
```

---

### 任务 3:用料明细表(含期末结存与负数标红)

**文件:**
- 修改:`public/js/app.js`(`renderUsage()` 内明细表渲染)
- 修改:`public/css/style.css`(`.neg`、明细表样式)
- 测试:`test/cdp-usage-test.cjs`(追加断言)

**接口:**
- 消费:任务 1 的 `detail[]` 行结构;任务 2 的 `#usage-detail` 容器
- 产出:明细表 DOM 结构固定为 `<table class="usage-table"><thead>…</thead><tbody><tr data-code="…">…</tr></tbody></table>`,负数单元格带 `class="neg"`;表头固定 12 列(预算表编号/批次日期/产品编号/产品名称/材料名称/所属区/每锅数量(公斤)/锅数/本期用料(公斤)/单价(元/公斤)/金额(元)/占比/期末结存(公斤) —— 共 13 列)

- [ ] **步骤 1:编写失败的测试**(追加到 `test/cdp-usage-test.cjs`)

`seed-demo` 数据下断言:
1. 明细表行数 = 22(e1 11 行 + e2 11 行);
2. 表头文本依次包含「期末结存(公斤)」;
3. 表格内至少存在 1 个 `td.neg`(演示数据结存为负);
4. 抽查首行:第 9 列(本期用料)数值 = 第 7 列 × 第 8 列(每锅数量 × 锅数),第 13 列(期末结存)= 该行 `上存+进料−本期用料` —— 从行内 `data-*` 属性读取原始值比对(实现时在 `<tr>` 上写 `data-sh`、`data-si`、`data-usage`);
5. 顶部小计文本包含「张预算表」与「行明细」;
6. 空数据路径:把筛选时间段设为 `2026-01-01` ~ `2026-01-02`(无批次命中)后,`#usage-detail` 与 `#usage-stock` 均显示空提示文案(含「暂无」),且无 console error;随后点「清除」恢复 22 行。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:FAIL(行数或表头不符)

- [ ] **步骤 3:实现明细表渲染**

按 13 列表头与上述 DOM 结构渲染;数值列用现有 `fmt`(公斤/金额)与 `pct`(占比);`closing < 0` 时该单元格加 `neg`;每行 `<tr>` 写入 `data-sh`/`data-si`/`data-usage`/`data-code` 便于测试与排查。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/app.js public/css/style.css test/cdp-usage-test.cjs
git commit -m "feat(usage): 用料明细表含期末结存与负数标红"
```

---

### 任务 4:剩余材料表

**文件:**
- 修改:`public/js/app.js`(`renderUsage()` 内剩余材料表渲染)
- 测试:`test/cdp-usage-test.cjs`(追加断言)

**接口:**
- 消费:任务 1 的 `stock[]` 行结构;任务 2 的 `#usage-stock` 容器
- 产出:剩余材料表 7 列(材料名称/所属区/累计上存(公斤)/累计进料(公斤)/累计用料(公斤)/累计剩余(公斤)/最新批次结存(公斤)/涉及批次数 —— 共 8 列),负数带 `neg`;`latestClosing === null` 显示「—」

- [ ] **步骤 1:编写失败的测试**(追加)

`seed-demo` 下断言:
1. 剩余材料表行数 = 11(材料种数);
2. 存在 `#usage-stock td.neg`(累计剩余为负);
3. 首行「累计剩余」= 累计上存 + 累计进料 − 累计用料(用行内 `data-*` 值比对);
4. 「最新批次结存」列有值或显示「—」,不出现 `undefined`/`NaN`(断言表文本不含 `NaN` 与 `undefined`)。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:FAIL

- [ ] **步骤 3:实现剩余材料表渲染**

按 8 列表头渲染;`closingTotal < 0` 与 `latestClosing < 0` 加 `neg`;`latestClosing === null` 显示「—」。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/app.js test/cdp-usage-test.cjs
git commit -m "feat(usage): 剩余材料表(累计与最新批次结存)"
```

---

### 任务 5:筛选条(时间段/产品/材料)与两表导出

**文件:**
- 修改:`public/js/app.js`(`renderUsage()` 内筛选条渲染 + change/click 事件分支 + 导出处理)
- 修改:`public/css/style.css`(筛选条沿用 `.ovl-filter` 系列类)
- 测试:`test/cdp-usage-test.cjs`(追加断言)

**接口:**
- 消费:任务 3/4 的表格渲染;既有 `Exporter.buildSpreadsheetML(title, grid)` 与 `Exporter.exportXLS(filename, tableEl)`(见 `public/js/exporter.js`)
- 产出:
  - 筛选条 DOM:日期输入 `#usage-from`/`#usage-to`,产品 chip `input[name="usage-type"]` + 全选框 `input.ovl-all[data-group="usage-type"]`,材料 chip `input[name="usage-mat"]` + 全选框 `input.ovl-all[data-group="usage-mat"]`,清除按钮 `[data-action="usage-clear"]`,导出按钮 `[data-action="usage-export-detail"]`/`[data-action="usage-export-stock"]`
  - 事件语义与成本总览一致:**默认"全部"不勾任何子项;点哪个选哪个,可继续加勾;点「全部」恢复不限**

- [ ] **步骤 1:编写失败的测试**(追加)

`seed-demo` 下断言:
1. `#usage-from` 设为 `2026-10-01` 并派发 `change` 后,明细行数 = 11(只剩 e2);
2. 点「清除」后明细行数回到 22;
3. 材料 chip 中「黑水泥」单选后,明细中所有行的第 5 列(材料名称)=「黑水泥」,且剩余材料表 = 1 行;
4. 剩余材料表在材料筛选下的「累计用料」= 该材料在两批中的用料之和(从行内 `data-*` 值比对);
5. 导出按钮存在(点击导出不在无头环境断言文件落盘,仅断言按钮存在且点击后无异常)。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:FAIL

- [ ] **步骤 3:实现筛选条与导出**

- 复用 `ovlFilterBarHTML` 的 chip 渲染思路(可抽取共用函数或独立实现一份 `usageFilterBarHTML()`,避免影响总览/图表);
- `change` 事件:`#usage-from`/`#usage-to`、`input[name="usage-type"]`、`input[name="usage-mat"]`、`input.ovl-all[data-group=…]` → 更新状态后 `renderUsage()`;
- `click` 事件:`usage-clear` 清空全部筛选;`usage-export-detail`/`usage-export-stock` 调 `Exporter.exportXLS('用料明细-YYYYMMDD', tableEl)`;
- 筛选后重绘需保持滚动位置(复用既有 `withScrollKept`)。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/seed-demo.cjs && node test/cdp-usage-test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/app.js public/css/style.css test/cdp-usage-test.cjs
git commit -m "feat(usage): 筛选条与两表导出"
```

---

### 任务 6:回归、文档与数据复原

**文件:**
- 修改:`使用说明.md`(新增「用料明细」一节)、`README.md`(功能清单 + 测试命令)
- 测试:全量既有套件 + 新增两个测试

**接口:**
- 消费:任务 1–5 全部产物
- 产出:文档章节与测试清单条目;干净的工作树

- [ ] **步骤 1:运行全量回归**

运行(逐条,前一条通过再跑下一条):

```bash
node test/calc.test.cjs && node test/formula.test.cjs && node test/sheet.test.cjs && node test/exporter.test.cjs
node test/stats.test.cjs
node test/auth-api-check.cjs
node test/seed-demo.cjs && node test/cdp-usage-test.cjs
node test/seed-demo.cjs && node test/cdp-test.cjs
node test/seed-demo.cjs && node test/cdp-overview-check.cjs
```

预期:全部输出以 ✅ 结尾;若任一条失败,修复后重跑该条与 `stats.test.cjs`。

- [ ] **步骤 2:更新文档**

- `使用说明.md`:在「成本总览」之后新增「用料明细」小节,写明页签位置、两表列含义、期末结存/累计剩余口径(可为负)、筛选与导出用法;
- `README.md`:功能清单加一行「用料明细」,测试命令清单加 `test/stats.test.cjs`、`test/cdp-usage-test.cjs`。

- [ ] **步骤 3:复原验证数据集**

运行:`node test/mock-demo.cjs && node test/data-audit.cjs`
预期:`组装完成:估算单 14(estimate3=true, mock=11),产品 7` 与 `数据审计通过`

- [ ] **步骤 4:提交**

```bash
git add 使用说明.md README.md
git commit -m "docs: 用料明细说明与测试清单"
```

---

## 完成标准

- `node test/stats.test.cjs` 与 `node test/cdp-usage-test.cjs` 全绿;
- 既有 17 项测试全绿;
- 用料明细页在 `seed-demo` 与 `mock-demo` 两套数据下均能正确显示明细行、期末结存、剩余材料与筛选结果;
- 两表导出按钮可用(导出为 `.xls`);
- 文档已更新、数据已复原、工作树干净。
