/**
 * 自动探测本机 Microsoft Edge 可执行文件路径(供 CDP 无头浏览器测试使用)。
 * 候选顺序:环境变量 EDGE_PATH(手动指定,优先级最高)
 *          → 标准 64 位安装位置 → 标准 32 位(x86)安装位置。
 * 全部不存在时返回 null,由调用方给出明确报错。
 * 零第三方依赖,仅 Node 内置模块。
 */
'use strict';
const fs = require('fs');
const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

function findEdge() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 跳过不可读候选 */ }
  }
  return null;
}

module.exports = findEdge();
