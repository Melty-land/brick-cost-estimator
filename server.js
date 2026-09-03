/**
 * 砖成本估算系统 —— 本地服务(零第三方依赖)
 * 存储:SQLite(Node 内置 node:sqlite)→ data/brick.db
 * 功能:
 *   - 静态文件服务(public/)
 *   - 数据 API:GET/PUT /api/data(与前端 Store 数据模型完全兼容)
 *   - 备份:B3 在线快照 POST /api/db/backup(VACUUM INTO,轮转保留 30 份)
 *          B2 导出 POST /api/db/export(zip,含业务数据与元信息)
 *          导入 POST /api/db/import(兼容 zip 或 JSON 回灌;导入前自动快照)
 * 迁移:首次启动检测旧 data/data.json 自动导入(原文件保留,不删除)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'brick.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LEGACY_FILE = path.join(DATA_DIR, 'data.json');
const PORT = process.env.PORT || 8237;
const BACKUP_KEEP = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.db': 'application/octet-stream'
};

// ================= SQLite =================
let db = null;

const DDL = `
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT NOT NULL, sort INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT, code TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS product_recipe (
  product_id TEXT NOT NULL, seq INTEGER NOT NULL, material_id TEXT NOT NULL,
  qty_per_pot REAL DEFAULT 0, PRIMARY KEY (product_id, seq)
);
CREATE TABLE IF NOT EXISTS estimates (
  id TEXT PRIMARY KEY, product_id TEXT, name TEXT, code TEXT,
  status TEXT DEFAULT 'draft', author TEXT, start_date TEXT, end_date TEXT,
  pot_bottom REAL DEFAULT 0, pot_top REAL DEFAULT 0,
  calc TEXT, formulas TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS estimate_rows (
  id TEXT PRIMARY KEY, estimate_id TEXT NOT NULL, seq INTEGER NOT NULL,
  material_id TEXT, name TEXT, zone TEXT, qty_per_pot REAL, price REAL,
  stock_on_hand REAL, stock_in REAL, qty REAL
);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, nickname TEXT, role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'active', salt TEXT, hash TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, username TEXT, exp INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_estimate_rows_est ON estimate_rows(estimate_id);
CREATE INDEX IF NOT EXISTS idx_estimates_product ON estimates(product_id);
`;

function openDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(DDL);
  // 兼容旧库:users 表缺 status 列时补充(ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS)
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(function (c) { return c.name; });
  if (userCols.indexOf('status') < 0) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
  }
}

function metaGet(key, def) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : def;
}
function metaSet(key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function nowIso() { return new Date().toISOString(); }

function seedMaterials() {
  const names = [
    ['m1', '黑水泥', '底料'], ['m2', '3-6', '底料'], ['m3', '5-10', '底料'],
    ['m4', '机制砂', '底料'], ['m5', '石粉', '底料'], ['m6', '白水泥', '面料'],
    ['m7', '精白砂', '面料'], ['m8', '金刚黑', '面料'], ['m9', '普砂', '面料'],
    ['m10', '增强剂', '面料'], ['m11', '染料', '面料']
  ];
  const ins = db.prepare('INSERT OR REPLACE INTO materials(id,name,zone,sort,created_at) VALUES(?,?,?,?,?)');
  names.forEach(function (n, i) { ins.run(n[0], n[1], n[2], i + 1, nowIso()); });
  metaSet('seq.material', String(names.length));
}

// ---------- 数据装配(data.json 兼容结构) ----------
function assembleBlob() {
  const materials = db.prepare('SELECT id,name,zone FROM materials ORDER BY sort,rowid').all()
    .map(function (r) { return { id: r.id, name: r.name, zone: r.zone }; });
  const prows = db.prepare('SELECT * FROM products ORDER BY rowid').all();
  const rrows = db.prepare('SELECT * FROM product_recipe ORDER BY seq').all();
  const erows = db.prepare('SELECT * FROM estimates ORDER BY rowid').all();
  const eri = db.prepare('SELECT * FROM estimate_rows ORDER BY seq').all();
  const products = prows.map(function (p) {
    return {
      id: p.id, name: p.name, code: p.code,
      recipe: rrows.filter(function (r) { return r.product_id === p.id; })
        .map(function (r) { return { materialId: r.material_id, qtyPerPot: r.qty_per_pot }; })
    };
  });
  const estimates = erows.map(function (e) {
    let calc = {}, formulas = null;
    try { calc = e.calc ? JSON.parse(e.calc) : {}; } catch (err) { calc = {}; }
    try { formulas = e.formulas ? JSON.parse(e.formulas) : null; } catch (err) { formulas = null; }
    return {
      id: e.id, productId: e.product_id || null, status: e.status || 'draft',
      name: e.name, code: e.code, author: e.author,
      startDate: e.start_date, endDate: e.end_date,
      potBottom: e.pot_bottom, potTop: e.pot_top,
      rows: eri.filter(function (r) { return r.estimate_id === e.id; }).map(function (r) {
        return {
          id: r.id, materialId: r.material_id, name: r.name, zone: r.zone,
          qtyPerPot: r.qty_per_pot, price: r.price,
          stockOnHand: r.stock_on_hand, stockIn: r.stock_in, qty: r.qty
        };
      }),
      calc: calc,
      formulas: formulas
    };
  });
  return {
    materials: materials, products: products, estimates: estimates,
    seq: {
      material: Number(metaGet('seq.material', materials.length)),
      product: Number(metaGet('seq.product', products.length)),
      estimate: Number(metaGet('seq.estimate', estimates.length))
    }
  };
}

// ---------- 数据回灌(把前端 blob 事务性写入数据库) ----------
function ingestBlob(blob) {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DELETE FROM estimate_rows; DELETE FROM estimates; DELETE FROM product_recipe; DELETE FROM products; DELETE FROM materials;');
    const insM = db.prepare('INSERT INTO materials(id,name,zone,sort,created_at) VALUES(?,?,?,?,?)');
    (blob.materials || []).forEach(function (m, i) { insM.run(String(m.id), String(m.name), m.zone === '面料' ? '面料' : '底料', i + 1, nowIso()); });
    const insP = db.prepare('INSERT INTO products(id,name,code,created_at,updated_at) VALUES(?,?,?,?,?)');
    const insR = db.prepare('INSERT INTO product_recipe(product_id,seq,material_id,qty_per_pot) VALUES(?,?,?,?)');
    (blob.products || []).forEach(function (p) {
      insP.run(String(p.id), p.name == null ? '' : String(p.name), p.code == null ? '' : String(p.code), nowIso(), nowIso());
      (p.recipe || []).forEach(function (r, i) {
        insR.run(String(p.id), i, String(r.materialId), Number(r.qtyPerPot) || 0);
      });
    });
    const insE = db.prepare('INSERT INTO estimates(id,product_id,name,code,status,author,start_date,end_date,pot_bottom,pot_top,calc,formulas,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insRw = db.prepare('INSERT INTO estimate_rows(id,estimate_id,seq,material_id,name,zone,qty_per_pot,price,stock_on_hand,stock_in,qty) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    (blob.estimates || []).forEach(function (e) {
      insE.run(
        String(e.id), e.productId == null ? null : String(e.productId),
        e.name == null ? '' : String(e.name), e.code == null ? '' : String(e.code),
        e.status === 'ready' ? 'ready' : 'draft',
        e.author == null ? '' : String(e.author),
        e.startDate == null ? '' : String(e.startDate), e.endDate == null ? '' : String(e.endDate),
        Number(e.potBottom) || 0, Number(e.potTop) || 0,
        JSON.stringify(e.calc || {}), e.formulas ? JSON.stringify(e.formulas) : null,
        nowIso(), nowIso()
      );
      (e.rows || []).forEach(function (r, i) {
        insRw.run(String(r.id), String(e.id), i, r.materialId == null ? null : String(r.materialId),
          r.name == null ? '' : String(r.name), r.zone === '面料' ? '面料' : '底料',
          Number(r.qtyPerPot) || 0, Number(r.price) || 0,
          Number(r.stockOnHand) || 0, Number(r.stockIn) || 0, Number(r.qty) || 0);
      });
    });
    const seq = blob.seq || {};
    metaSet('seq.material', Number(seq.material) || (blob.materials || []).length);
    metaSet('seq.product', Number(seq.product) || (blob.products || []).length);
    metaSet('seq.estimate', Number(seq.estimate) || (blob.estimates || []).length);
    metaSet('schemaVersion', '2');
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

// 首次启动:迁移旧 data.json
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_FILE)) return;
  try {
    if (metaGet('migrated', '0') !== '1') {
      const blob = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      if (blob && Array.isArray(blob.materials) && db.prepare('SELECT COUNT(*) AS c FROM materials').get().c === 0) {
        ingestBlob(blob);
        console.log('已从旧 data/data.json 迁移到 SQLite(data/brick.db),原文件已保留。');
      }
      metaSet('migrated', '1');
    }
  } catch (e) {
    console.error('旧 data.json 迁移失败(已忽略):', e.message);
    metaSet('migrated', '1');
  }
}

function ensureSeed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM materials').get().c === 0) seedMaterials();
}

// ================= 登录 / 用户(users & sessions 表) =================
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function saltHex() { return crypto.randomBytes(16).toString('hex'); }
function userPublic(u) {
  return { username: u.username, nickname: u.nickname, role: u.role, status: u.status || 'active', createdAt: u.created_at };
}
function ensureAdmin() {
  const c = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (c === 0) {
    const salt = saltHex();
    db.prepare('INSERT INTO users(username,nickname,role,salt,hash,created_at) VALUES(?,?,?,?,?,?)')
      .run('admin', '管理员', 'admin', salt, hashPw('admin123', salt), new Date().toISOString());
    console.log('已创建默认账号 admin / admin123(请尽快登录后修改密码)');
  }
}
function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now());
}
function createSession(username) {
  cleanupSessions();
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,username,exp) VALUES(?,?,?)').run(token, username, Date.now() + TOKEN_TTL);
  return token;
}
function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers['authorization'] || ''));
  return m ? m[1] : null;
}
function authUser(req) {
  const token = bearerOf(req);
  if (!token) return null;
  const s = db.prepare('SELECT username,exp FROM sessions WHERE token=?').get(token);
  if (!s || s.exp < Date.now()) {
    if (s) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(s.username);
  if (!u) return null;
  // 账号被停用:立即失效(含已签发 token)
  if (u.status === 'disabled') {
    db.prepare('DELETE FROM sessions WHERE username=?').run(u.username);
    return null;
  }
  return userPublic(u);
}
function requireAuth(req, res) {
  const u = authUser(req);
  if (!u) { sendJson(res, 401, { ok: false, error: '未登录或会话已过期' }); return null; }
  return u;
}
function requireAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.role !== 'admin') { sendJson(res, 403, { ok: false, error: '仅管理员可执行此操作' }); return null; }
  return u;
}

// ================= ZIP(最小实现:store + deflate) =================
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function dosDateTime() {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}
function buildZip(entries) {
  // entries: [{name, data(Buffer)}]
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 标记
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const centralSize = central.reduce(function (s, b) { return s + b.length; }, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(chunks.concat(central, [eocd]));
}
function parseZip(buf) {
  const out = {};
  if (!buf || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let i = buf.length - 22;
  while (i > 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (buf.readUInt32LE(i) !== 0x06054b50) return null;
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const method = buf.readUInt16LE(localOff + 8);
    const compSize = buf.readUInt32LE(localOff + 18);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ================= 备份(B3 / B2) =================
function quoteSql(str) { return "'" + String(str).replace(/'/g, "''") + "'"; }
function takeSnapshot() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  let file = path.join(BACKUP_DIR, 'brick-' + base + '.db');
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(BACKUP_DIR, 'brick-' + base + '-' + n + '.db');
    n++;
  }
  db.exec('VACUUM INTO ' + quoteSql(file));
  // 轮转:保留最近 BACKUP_KEEP 份
  const list = fs.readdirSync(BACKUP_DIR).filter(function (f) { return /^brick-.*\.db$/.test(f); }).sort().reverse();
  list.slice(BACKUP_KEEP).forEach(function (f) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) { /* ignore */ }
  });
  return file;
}

// ================= HTTP =================
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); if (chunks.reduce(function (s, x) { return s + x.length; }, 0) > 200 * 1024 * 1024) req.destroy(); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function parseJsonBody(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { throw new Error('请求体不是合法 JSON'); }
}
function serveStatic(req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch (e) { p = urlPath; }
  if (p === '/' || p === '\\' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(file, function (err, buf) {
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

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname;
  try {
    // ---- 认证:注册 / 登录 / 会话 ----
    if (p === '/api/auth/register' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username) { sendJson(res, 400, { ok: false, error: '用户名不能为空' }); return; }
      if (password.length < 6) { sendJson(res, 400, { ok: false, error: '密码至少 6 位' }); return; }
      const exist = db.prepare('SELECT COUNT(*) AS c FROM users WHERE username=?').get(username).c;
      if (exist) { sendJson(res, 409, { ok: false, error: '用户名已存在' }); return; }
      // 开放注册·首个为管理员:当仅剩内置 admin 时,第一个注册账号成为管理员
      const otherCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE username<>?').get('admin').c;
      const role = otherCount === 0 ? 'admin' : 'user';
      const salt = saltHex();
      db.prepare('INSERT INTO users(username,nickname,role,salt,hash,created_at) VALUES(?,?,?,?,?,?)')
        .run(username, String(body.nickname || username).slice(0, 30), role, salt, hashPw(password, salt), new Date().toISOString());
      sendJson(res, 200, { ok: true, user: userPublic(db.prepare('SELECT * FROM users WHERE username=?').get(username)) });
      return;
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const username = String(body.username || '').trim();
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!u || u.hash !== hashPw(body.password || '', u.salt)) {
        sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
        return;
      }
      if (u.status && u.status === 'disabled') { sendJson(res, 403, { ok: false, error: '账号已停用' }); return; }
      const token = createSession(u.username);
      sendJson(res, 200, { ok: true, token: token, user: userPublic(u) });
      return;
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = requireAuth(req, res);
      if (u) sendJson(res, 200, { ok: true, user: u });
      return;
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const token = bearerOf(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === '/api/auth/password' && req.method === 'PUT') {
      const u = requireAuth(req, res);
      if (!u) return;
      const body = await parseJsonBody(req);
      const rec = db.prepare('SELECT * FROM users WHERE username=?').get(u.username);
      if (!rec || rec.hash !== hashPw(body.oldPassword || '', rec.salt)) {
        sendJson(res, 400, { ok: false, error: '旧密码错误' });
        return;
      }
      if (String(body.newPassword || '').length < 6) { sendJson(res, 400, { ok: false, error: '新密码至少 6 位' }); return; }
      const salt = saltHex();
      db.prepare('UPDATE users SET salt=?,hash=? WHERE username=?').run(salt, hashPw(body.newPassword, salt), u.username);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- 用户管理(admin) ----
    if (p === '/api/users' || /^\/api\/users\/[^/]+$/.test(p)) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const m = /^\/api\/users\/([^/]+)$/.exec(p);
      const name = m ? decodeURIComponent(m[1]) : null;
      if (p === '/api/users' && req.method === 'GET') {
        const users = db.prepare('SELECT username,nickname,role,created_at FROM users ORDER BY created_at').all().map(userPublic);
        sendJson(res, 200, { ok: true, users: users });
        return;
      }
      if (p === '/api/users' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const username = String(body.username || '').trim();
        if (!username) { sendJson(res, 400, { ok: false, error: '用户名不能为空' }); return; }
        if (db.prepare('SELECT COUNT(*) AS c FROM users WHERE username=?').get(username).c) {
          sendJson(res, 409, { ok: false, error: '用户名已存在' }); return;
        }
        if (!body.password || String(body.password).length < 6) { sendJson(res, 400, { ok: false, error: '密码至少 6 位' }); return; }
        const salt = saltHex();
        db.prepare('INSERT INTO users(username,nickname,role,salt,hash,created_at) VALUES(?,?,?,?,?,?)')
          .run(username, String(body.nickname || username).slice(0, 30), body.role === 'admin' ? 'admin' : 'user', salt, hashPw(body.password, salt), new Date().toISOString());
        sendJson(res, 200, { ok: true });
        return;
      }
      if (m && req.method === 'PUT') {
        const body = await parseJsonBody(req);
        const rec = db.prepare('SELECT * FROM users WHERE username=?').get(name);
        if (!rec) { sendJson(res, 404, { ok: false, error: '用户不存在' }); return; }
        if (name === admin.username && body.role === 'user') { sendJson(res, 400, { ok: false, error: '不能把自己降为普通用户' }); return; }
        const nickname = body.nickname !== undefined ? String(body.nickname || name).slice(0, 30) : rec.nickname;
        const role = (body.role === 'admin' || body.role === 'user') ? body.role : rec.role;
        const status = (body.status === 'active' || body.status === 'disabled') ? body.status : (rec.status || 'active');
        if (body.password && String(body.password).length >= 6) {
          const salt = saltHex();
          db.prepare('UPDATE users SET nickname=?,role=?,status=?,salt=?,hash=? WHERE username=?')
            .run(nickname, role, status, salt, hashPw(body.password, salt), name);
        } else {
          db.prepare('UPDATE users SET nickname=?,role=?,status=? WHERE username=?').run(nickname, role, status, name);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (m && req.method === 'DELETE') {
        const rec = db.prepare('SELECT * FROM users WHERE username=?').get(name);
        if (!rec) { sendJson(res, 404, { ok: false, error: '用户不存在' }); return; }
        if (name === admin.username) { sendJson(res, 400, { ok: false, error: '不能删除自己' }); return; }
        if (rec.role === 'admin') {
          const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
          if (adminCount <= 1) { sendJson(res, 400, { ok: false, error: '至少保留一名管理员' }); return; }
        }
        db.prepare('DELETE FROM users WHERE username=?').run(name);
        db.prepare('DELETE FROM sessions WHERE username=?').run(name);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // ---- 数据 API(与前端 Store 兼容;全站需登录) ----
    if (p === '/api/data') {
      if (req.method === 'GET') {
        if (!requireAuth(req, res)) return;
        sendJson(res, 200, assembleBlob());
        return;
      }
      if (req.method === 'PUT') {
        if (!requireAuth(req, res)) return;
        const raw = await readBody(req);
        let blob;
        try { blob = JSON.parse(raw.toString('utf8')); } catch (e) { sendJson(res, 400, { ok: false, error: '数据结构不合法' }); return; }
        if (!blob || typeof blob !== 'object' || !Array.isArray(blob.materials)) {
          sendJson(res, 400, { ok: false, error: '数据结构不合法' });
          return;
        }
        ingestBlob(blob);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (p === '/api/reset' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec('DELETE FROM estimate_rows; DELETE FROM estimates; DELETE FROM product_recipe; DELETE FROM products; DELETE FROM materials;');
        seedMaterials();
        metaSet('seq.product', '0');
        metaSet('seq.estimate', '0');
        db.exec('COMMIT;');
      } catch (e) { db.exec('ROLLBACK;'); throw e; } finally { db.exec('PRAGMA foreign_keys=ON;'); }
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- 备份:在线快照(B3;需登录) ----
    if (p === '/api/db/backup' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const file = takeSnapshot();
      sendJson(res, 200, { ok: true, file: path.basename(file) });
      return;
    }
    // ---- 备份:导出 zip(B2;需登录) ----
    if (p === '/api/db/export' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const zip = buildZip([
        { name: 'brick-data.json', data: Buffer.from(JSON.stringify(assembleBlob(), null, 2), 'utf8') },
        { name: 'brick-meta.json', data: Buffer.from(JSON.stringify({ app: 'brick-cost', version: 2, exportedAt: new Date().toISOString() }, null, 2), 'utf8') }
      ]);
      const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="brick-data-' + ts + '.zip"'
      });
      res.end(zip);
      return;
    }
    // ---- 备份:导入(B2,需 admin;导入前自动快照) ----
    if (p === '/api/db/import' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const raw = await readBody(req);
      let blob = null;
      if (raw.length > 2 && raw[0] === 0x50 && raw[1] === 0x4b) {
        const entries = parseZip(raw);
        const dataEntry = entries && (entries['brick-data.json'] || entries['data.json']);
        if (dataEntry) { try { blob = JSON.parse(dataEntry.toString('utf8')); } catch (e) { blob = null; } }
        if (!blob) { sendJson(res, 400, { ok: false, error: 'zip 中未找到有效的 brick-data.json' }); return; }
      } else {
        try { blob = JSON.parse(raw.toString('utf8')); } catch (e) { sendJson(res, 400, { ok: false, error: '导入内容不是合法 JSON/zip' }); return; }
      }
      if (!blob || !Array.isArray(blob.materials)) { sendJson(res, 400, { ok: false, error: '导入数据结构不合法' }); return; }
      takeSnapshot(); // 导入前先自动备份当前数据
      ingestBlob(blob);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- 静态资源 ----
    serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// ================= 启动 =================
openDb();
migrateLegacy();
ensureSeed();
ensureAdmin();
server.listen(PORT, function () {
  console.log('==============================================');
  console.log('  砖成本材料预算 · 成本估算系统(SQLite 版)');
  console.log('  请用浏览器打开: http://127.0.0.1:' + PORT);
  console.log('  数据库文件: ' + DB_FILE);
  console.log('  备份目录: ' + BACKUP_DIR);
  console.log('==============================================');
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用,请关闭占用程序或用 PORT=其他端口 重新启动。');
    process.exit(1);
  }
  console.error('服务启动失败:', e);
});
