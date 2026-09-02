# 砖成本材料预算 · 成本估算系统

本地 Web 版砖类产品材料成本估算工具,依据《砖成本材料预算表_黑白打印版.xlsx》开发,
版式为 **A–L 12 列 Excel 化表格**(主界面默认进入最近估算单的表格)。

## 启动系统

**方式一(推荐,双击即可)**

```
双击 启动.bat
```

会自动启动服务并打开浏览器 `http://127.0.0.1:8237`。
请保持弹出的「砖成本估算服务」窗口开启;关闭它即停止服务。

**方式二(命令行)**

```
cd D:\deepseek-harness\陆创\成本估算系统
node server.js
```

然后用浏览器访问 <http://127.0.0.1:8237>。

**换端口**(默认 8237,被占用时):

```
set PORT=9000
node server.js
# 浏览器访问 http://127.0.0.1:9000
```

## 功能一览

- **材料管理 / 产品配方 / 估算单 / 图表预览 / 历史对比** 五个标签页;
- **Excel 化表格编辑器**:单元格可编辑、公式栏支持 `=引用/SUM/IF/ROUND…` 自定义公式、自动重算、错误与循环检测;
- **单位与规格**:全表数量按**公斤**直乘不换算;表格含**砖长/宽/高**规格行,自动计算砖面积/体积,并自动派生每平方/立方重量、每托重量、计划数与成品率;
- **保存体系**:估算单分「草稿 / 可用表格」;退出编辑时弹窗三选(存草稿 / 不保存 / 存为可用表格);
- **必填引导**:黄色高亮提示必填格,填完自动取消;未填完必填项只能存为草稿;
- **相邻批次校验**:同产品编号的相邻批次(日期、模数)不衔接时弹确认提醒;
- 数据本地持久化于 `data/data.json`,复制该文件即可备份。

## 使用与计算规则

详见同目录 [`使用说明.md`](使用说明.md)。

## 开发与验证

零第三方依赖(Node ≥ 22,内置 fetch/WebSocket):

```bash
node test/calc.test.cjs        # 计算单元测试
node test/formula.test.cjs     # 公式引擎单元测试
node test/sheet.test.cjs       # 表格默认公式一致性
node test/seed-demo.cjs        # 重置演示数据
node test/cdp-test.cjs         # 浏览器主流程
node test/cdp-grid-test.cjs    # 浏览器表格编辑器
node test/cdp-rules-test.cjs   # 必填/草稿/退出弹窗/相邻校验
node test/cdp-crud-test.cjs    # 浏览器 CRUD
node test/cdp-charts-test.cjs  # 浏览器图表
node test/cdp-fix-check.cjs    # 滚动/零异常/图标验证
```
