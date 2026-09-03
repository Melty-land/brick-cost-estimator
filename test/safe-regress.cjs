/**
 * 安全回归包装:先备份当前(用户)数据 -> 跑演示数据测试 -> 恢复用户数据。
 * 用法: node test/safe-regress.cjs "<命令1>;<命令2>;..."
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API = 'http://127.0.0.1:8237/';
const TMP = path.join(__dirname, '..', 'data', '.userdata-cache.json');

async function api(pathname, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

async function main() {
  const cmds = process.argv[2];
  if (!cmds) { console.error('缺少要执行的命令'); process.exit(2); }
  const login = await api('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  if (login.status !== 200) { console.error('admin 登录失败'); process.exit(1); }
  const token = login.json.token;

  // 1) 备份当前数据
  const cur = (await api('api/data', 'GET', null, token)).json;
  fs.writeFileSync(TMP, JSON.stringify(cur), 'utf8');
  const hasUserData = cur.estimates.some(e => String(e.id).startsWith('estimate')) &&
    cur.materials.length > 11;
  console.log('✓ 已备份当前数据(用户真实单存在: ' + hasUserData + ') -> ' + TMP);

  // 2) 重置为演示数据并执行命令
  execSync('node ' + JSON.stringify(path.join(__dirname, 'seed-demo.cjs')), { stdio: 'inherit' });
  const parts = cmds.split(';').map(s => s.trim()).filter(Boolean);
  for (const cmd of parts) {
    console.log('>>> ' + cmd);
    execSync(cmd, { stdio: 'inherit', shell: true });
  }

  // 3) 恢复用户数据(若执行前存在用户数据);失败自动重试(服务偶发不可达)
  if (hasUserData) {
    let put = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        put = await api('api/data', 'PUT', cur, token);
        if (put.status === 200) break;
      } catch (e) { put = { status: 'ERR ' + e.message }; }
      console.log('  ↻ 恢复重试 ' + attempt + '/5 ...');
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log('✓ 已恢复用户数据:' + (put && put.status === 200 ? 'PUT ok' : JSON.stringify(put)));
  }
}

main().catch(e => { console.error('✗ 回归包装失败:', e.message); process.exit(1); });
