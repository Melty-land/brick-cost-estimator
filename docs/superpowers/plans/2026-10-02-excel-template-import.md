# Excel 模板导出与估算单导入实施计划 —— 阶段二

> **面向 Agent 执行者:** 必需子技能:使用 subagent-driven-development(推荐)或 executing-plans 按任务逐项实现本计划。步骤使用复选框(`- [ ]`)语法跟踪进度。

**目标:** 估算单列表页新增「下载导入模板」与「导入 Excel」:模板为扁平表(`.xls`),导入支持 `.xlsx/.xls/.csv`,按表头智能识别字段(可手动改映射)、逐行校验预览后批量导入预算表。

**架构:** 新增 `public/js/xlsio.js` 承担全部文件解析与校验(纯逻辑、Node 可单测):统一自研 XML 解析器 → 按扩展名分流的三种读取器 → 统一 `{sheets:[{name,rows}]}` → 字段别名映射 → 校验与分组;`public/js/exporter.js` 扩展为支持多工作表以生成模板;`app.js` 新增导入视图与交互,导入结果经既有 `Sheet.evaluate` 回写派生值后 `Store.addEstimate` + `Store.save` 落库。

**技术栈:** 原生 ES5 风格 JS(UMD,浏览器 + Node)、零第三方依赖、离线;`.xlsx` 解压浏览器用 `DecompressionStream('deflate-raw')`,Node 测试注入 `zlib.inflateRawSync`;测试用 Node assert + 现有 CDP 套件(本机无头 Edge,`DOM.setFileInputFiles` 上传文件)。

**规格:** `docs/superpowers/specs/2026-10-02-material-stats-excel-io-design.md`(第四、五、六、七、八、十节与本计划对应)

## 全局约束

- 零第三方依赖、完全离线:不得引入 npm 包、CDN;不得使用 `DOMParser`(Node 无此 API,单测无法运行),XML 一律走自研解析器。
- 新增文件必须同时支持浏览器(挂 `window.Xlsio`)与 Node(`module.exports`),照抄 `public/js/calc.js` 的 UMD 头写法。
- 单位与文案:重量称「公斤」,金额「元」;表头别名表按规格 5.4 逐条实现,不增不减。
- 模板工作表名固定为「估算单导入」与「填写说明」;导入视图容器 id 固定 `view-import`,文件输入 id 固定 `import-file`。
- 冲突判定:分组「预算表编号」与现有估算单 `code` 去空格后完全相同即为冲突;默认「跳过」。
- 落库前后顺序:先全校验 → 用户确认 → 一次性写入(部分失败不写半截)。
- 提交纪律:显式 `git add` 指定文件;提交前自查泄露;提交信息用临时文件 `-F` 传入。

## Review Focus

- **非 Excel 输入**:用户选中 `.txt`/`.png`/空文件 → 顶部提示「不支持的文件类型」或「未读取到工作表」,不抛异常、不进入预览(测试:`xlsio.test.cjs` 用乱码/空内容断言返回错误码而非抛错;`cdp-import-test.cjs` 断言提示文案)。
- **表头缺失或错位**:首行没有可识别表头 / 用户删掉了「材料名称」列 → 三个材料级字段(材料名称/每锅数量/单价)任一未映射时禁用导入并提示(测试:`xlsio.test.cjs` 的表头缺失用例 + CDP 断言导入按钮 disabled)。
- **材料不存在**:名称与材料档案不匹配(含前后空格、全角空格)→ 该行报错并指出材料名与行号,阻断导入(测试:`xlsio.test.cjs` 断言错误信息含材料名)。
- **日期多样性**:`2026-10-02`、`2026/10/2`、`2026.10.2`、`2026年10月2日`、Excel 序列号 `46214`(→2026-07-10 附近的真实换算由实现按 1900 基准得出)→ 都能解析为 `YYYY-MM-DD`;无法解析时报错(测试:`xlsio.test.cjs` 逐格式断言 + 非法日期报错)。
- **示例行与重复行**:模板第 2 行示例(预算表编号列含「示例」或为空)必须被跳过;同一预算表编号内同一材料出现两次必须报错(测试:`xlsio.test.cjs` 两个用例)。

---

### 任务 1:统一 XML 解析器与 `.xls`(SpreadsheetML)读取

**文件:**
- 新建:`public/js/xlsio.js`
- 测试:`test/xlsio.test.cjs`

**接口:**
- 消费:无
- 产出:
  - `Xlsio.parseXml(xmlText) -> TreeNode`(`{ name, attrs:{}, children:[], text:'' }`,name 为剥离前缀后的本地名)
  - `Xlsio.parseSpreadsheetML(xmlText) -> { sheets:[{ name, rows:string[][] }] }`
  - `Xlsio.XmlError`(解析失败时抛出,消息为中文)

- [ ] **步骤 1:编写失败的测试** `test/xlsio.test.cjs`

```js
const Xlsio = require('../public/js/xlsio.js');
const assert = require('assert');
function ok(cond, msg) { if (!cond) { console.error('✗ ' + msg); process.exit(1); } console.log('✓ ' + msg); }

const XLS_SAMPLE = '<?xml version="1.0"?>\n' +
  '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
  '<Worksheet ss:Name="估算单导入"><Table>' +
  '<Row><Cell><Data ss:Type="String">预算表编号</Data></Cell><Cell><Data ss:Type="String">材料名称</Data></Cell><Cell><Data ss:Type="Number">20</Data></Cell></Row>' +
  '<Row><Cell ss:Index="2"><Data ss:Type="String">跳列</Data></Cell></Row>' +
  '</Table></Worksheet>' +
  '<Worksheet ss:Name="填写说明"><Table><Row><Cell><Data ss:Type="String">说明</Data></Cell></Row></Table></Worksheet>' +
  '</Workbook>';
```

断言:
1. `parseXml('<A x="1"><B>t</B><C/></A>')` → 根 `name === 'A'`、`attrs.x === '1'`、`children.length === 2`、`children[0].text === 't'`、`children[1].children.length === 0`;
2. 实体解码:`parseXml('<A>&lt;x&gt;&amp;&#65;</A>').text === '<x>&A'`;
3. 前缀剥离:`parseXml('<ss:Row><ss:Cell/></ss:Row>').name === 'Row'` 且 `children[0].name === 'Cell'`;
4. 注释忽略:`parseXml('<A><!-- c --><B/></A>').children.length === 1`;
5. `parseSpreadsheetML(XLS_SAMPLE).sheets.length === 2`、`sheets[0].name === '估算单导入'`;
6. 行内容:`sheets[0].rows[0]` 深等于 `['预算表编号','材料名称','20']`;
7. 跳列:`sheets[0].rows[1]` 深等于 `['','跳列']`(`ss:Index="2"` → 第 1 列为空);
8. 第二表:`sheets[1].rows[0][0] === '说明'`;
9. 非法输入:`parseSpreadsheetML('not xml at all')` 抛 `Xlsio.XmlError`(用 `assert.throws` 断言),不返回垃圾数据。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/xlsio.test.cjs`
预期:FAIL,报 `Cannot find module '../public/js/xlsio.js'`

- [ ] **步骤 3:实现 `public/js/xlsio.js` 的解析器部分**

要求(函数体自行实现,以下为必须遵守的决定):
- 扫描式解析:逐字符识别 `<name attrs>`、`</name>`、`<name/>`、文本、注释 `<!-- -->`、`<?xml ?>`、CDATA;
- 属性同时支持单引号与双引号;`attrs` 键为剥离前缀后的本地名,同时保留原键(如 `ss:Name` 与 `Name` 均可取到,实现时统一存本地名并在取值处按本地名读取);
- 实体解码:`&amp; &lt; &gt; &quot; &apos;` 与 `&#NN;`/`&#xHH;`;
- `parseSpreadsheetML`:遍历 `Worksheet` 节点,取 `Name` 属性;`Row` 内按 `Cell` 的 `Index` 属性定位列(缺省=上一列+1),`Data` 文本即单元格值;缺失单元格补 `''` 使每行列数对齐到该表最大列数;
- 结构不合法(无根元素/标签不闭合)抛 `Xlsio.XmlError`。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/xlsio.test.cjs`
预期:`✅ xlsio 解析单元测试通过`(此时仅解析部分)

- [ ] **步骤 5:提交**

```bash
git add public/js/xlsio.js test/xlsio.test.cjs
git commit -m "feat(xlsio): 统一 XML 解析器与 SpreadsheetML 读取"
```

---

### 任务 2:CSV 读取

**文件:**
- 修改:`public/js/xlsio.js`
- 测试:`test/xlsio.test.cjs`(追加)

**接口:**
- 消费:任务 1 的模块
- 产出:`Xlsio.parseCsvText(text) -> string[][]`

- [ ] **步骤 1:编写失败的测试**(追加)

断言:
1. 基本:`parseCsvText('a,b\nc,d')` 深等于 `[['a','b'],['c','d']]`;
2. 引号与逗号:`parseCsvText('"a,1",b')` 深等于 `[['a,1','b']]`;
3. 引号转义:`parseCsvText('"say ""hi""",x')` 深等于 `[['say "hi"','x']]`;
4. 换行在引号内:`parseCsvText('"line1\nline2",x')` 深等于 `[['line1\nline2','x']]`;
5. CRLF 与 BOM:`parseCsvText('\uFEFFa,b\r\nc,d\r\n')` 深等于 `[['a','b'],['c','d']]`;
6. 尾随空列:`parseCsvText('a,')` 深等于 `[['a','']]`。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/xlsio.test.cjs`
预期:FAIL(`parseCsvText is not a function`)

- [ ] **步骤 3:实现 `parseCsvText`**

要求:单遍扫描、状态机(普通/引号内);CRLF 与 LF 均作行分隔;句首 BOM 去除;不做类型推断(全部字符串)。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/xlsio.test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/xlsio.js test/xlsio.test.cjs
git commit -m "feat(xlsio): CSV 读取"
```

---

### 任务 3:`.xlsx` 读取(zip + 解压 + OOXML)

**文件:**
- 修改:`public/js/xlsio.js`
- 测试:`test/xlsio.test.cjs`(追加;用 `zlib` 现场生成最小 xlsx 样本)

**接口:**
- 消费:任务 1 的 `parseXml`
- 产出:
  - `Xlsio.parseXlsx(bytes: Uint8Array|Buffer, opts:{ inflateRaw: (data:Uint8Array)=>Promise<Uint8Array> }) -> Promise<{ sheets:[{name,rows}] }>`
  - `Xlsio.readFile({ name, bytes, inflateRaw }) -> Promise<{ sheets }>`(按扩展名分流 `.csv/.xls/.xlsx`,后续任务使用)

- [ ] **步骤 1:编写失败的测试**(追加)

测试内用 `zlib.deflateRawSync` + 手写 zip 结构生成两个样本(文件短小,便于构造):
- 样本 A:含 `xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/sharedStrings.xml`、`xl/worksheets/sheet1.xml`,内容为两行数据(第一行表头「预算表编号/材料名称」,第二行 `['DK-001','黑水泥']`,其中字符串用 sharedStrings 引用、数字用 `<v>`);
- 样本 B:压缩方法为 stored(不压缩)的同类文件。

断言:
1. `await parseXlsx(sampleA, { inflateRaw: async (b) => zlib.inflateRawSync(b) })` → `sheets.length === 1`、`sheets[0].name === '估算单导入'`;
2. `sheets[0].rows[0]` 深等于 `['预算表编号','材料名称']`、`rows[1]` 深等于 `['DK-001','黑水泥']`;
3. stored 压缩样本同样能读出(样本 B);
4. 损坏 zip(把样本 A 截断一半)→ reject 或抛 `Xlsio.XmlError`,消息含「损坏」;
5. `readFile({ name:'a.csv', bytes: Buffer.from('a,b') })` → `sheets[0].rows[0]` 深等于 `['a','b']`(分流正确);
6. `readFile({ name:'a.txt', bytes: Buffer.from('x') })` → reject,消息含「不支持」;
7. `readFile({ name:'a.xls', bytes: Buffer.from(XLS_SAMPLE) })` → 走 SpreadsheetML 路径,`sheets[0].name === '估算单导入'`。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/xlsio.test.cjs`
预期:FAIL(`parseXlsx is not a function`)

- [ ] **步骤 3:实现 `parseXlsx` 与 `readFile`**

要求:
- zip:从尾部扫描 End of Central Directory(`0x06054b50`)→ 中央目录条目(`0x02014b50`)→ 本地文件头(`0x04034b50`)→ 取压缩数据;`compressionMethod` 0=直接取,8=调用 `opts.inflateRaw`;条目名用 UTF-8 解码;
- OOXML:优先按 `xl/_rels/workbook.xml.rels` + `xl/workbook.xml` 的 `r:id` 解析表名与路径,缺失时回退 `xl/worksheets/sheet1.xml`;`sharedStrings.xml` 的每个 `si` 节点取其全部 `t` 文本拼接;单元格 `t="s"` 查共享字符串、`t="inlineStr"` 取 `is/t`、其他取 `v`;`r` 属性(如 `B2`)解析列号以支持跳列;
- `readFile`:扩展名小写后分流;未知扩展名 reject 错误消息「不支持的文件类型:xxx」;`.xls/.xml` 走 `parseSpreadsheetML`;`.csv` 走 `parseCsvText` 并包装为 `{ sheets:[{ name:'CSV', rows }] }`;
- 浏览器侧 `inflateRaw` 由 app.js 提供(`DecompressionStream('deflate-raw')` 包装),模块内不直接依赖浏览器 API。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/xlsio.test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/xlsio.js test/xlsio.test.cjs
git commit -m "feat(xlsio): xlsx(zip+OOXML)与 readFile 分流"
```

---

### 任务 4:字段定义与表头智能识别

**文件:**
- 修改:`public/js/xlsio.js`
- 测试:`test/xlsio.test.cjs`(追加)

**接口:**
- 消费:任务 1–3 的解析结果
- 产出:
  - `Xlsio.FIELDS: Array<{ key, label, aliases:string[], required:boolean, type:'text'|'num'|'date', level:'batch'|'material' }>`(字段与别名严格按规格 4.3 与 5.4)
  - `Xlsio.normalizeHeader(s) -> string`(去空格/全角空格/单位括号/小写化)
  - `Xlsio.detectMapping(headerRow:string[]) -> { [fieldKey]: colIndex }`
  - `Xlsio.MATERIAL_KEYS = ['materialName','qtyPerPot','price']`

- [ ] **步骤 1:编写失败的测试**(追加)

断言:
1. `FIELDS` 含 19 个字段(`code,name,startDate,endDate,author,length,width,height,perPieceWeight,perModuleCount,perPalletCount,perPalletSqm,potBottom,potTop,materialName,qtyPerPot,price,stockOnHand,stockIn`),且 `MATERIAL_KEYS` 三项 `required === true`;
2. 精确列名:`detectMapping(['预算表编号','名称规格','开始日期','砖长(mm)','材料名称','每锅数量(公斤)','单价(元/公斤)'])` → `{ code:0, name:1, startDate:2, length:3, materialName:4, qtyPerPot:5, price:6 }`;
3. 别名:`detectMapping(['编号','产品名称','起始日期','长','品名','每锅用量','单价'])` → 键含 `code,name,startDate,length,materialName,qtyPerPot,price`;
4. 单位与空格容错:`detectMapping([' 砖长 (mm) ','每块重量（公斤）'])` → `{ length:0, perPieceWeight:1 }`;
5. 未识别列被忽略:`detectMapping(['备注','预算表编号'])` → `{ code:1 }`;
6. 大小写:`detectMapping(['CODE','Name'])` → `{ code:0, name:1 }`。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/xlsio.test.cjs`
预期:FAIL(`FIELDS is undefined`)

- [ ] **步骤 3:实现字段表与识别**

要求:
- `normalizeHeader` 去掉:所有空白、`(`~`）` 内的内容、`(kg)`/`(mm)`/`(元/公斤)`/`(公斤)`/`(m²)`/`(块)` 等括号段、`的`;大小写归一并去除全角/半角差异;
- 识别顺序:精确列名 → 别名表(归一化后相等)→ 别名包含(归一化后别名是列名子串);同一列只映射一个字段,已被占用的列不再分配;
- 材料级字段与批次级字段同等参与识别。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/xlsio.test.cjs`
预期:PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/xlsio.js test/xlsio.test.cjs
git commit -m "feat(xlsio): 字段定义与表头智能识别"
```

---

### 任务 5:校验与分组

**文件:**
- 修改:`public/js/xlsio.js`
- 测试:`test/xlsio.test.cjs`(追加)

**接口:**
- 消费:任务 4 的 `FIELDS`/`detectMapping`
- 产出:
  - `Xlsio.parseDate(v) -> 'YYYY-MM-DD' | null`(支持 `YYYY-MM-DD`/`YYYY/M/D`/`YYYY.M.D`/`YYYY年M月D日`/Excel 序列号)
  - `Xlsio.validate(rows:string[][], mapping:{}, ctx:{ materials:Array<{id,name,zone}>, existingCodes:string[] }) -> { groups:Array<{ code, fields:{}, rows:Array<{ materialId, name, zone, qtyPerPot, price, stockOnHand, stockIn }>, conflict:boolean }>, errors:Array<{ row:number, field:string, msg:string }>, warnings:Array<{ row:number, msg:string }> }`
  - 行号约定:`errors[].row` 为**表格中的 1 基行号**(表头为第 1 行)。

- [ ] **步骤 1:编写失败的测试**(追加)

构造辅助:`const mk = (over) => {...}` 生成一行 19 列(按 `FIELDS` 顺序)的字符串数组;`ctx.materials = [{id:'m1',name:'黑水泥',zone:'底料'}]`,`ctx.existingCodes = ['EX-1']`。

断言:
1. 正常行 → `errors.length === 0`,`groups.length === 1`,`groups[0].rows[0]` 深等于 `{ materialId:'m1', name:'黑水泥', zone:'底料', qtyPerPot:20, price:0.26, stockOnHand:0, stockIn:100 }`(空的上存/进料按 0);
2. 同编号多行 → 合并为一个 group、`rows.length === 2`;
3. 示例行跳过:首列值为 `示例` 或空 → 该行不产生错误也不进入 groups;
4. 必填缺失(材料名称为空)→ `errors` 含 `{ row:2, field:'materialName', msg }`;
5. 锅数全 0/空 → `errors` 含 `field:'potBottom'` 的条目(消息含「锅数」);
6. 数值非法(砖长 = `abc`)→ `errors` 含 `field:'length'`;
7. 材料不存在(材料名称 `不存在的料`)→ `errors` 含消息里带该材料名的条目;
8. 日期五种格式全部解析为 `2026-10-02`;非法日期 `2026-13-99` → `errors` 含 `field:'startDate'`;
9. 分组内公共字段不一致(第二行砖长改成 999)→ `warnings.length >= 1` 且取首行值 240;
10. 同编号同材料重复 → `errors` 含消息带「重复」的条目;
11. 冲突:`预算表编号 = 'EX-1'` → `groups[0].conflict === true`;
12. Excel 日期序列号(如 `46214`)→ 解析为合法日期字符串且能通过校验;
13. 表头缺材料列:`mapping` 中缺 `materialName`(或 `qtyPerPot`/`price`)→ `validate` 直接返回 `errors`,消息含缺失字段名(供界面禁用导入按钮)。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/xlsio.test.cjs`
预期:FAIL(`validate is not a function`)

- [ ] **步骤 3:实现 `parseDate` 与 `validate`**

要求:
- 序列号换算按 1900 日期系统:`date = new Date(Date.UTC(1899,11,30) + serial*86400000)`,序列号小于 61 时按 1900 系统的历史偏差处理(实现时对 `serial < 61` 加 1 天),输出 `YYYY-MM-DD`;
- 校验顺序:逐行 → 逐字段(必填/类型)→ 材料存在性 → 分组 → 组内一致性(警告)→ 组内材料重复(错误);
- 错误不中断:全部收集后返回(前端展示后可修正);
- 所有数值字段解析失败时记录错误并跳过该行入组。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/xlsio.test.cjs`
预期:`✅ xlsio 全部单元测试通过`

- [ ] **步骤 5:提交**

```bash
git add public/js/xlsio.js test/xlsio.test.cjs
git commit -m "feat(xlsio): 逐行校验、日期解析与分组"
```

---

### 任务 6:多工作表导出与模板生成

**文件:**
- 修改:`public/js/exporter.js`(新增 `buildWorkbook`,保留 `buildSpreadsheetML` 原签名)
- 修改:`public/js/xlsio.js`(新增 `buildTemplate()`)
- 测试:`test/exporter.test.cjs`(追加)、`test/xlsio.test.cjs`(追加)

**接口:**
- 消费:任务 4 的 `FIELDS`
- 产出:
  - `Exporter.buildWorkbook(sheets: Array<{ name:string, grid:string[][] }>, opts?) -> string`(SpreadsheetML 2003 全文;单表时输出与 `buildSpreadsheetML` 等价)
  - `Exporter.exportWorkbook(filename, sheets)`(浏览器下载,复用现有下载逻辑)
  - `Xlsio.buildTemplate() -> Array<{ name:'估算单导入', grid }, { name:'填写说明', grid }>`

- [ ] **步骤 1:编写失败的测试**

`test/exporter.test.cjs` 追加:
1. `buildWorkbook([{ name:'A', grid:[['x']] }, { name:'B', grid:[['y']] }])` 输出含两个 `<ss:Worksheet ss:Name="A">`/`"B"`;
2. 单表调用 `buildWorkbook([{ name:'S', grid }])` 与既有 `buildSpreadsheetML('S', grid)` 输出**逐字节相同**;
3. 表名中的非法字符(`[]:*?/\`)被替换为 `_`。

`test/xlsio.test.cjs` 追加:
4. `buildTemplate()` 返回两个工作表,名称分别为「估算单导入」「填写说明」;
5. 第一表首行深等于 `FIELDS.map(f => f.label)`(19 列,顺序与 FIELDS 一致);
6. 第二行(示例行)首列为「示例」;
7. 说明表行数 ≥ 20(每字段一行)、首行含「字段」与「说明」;
8. 模板经 `parseSpreadsheetML(buildWorkbook(buildTemplate()))` 往返后,首行仍等于 `FIELDS.map(f => f.label)`(自洽性:导出的模板能被自己的解析器读回)。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/exporter.test.cjs && node test/xlsio.test.cjs`
预期:FAIL(`buildWorkbook is not a function`)

- [ ] **步骤 3:实现 `buildWorkbook` 与 `buildTemplate`**

要求:
- `buildWorkbook` 内部把现有单表生成逻辑抽为 `worksheetXml(sheet)`;文档头与 `<ss:Workbook>` 包裹只写一次;`ss:Name` 做非法字符替换并截断 30 字符;
- 列宽:沿用现有规则(第 2 列 90,其余 60),存在多表时各表独立;
- `buildTemplate`:`估算单导入` 表 = 表头行(`FIELDS[].label`)+ 示例行(首列「示例」,其余列填示例值如 `DK-001`/`多孔砖 240×115×90`/日期 `2026-07-10`/数字)+ 一行空的填写提示(第 3 行全空);`填写说明` 表 = 每字段一行(字段名、含义、单位、是否必填、示例),外加三条填写规则行。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/exporter.test.cjs && node test/xlsio.test.cjs`
预期:两者 PASS

- [ ] **步骤 5:提交**

```bash
git add public/js/exporter.js public/js/xlsio.js test/exporter.test.cjs test/xlsio.test.cjs
git commit -m "feat(exporter): 多工作表导出与导入模板生成"
```

---

### 任务 7:导入视图(选文件 → 映射 → 预览 → 冲突)

**文件:**
- 修改:`public/index.html`(列表页工具栏两个按钮 + `#view-import` 区块 + `<input type="file" id="import-file" accept=".xlsx,.xls,.csv" hidden>`)
- 修改:`public/js/app.js`(`renderImport()`、文件读取、映射下拉、预览渲染、导入按钮可用性)
- 修改:`public/css/style.css`(导入视图样式)
- 测试:`test/cdp-import-test.cjs`(新建)

**接口:**
- 消费:任务 3 的 `readFile`、任务 4 的 `FIELDS`/`detectMapping`、任务 5 的 `validate`、任务 6 的 `buildTemplate`/`exportWorkbook`
- 产出:
  - `renderImport(state)`(`state = { file, sheets, sheetIndex, mapping, result, conflictChoice:{[code]:'skip'|'update'|'copy'} }`)
  - DOM 契约:`[data-action="import-pick"]`(选文件)、`[data-action="tpl-download"]`(下载模板)、`#import-sheet`(工作表下拉,多表时)、映射下拉 `select[data-import-field="<key>"]`、预览表 `#import-preview`(错误行 `tr.err`,警告行 `tr.warn`)、冲突下拉 `select[data-conflict-code="<code>"]`、`[data-action="import-confirm"]`(确认导入,存在错误时 disabled)

- [ ] **步骤 1:编写失败的测试** `test/cdp-import-test.cjs`

CDP 骨架照抄 `test/cdp-overview-check.cjs`;额外使用:

```js
const CSV = ['预算表编号,名称规格,开始日期,结束日期,编制人,砖长(mm),砖宽(mm),砖高(mm),每块重量(公斤),每模块数,每托块数(块),每托平方(m²),底料锅数,面料锅数,材料名称,每锅数量(公斤),单价(元/公斤),上存材料(公斤),本期进料(公斤)',
  'IMP-1,导入测试砖,2026-11-01,2026-11-05,admin,240,115,90,3.2,24,300,8.28,40,15,黑水泥,120,0.26,0,500',
  'IMP-1,导入测试砖,2026-11-01,2026-11-05,admin,240,115,90,3.2,24,300,8.28,40,15,机制砂,220,0.06,0,800'].join('\n');
```

写入临时文件 `%TEMP%/dsh-import-sample.csv`,用 `DOM.setFileInputFiles` 设置到 `#import-file`,断言:
1. 列表页存在 `[data-action="import-pick"]` 与 `[data-action="tpl-download"]`;
2. 打开 `#import` 视图后 `#view-import` 可见;
3. 上传后自动识别:`select[data-import-field="code"]` 的选中列对应「预算表编号」(断言其 `value === '0'`);
4. 预览行数 = 2,错误行数 = 0,`[data-action="import-confirm"]` 未 disabled;
5. 点击确认 → 回到估算单列表,列表出现 `IMP-1`,其成本① > 0;
6. 打开用料明细页,筛选产品「导入测试砖」后明细行数 = 2;
7. 再次导入同一文件 → 冲突区出现 `select[data-conflict-code="IMP-1"]` 且默认值 `skip`,确认导入后被跳过(估算单数量不增加);
8. 全程无 console error;
9. 不支持的类型:用 `DOM.setFileInputFiles` 上传一个临时 `.txt` → 提示文案含「不支持」,且停留在导入视图(不进入预览);
10. 表头缺材料列:上传仅含批次列(无「材料名称/每锅数量/单价」)的 CSV → `[data-action="import-confirm"]` 处于 disabled,且页面提示含「材料名称」。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-import-test.cjs`
预期:FAIL(找不到导入按钮)

- [ ] **步骤 3:实现导入视图与交互**

要求:
- `index.html`:列表页工具栏加两个按钮;新增 `<section id="view-import" class="view" hidden>` 与 `<input type="file" id="import-file" hidden>`;
- `app.js`:hash `import` 路由与 `renderImport()`;文件读取用 `file.arrayBuffer()` 得到 `Uint8Array`;**文件大于 8MB 时直接提示「文件过大(超过 8MB),请拆分后重试」并停止解析**;`inflateRaw` 用 `DecompressionStream('deflate-raw')` 包装(不支持时提示「请另存为 .xls 或 .csv 后重试」);
- 映射下拉:每个 `FIELDS` 一行 `select`,选项为「(未映射)+ 各列(显示列名)」;改动即重算 `validate` 并重绘预览;
- 预览:前 50 行,错误行 `tr.err` + `title` 显示原因,警告行 `tr.warn`;底部汇总「将导入 X 张预算表 / 共 Y 行材料;错误 Z 行」;`errors.length > 0` 时 `import-confirm` 置 disabled;
- 冲突:每个 `groups[i].conflict` 渲染一个下拉(`跳过/覆盖更新/新建副本`),默认 `skip`;
- 确认导入:按任务 8 的落库逻辑执行(本任务先实现到"可调用 `commitImport()`",函数体在任务 8 完成并接通)。

- [ ] **步骤 4:运行测试,确认其通过**(此时第 5、6、7 条可能仍失败,属预期,留待任务 8)

运行:`node test/seed-demo.cjs && node test/cdp-import-test.cjs`
预期:第 1–4 条通过;第 5–7 条 FAIL(尚未落库)

- [ ] **步骤 5:提交**

```bash
git add public/index.html public/js/app.js public/css/style.css test/cdp-import-test.cjs
git commit -m "feat(import): 导入视图(选文件/映射/预览/冲突)"
```

---

### 任务 8:落库、对话框接线与端到端

**文件:**
- 修改:`public/js/app.js`(`commitImport()`、模板下载按钮接线)
- 测试:`test/cdp-import-test.cjs`(全部通过)

**接口:**
- 消费:任务 7 的 `renderImport` 状态与 `Store.addEstimate/Store.updateEstimate/Store.save`(既有)、`Sheet.evaluate`(既有)、`Exporter.exportWorkbook`(任务 6)
- 产出:`commitImport(state) -> Promise<{ added:number, updated:number, skipped:number }>`(成功后 `navigate('#estimates')` 并 `toast`)

- [ ] **步骤 1:编写失败的测试**

复用任务 7 的测试文件,断言第 5–7 条(见任务 7 步骤 1);另加:
9. 导入后数据完整性:通过 API 读取该估算单,断言 `rows.length === 2`、`calc.perSqmPrice` 非空、`status === 'ready'`。

- [ ] **步骤 2:运行测试,确认其失败**

运行:`node test/seed-demo.cjs && node test/cdp-import-test.cjs`
预期:第 5–7、9 条 FAIL

- [ ] **步骤 3:实现落库与接线**

要求:
- `commitImport`:
  1. 遍历 `groups`,按 `conflictChoice` 分流:`skip` 计入 `skipped`;`update` 用 `Store.updateEstimate(code 对应估算单.id, draft)`;`copy` 追加 `-副本`/`-副本2` 并 `Store.addEstimate(draft)`;无冲突直接 `addEstimate`;
  2. `draft` 结构与编辑器一致:`{ id, productId:'', name, code, startDate, endDate, author, potBottom, potTop, status:'ready', rows:[{ id, materialId, name, zone, qtyPerPot, price, stockOnHand, stockIn, qty:'' }], calc:{...} }`(`id` 由 `Store.addEstimate` 分配时留空,`calc` 先给规格默认值);
  3. 每个 draft 先用 `Sheet.evaluate(draft, { f:{}, v:{} })` 回写 `derive` 字段(照抄 `test/mock-demo.cjs` 中 `setPath` + `derive` 回写的写法),再落库;
  4. 全部成功后再 `Store.save()`;失败则 `toast` 原因且不写入(先在内存中构造全部 draft,成功构造后再逐个 `addEstimate`);
  5. 完成后 `navigate('#estimates')` + `toast('已导入 X 张预算表' + (skipped ? ',跳过 Y 张' : ''))`;
- 模板下载按钮:`[data-action="tpl-download"]` → `Exporter.exportWorkbook('估算单导入模板-YYYYMMDD', Xlsio.buildTemplate())`。

- [ ] **步骤 4:运行测试,确认其通过**

运行:`node test/seed-demo.cjs && node test/cdp-import-test.cjs`
预期:`✅ 导入端到端测试通过`

- [ ] **步骤 5:提交**

```bash
git add public/js/app.js test/cdp-import-test.cjs
git commit -m "feat(import): 估算单批量落库与端到端"
```

---

### 任务 9:回归、文档与数据复原

**文件:**
- 修改:`使用说明.md`、`README.md`
- 测试:全量套件

- [ ] **步骤 1:运行全量回归**

```bash
node test/calc.test.cjs && node test/formula.test.cjs && node test/sheet.test.cjs
node test/exporter.test.cjs && node test/xlsio.test.cjs && node test/stats.test.cjs
node test/auth-api-check.cjs
node test/seed-demo.cjs && node test/cdp-usage-test.cjs
node test/seed-demo.cjs && node test/cdp-import-test.cjs
node test/seed-demo.cjs && node test/cdp-test.cjs
node test/seed-demo.cjs && node test/cdp-nav-scroll-test.cjs
node test/seed-demo.cjs && node test/cdp-overview-check.cjs
```

预期:全部 ✅;失败则修复后重跑该条与受影响套件。

- [ ] **步骤 2:更新文档**

- `使用说明.md`:新增「Excel 导入与模板」小节(模板下载、字段说明、支持格式、映射与校验、冲突处理);
- `README.md`:功能清单加「Excel 模板与导入」;测试命令加 `test/xlsio.test.cjs`、`test/cdp-import-test.cjs`。

- [ ] **步骤 3:复原验证数据集**

运行:`node test/mock-demo.cjs && node test/data-audit.cjs`
预期:14 个估算单(estimate3 + 11 mock)、数据审计通过。

- [ ] **步骤 4:提交**

```bash
git add 使用说明.md README.md
git commit -m "docs: Excel 导入与模板说明"
```

---

## 完成标准

- `test/xlsio.test.cjs`、`test/cdp-import-test.cjs` 全绿;既有 17 项 + 阶段一新增测试全绿;
- 能下载模板 `.xls`,填好后原样导入并在估算单列表与用料明细页看到正确数据与派生值;
- 同编号重复导入默认跳过、可改覆盖更新或新建副本;
- 材料不存在、必填缺失、日期非法等错误均能在预览中定位且阻断导入;
- 文档已更新、数据已复原、工作树干净。
