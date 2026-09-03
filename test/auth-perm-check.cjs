/**
 * 权限逻辑扩展验证(第 5 项):
 *  - users PUT(改角色 / 重置密码 / 停用)应正常返回 200(此前缺 status 列会 500)
 *  - 停用账号后,其已签发 token 立即失效(401)
 *  - 停用账号无法登录(403)
 *  - 管理员不可删自己 / 至少保留一名 admin
 * 运行:node test/auth-perm-check.cjs(需服务在跑;会创建并清理 t_perm 账号)
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
  const adminLogin = await call('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  assert(adminLogin.status === 200, 'admin 登录失败');
  const adminToken = adminLogin.json.token;
  await call('api/users/t_perm', 'DELETE', null, adminToken);
  // 清残留备用 admin:先恢复启用再删,避免"至少保留一名启用中 admin"拦截
  await call('api/users/t_admin2', 'PUT', { status: 'active' }, adminToken);
  await call('api/users/t_admin2', 'DELETE', null, adminToken);

  // 1) admin 新增普通用户 t_perm
  const add = await call('api/users', 'POST', { username: 't_perm', password: 'tperm123', nickname: '权限测试', role: 'user' }, adminToken);
  assert(add.status === 200, 'admin 新增用户失败 ' + add.status);

  // 2) users PUT 改角色(此前因缺 status 列返回 500,现已修复)
  const upRole = await call('api/users/t_perm', 'PUT', { role: 'user', nickname: '权限测试' }, adminToken);
  assert(upRole.status === 200, 'PUT 改角色失败 ' + upRole.status + ' ' + JSON.stringify(upRole.json));

  // 3) users PUT 重置密码
  const upPw = await call('api/users/t_perm', 'PUT', { password: 'tperm456' }, adminToken);
  assert(upPw.status === 200, 'PUT 重置密码失败 ' + upPw.status);

  // 4) 用新密码登录 -> 成功;旧密码 -> 失败
  const loginNew = await call('api/auth/login', 'POST', { username: 't_perm', password: 'tperm456' });
  assert(loginNew.status === 200, '重置后新密码应可登录');
  const tToken = loginNew.json.token;
  const loginOld = await call('api/auth/login', 'POST', { username: 't_perm', password: 'tperm123' });
  assert(loginOld.status === 401, '旧密码应 401');

  // 5) me(token 有效)
  const me = await call('api/auth/me', 'GET', null, tToken);
  assert(me.status === 200, 't_perm 的 token 应有效');

  // 6) admin 停用 t_perm -> 其已签发 token 立即失效(401)
  const disable = await call('api/users/t_perm', 'PUT', { status: 'disabled' }, adminToken);
  assert(disable.status === 200, 'PUT 停用失败 ' + disable.status);
  const meAfter = await call('api/auth/me', 'GET', null, tToken);
  assert(meAfter.status === 401, '停用后已签发 token 应立即失效,实得 ' + meAfter.status);

  // 7) 停用账号登录被拒(403)
  const loginDis = await call('api/auth/login', 'POST', { username: 't_perm', password: 'tperm456' });
  assert(loginDis.status === 403, '停用账号登录应 403');

  // 8) 重新启用后可登录
  const enable = await call('api/users/t_perm', 'PUT', { status: 'active' }, adminToken);
  assert(enable.status === 200, 'PUT 启用失败');
  const loginEn = await call('api/auth/login', 'POST', { username: 't_perm', password: 'tperm456' });
  assert(loginEn.status === 200, '启用后应可登录');

  // 9) admin 不能删自己
  const delSelf = await call('api/users/admin', 'DELETE', null, adminToken);
  assert(delSelf.status === 400, '删除自己应 400');

  // 10) 普通用户访问用户管理 -> 403;访问 reset -> 403
  const tToken2 = loginEn.json.token;
  const listByUser = await call('api/users', 'GET', null, tToken2);
  assert(listByUser.status === 403, '普通用户列用户应 403');
  const resetByUser = await call('api/reset', 'POST', null, tToken2);
  assert(resetByUser.status === 403, '普通用户 reset 应 403');
  const delByUser = await call('api/users/admin', 'DELETE', null, tToken2);
  assert(delByUser.status === 403, '普通用户删除 admin 应 403');

  // 11) admin 把自己降为普通用户 -> 400
  const demoteSelf = await call('api/users/admin', 'PUT', { role: 'user' }, adminToken);
  assert(demoteSelf.status === 400, '自我降级应 400');

  // 12) admin 停用自己 -> 400(防止管理员把自己锁死)
  const disableSelf = await call('api/users/admin', 'PUT', { status: 'disabled' }, adminToken);
  assert(disableSelf.status === 400, '自停用应 400');

  // 13) 唯一启用中的管理员被停用/降级 -> 400(此时仅 admin 启用,t_perm 是 user)
  const disableLone = await call('api/users/admin', 'PUT', { status: 'disabled', role: 'admin' }, adminToken);
  assert(disableLone.status === 400, '停用唯一启用管理员应 400');

  // 14) 另一个启用 admin 存在时,可停用其中之一(admin 停用 t_admin2)
  const addA2 = await call('api/users', 'POST', { username: 't_admin2', password: 'ta212345', nickname: '备用管理员', role: 'admin' }, adminToken);
  assert(addA2.status === 200, '新增备用 admin 失败 ' + addA2.status + ' ' + JSON.stringify(addA2.json));
  const disableOther = await call('api/users/t_admin2', 'PUT', { status: 'disabled' }, adminToken);
  assert(disableOther.status === 200, '存在两个启用 admin 时停用其一应 200,实得 ' + disableOther.status + ' ' + JSON.stringify(disableOther.json));
  // 恢复并清理备用;同时验证 t_admin2(已停用)的登录被拒
  const loginD2 = await call('api/auth/login', 'POST', { username: 't_admin2', password: 'ta212345' });
  assert(loginD2.status === 403, '已停用 admin 登录应 403');
  await call('api/users/t_admin2', 'PUT', { status: 'active' }, adminToken);
  await call('api/users/t_admin2', 'DELETE', null, adminToken); // 清理备用

  // 清理
  await call('api/users/t_perm', 'DELETE', null, adminToken);
  console.log('✅ 权限逻辑扩展验证全部通过(PUT 角色/密码/停用生效、停用即踢下线、自停用/最后admin保护正确)');
}

main().catch((e) => { console.error('✗ 权限验证失败:', e.message); process.exit(1); });
