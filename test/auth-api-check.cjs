/**
 * 服务端鉴权冒烟(不依赖浏览器):注册首个为管理员 / 登录 / me / 越权 / 数据接口保护。
 * 运行:node test/auth-api-check.cjs(需服务在跑;会创建并清理 alice/bob 测试账号)
 */
'use strict';
const APP = 'http://127.0.0.1:8237/';

async function call(url, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(APP + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j };
}
function assert(cond, msg) { if (!cond) { console.error('✗ ' + msg); process.exit(1); } }

async function main() {
  // admin 默认存在
  const adminLogin = await call('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  assert(adminLogin.status === 200 && adminLogin.json.token, '默认 admin 登录失败');
  const adminToken = adminLogin.json.token;

  // 清理可能残留的测试账号
  for (const u of ['alice', 'bob']) {
    await call('api/users/' + u, 'DELETE', null, adminToken);
  }

  // 0) 非法用户名注册应被拒绝(含 / ? # % 空格或超长;修复:曾可注册含 / 的用户名致无法管理)
  const badU = await call('api/auth/register', 'POST', { username: 'a/b?c', password: '12345678' });
  assert(badU.status === 400, '含斜杠用户名应 400,实得 ' + badU.status);
  const badU2 = await call('api/auth/register', 'POST', { username: 'x y', password: '12345678' });
  assert(badU2.status === 400, '含空格用户名应 400');
  const badU3 = await call('api/auth/register', 'POST', { username: '太'.repeat(40), password: '12345678' });
  assert(badU3.status === 400, '超长用户名应 400');

  // 1) 错误口令 -> 401
  const bad = await call('api/auth/login', 'POST', { username: 'admin', password: 'wrong' });
  assert(bad.status === 401, '错误口令应 401');

  // 2) 注册 alice(首个注册 -> admin)
  const regAlice = await call('api/auth/register', 'POST', { username: 'alice', password: 'alice123', nickname: '小A' });
  assert(regAlice.status === 200 && regAlice.json.user.role === 'admin', '首个注册应为 admin');

  // 3) 注册 bob(第二个 -> user)
  const regBob = await call('api/auth/register', 'POST', { username: 'bob', password: 'bob123456', nickname: '小B' });
  assert(regBob.status === 200 && regBob.json.user.role === 'user', '第二个注册应为 user');

  // 4) me
  const aliceLogin = await call('api/auth/login', 'POST', { username: 'alice', password: 'alice123' });
  const aliceToken = aliceLogin.json.token;
  const me = await call('api/auth/me', 'GET', null, aliceToken);
  assert(me.status === 200 && me.json.user.username === 'alice' && me.json.user.role === 'admin', 'me 失败');

  // 5) 用户列表 admin 可看;bob 不可
  const list = await call('api/users', 'GET', null, aliceToken);
  assert(list.status === 200 && list.json.users.some(u => u.username === 'bob'), 'admin 用户列表失败');
  const bobLogin = await call('api/auth/login', 'POST', { username: 'bob', password: 'bob123456' });
  const bobToken = bobLogin.json.token;
  const denyList = await call('api/users', 'GET', null, bobToken);
  assert(denyList.status === 403, '普通用户访问用户列表应 403');

  // 6) 数据接口保护:未登录 401;登录后 200;reset 需 admin
  const noAuth = await call('api/data', 'GET');
  assert(noAuth.status === 401, '未登录读数据应 401');
  const authed = await call('api/data', 'GET', null, bobToken);
  assert(authed.status === 200 && Array.isArray(authed.json.materials), '登录后读数据应 200');
  const resetByBob = await call('api/reset', 'POST', null, bobToken);
  assert(resetByBob.status === 403, '普通用户 reset 应 403');
  const resetByAdmin = await call('api/reset', 'POST', null, aliceToken);
  assert(resetByAdmin.status === 200, 'admin reset 应 200');

  // 7) 备份导出需登录;导入需 admin
  const exportNoAuth = await call('api/db/export', 'POST');
  assert(exportNoAuth.status === 401, '未登录导出应 401');
  const importByUser = await call('api/db/import', 'POST', { materials: [] });
  const importByUser2 = await call('api/db/import', 'POST', null, bobToken);
  assert(importByUser.status === 401 && importByUser2.status === 403, '导入鉴权异常');
  // 修正导入 body(合法 json)供 admin 验证
  const data = (await call('api/data', 'GET', null, aliceToken)).json;
  const importOk = await call('api/db/import', 'POST', data, aliceToken);
  assert(importOk.status === 200, 'admin 导入应 200');

  // 8) 清理测试账号
  await call('api/users/alice', 'DELETE', null, adminToken);
  await call('api/users/bob', 'DELETE', null, adminToken);
  await call('api/reset', 'POST', null, adminToken);

  console.log('✅ 服务端鉴权冒烟全部通过');
}

main().catch((e) => { console.error('✗ 冒烟失败:', e.message); process.exit(1); });
