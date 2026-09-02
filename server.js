/**
 * 砖成本估算系统 —— 本地服务(零第三方依赖,仅用 Node 内置模块)
 *
 * 启动:node server.js  (默认端口 8237,可用环境变量 PORT 覆盖)
 * 功能:静态文件服务(public/) + 数据读写 API(/api/data)
 * 数据:data/data.json(首次启动自动生成并写入 11 种种子材料)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PORT = process.env.PORT || 8237;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** 初始数据:11 种种子材料(底料 5 种、面料 6 种,与原表一致) */
function seedData() {
  return {
    materials: [
      { id: 'm1', name: '黑水泥', zone: '底料' },
      { id: 'm2', name: '3-6', zone: '底料' },
      { id: 'm3', name: '5-10', zone: '底料' },
      { id: 'm4', name: '机制砂', zone: '底料' },
      { id: 'm5', name: '石粉', zone: '底料' },
      { id: 'm6', name: '白水泥', zone: '面料' },
      { id: 'm7', name: '精白砂', zone: '面料' },
      { id: 'm8', name: '金刚黑', zone: '面料' },
      { id: 'm9', name: '普砂', zone: '面料' },
      { id: 'm10', name: '增强剂', zone: '面料' },
      { id: 'm11', name: '染料', zone: '面料' }
    ],
    products: [],
    estimates: [],
    seq: { material: 11, product: 0, estimate: 0 }
  };
}

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedData(), null, 2), 'utf8');
    console.log('已初始化数据文件:' + DATA_FILE);
  }
}

function readData() {
  ensureData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(obj) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch (e) {
    p = urlPath;
  }
  if (p === '/' || p === '\\' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname;

  // ---- 数据 API ----
  if (p === '/api/data') {
    if (req.method === 'GET') {
      sendJson(res, 200, readData());
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 100 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const obj = JSON.parse(body);
          if (!obj || typeof obj !== 'object' || !Array.isArray(obj.materials)) {
            sendJson(res, 400, { ok: false, error: '数据结构不合法' });
            return;
          }
          writeData(obj);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e.message || e) });
        }
      });
      return;
    }
  }

  // ---- 恢复初始种子数据(仅材料) ----
  if (p === '/api/reset' && req.method === 'POST') {
    writeData(seedData());
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 静态资源 ----
  serveStatic(req, res, p);
});

ensureData();
server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  砖成本材料预算 · 成本估算系统');
  console.log('  请用浏览器打开: http://127.0.0.1:' + PORT);
  console.log('  数据文件: ' + DATA_FILE);
  console.log('==============================================');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用,请关闭占用程序或用 PORT=其他端口 重新启动。');
    process.exit(1);
  }
  console.error('服务启动失败:', e);
});
