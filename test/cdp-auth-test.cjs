/**
 * CDP 浏览器登录/注册/用户管理测试:
 *  1) 未登录打开 -> 显示登录层,主内容不可用
 *  2) 错误口令 -> 提示错误、停留在登录层
 *  3) 注册首个账号(除内置 admin 外) -> 自动成为管理员
 *  4) 新管理员登录 -> 主界面进入,用户管理标签可见
 *  5) 用户管理:admin 新增普通用户 / 删除普通用户
 *  6) 普通用户登录 -> 用户管理标签隐藏,访问 #users 被拒并重定向
 *  7) 登出 -> 回到登录层
 * 运行:node test/cdp-auth-test.cjs(需服务在跑;会创建并清理 t_admin/t_user 测试账号,并复位演示数据)
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = require('./find-edge.cjs');
if (!EDGE) { console.error('✗ 未找到 Microsoft Edge(可设环境变量 EDGE_PATH 指定路径)'); process.exit(1); }
const CDP_PORT = 9262;
const PROFILE = path.join(os.tmpdir(), 'dsh-cdp-' + CDP_PORT);
const APP = 'http://127.0.0.1:8237/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_USERS = ['t_admin', 't_user'];

async function api(url, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(APP + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j };
}

async function main() {
  // ---- 预清理:登录 admin,删除可能残留的测试账号,复位演示数据 ----
  const adminLogin = await api('api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  if (adminLogin.status !== 200) { console.error('✗ 预清理:admin 登录失败'); process.exit(1); }
  const adminToken = adminLogin.json.token;
  for (const u of TEST_USERS) await api('api/users/' + u, 'DELETE', null, adminToken);
  await api('api/reset', 'POST', null, adminToken);
  await (await import('child_process')).execSync('node ' + JSON.stringify(path.join(__dirname, 'seed-demo.cjs')), { stdio: 'inherit' });

  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, APP
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('8237'));
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* not ready */ }
  }
  if (!wsUrl) { console.error('✗ 无法连接 CDP'); child.kill(); process.exit(1); }
  console.log('✓ CDP 已连接');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await cdp('Runtime.enable', {});
  function cdp(method, params) {
    return new Promise((res) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evalJS(expression) {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails.text));
    return r.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, tries = 50) {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      if (await evalJS(expr)) return true;
    }
    return false;
  }
  const setInput = async (sel, value) => {
    await evalJS(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
  };
  const authVisible = () => evalJS(`(() => {
    const s = document.getElementById('auth-screen');
    return !!(s && getComputedStyle(s).display !== 'none');
  })()`);
  const clickSubmit = () => evalJS(`(() => {
    const b = document.querySelector('#auth-submit');
    b.click();
    return 'ok';
  })()`);

  // ---- 1. 未登录:登录层可见,主视图被遮 ----
  const shown = await waitFor(`(() => {
    const s = document.getElementById('auth-screen');
    return s && getComputedStyle(s).display !== 'none' && document.querySelector('#auth-username');
  })()`);
  if (!shown) { console.error('✗ 未登录时应显示登录层'); process.exit(1); }
  const mainHidden = await evalJS(`(() => {
    const v = document.getElementById('view-materials');
    return v ? v.hidden : true;
  })()`);
  console.log('✓ 未登录打开:登录层显示(主视图隐藏=' + mainHidden + ')');

  // ---- 2. 错误口令 ----
  await setInput('#auth-username', 'admin');
  await setInput('#auth-password', 'wrong-pass');
  await clickSubmit();
  const badMsg = await waitFor(`(() => {
    const m = document.getElementById('auth-msg');
    return m && m.textContent && m.textContent.length > 0;
  })()`);
  if (!badMsg) { console.error('✗ 错误口令应提示'); process.exit(1); }
  const stillLogin = await authVisible();
  if (!stillLogin) { console.error('✗ 错误口令后应停留在登录层'); process.exit(1); }
  console.log('✓ 错误口令:提示「' + (await evalJS(`document.getElementById('auth-msg').textContent`)) + '」并停留登录层');

  // ---- 3. 切换到注册 ----
  await evalJS(`document.querySelector('#auth-toggle').click()`);
  await sleep(200);
  const regMode = await evalJS(`(() => ({
    submit: document.getElementById('auth-submit').textContent,
    nickWrap: !document.getElementById('auth-nickname-wrap').hidden
  }))()`);
  if (regMode.submit !== '注 册' || !regMode.nickWrap) {
    console.error('✗ 注册模式切换失败: ' + JSON.stringify(regMode)); process.exit(1);
  }
  console.log('✓ 切换到注册模式');

  // 注册首个账号 t_admin(此时 users 仅内置 admin -> 自动为管理员)
  await setInput('#auth-username', 't_admin');
  await setInput('#auth-nickname', '测试管理员');
  await setInput('#auth-password', 'tadmin123');
  await clickSubmit();
  const regMsg = await waitFor(`(() => {
    const m = document.getElementById('auth-msg');
    return m && m.textContent.indexOf('注册成功') >= 0;
  })()`);
  if (!regMsg) { console.error('✗ 注册未成功: ' + (await evalJS(`document.getElementById('auth-msg').textContent`))); process.exit(1); }
  const regText = await evalJS(`document.getElementById('auth-msg').textContent`);
  if (regText.indexOf('已设为管理员') < 0) { console.error('✗ 首个注册应为管理员: ' + regText); process.exit(1); }
  console.log('✓ 注册首个账号 t_admin:提示「' + regText + '」');

  // ---- 4. t_admin 登录 -> 主界面,用户管理标签可见 ----
  await setInput('#auth-username', 't_admin');
  await setInput('#auth-password', 'tadmin123');
  await clickSubmit();
  const entered = await waitFor(`(() => {
    const s = document.getElementById('auth-screen');
    return s && getComputedStyle(s).display === 'none' &&
      (location.hash.startsWith('#estimate/') || location.hash === '#estimates' || location.hash === '#materials');
  })()`);
  if (!entered) { console.error('✗ 管理员登录后未进入主界面:' + (await evalJS('location.hash'))); process.exit(1); }
  const badge = await evalJS(`document.getElementById('user-badge').textContent`);
  const tabUsersVisible = await evalJS(`!document.getElementById('tab-users').hidden`);
  if (badge.indexOf('管理员') < 0 || !tabUsersVisible) {
    console.error('✗ 管理员标识或用户管理标签异常: badge=' + badge + ' tab=' + tabUsersVisible); process.exit(1);
  }
  console.log('✓ 管理员 t_admin 登录成功:' + badge + ',用户管理标签可见');

  // ---- 5. 用户管理:新增普通用户 t_user / 删除 ----
  await evalJS(`location.hash = '#users'`);
  const usersRendered = await waitFor(`(() => {
    const v = document.getElementById('view-users');
    return v && !v.hidden && document.querySelectorAll('#view-users tbody tr').length >= 2;
  })()`);
  if (!usersRendered) { console.error('✗ 用户管理页未渲染'); process.exit(1); }
  console.log('✓ 用户管理页打开(至少含 admin 与 t_admin 两行)');

  await setInput('#new-user-name', 't_user');
  await setInput('#new-user-nick', '测试普通用户');
  await setInput('#new-user-pw', 'tuser12345');
  await evalJS(`document.querySelector('[data-action="users-add"]').click()`);
  const added = await waitFor(`(() => {
    const rows = Array.from(document.querySelectorAll('#view-users tbody tr'));
    return rows.some(r => r.textContent.includes('t_user') && r.textContent.includes('普通用户'));
  })()`);
  if (!added) { console.error('✗ 新增普通用户未出现在列表'); process.exit(1); }
  console.log('✓ admin 新增普通用户 t_user 成功并显示在列表');

  // 删除用户走原生 confirm,无头模式下自动确认
  await evalJS(`window.confirm = function () { return true; }`);
  await evalJS(`(() => {
    const b = document.querySelector('[data-action="users-del"][data-username="t_user"]');
    if (b) b.click();
  })()`);
  const deleted = await waitFor(`(() => {
    const rows = Array.from(document.querySelectorAll('#view-users tbody tr'));
    return !rows.some(r => r.textContent.includes('t_user'));
  })()`);
  if (!deleted) { console.error('✗ 删除 t_user 失败'); process.exit(1); }
  console.log('✓ 删除普通用户 t_user 成功');

  // ---- 6. 登出 ----
  await evalJS(`document.querySelector('#btn-logout').click()`);
  const backToLogin = await waitFor(`(() => {
    const s = document.getElementById('auth-screen');
    return s && getComputedStyle(s).display !== 'none';
  })()`);
  if (!backToLogin) { console.error('✗ 登出后未回到登录层'); process.exit(1); }
  console.log('✓ 登出后回到登录层');

  // ---- 7. 服务端直接建一个普通用户,走登录;验证其无用户管理权限 ----
  await api('api/users', 'POST', { username: 't_user', password: 'tuser12345', nickname: '测试普通用户', role: 'user' }, adminToken);
  await setInput('#auth-username', 't_user');
  await setInput('#auth-password', 'tuser12345');
  await clickSubmit();
  const enteredUser = await waitFor(`(() => {
    const s = document.getElementById('auth-screen');
    return s && getComputedStyle(s).display === 'none' &&
      (location.hash.startsWith('#estimate/') || location.hash === '#estimates' || location.hash === '#materials');
  })()`);
  if (!enteredUser) { console.error('✗ 普通用户登录失败:' + (await evalJS('location.hash'))); process.exit(1); }
  const badge2 = await evalJS(`document.getElementById('user-badge').textContent`);
  const tabUsersHidden = await evalJS(`document.getElementById('tab-users').hidden`);
  if (badge2.indexOf('普通用户') < 0 || !tabUsersHidden) {
    console.error('✗ 普通用户标识异常: badge=' + badge2 + ' tabHidden=' + tabUsersHidden); process.exit(1);
  }
  console.log('✓ 普通用户 t_user 登录:标识「' + badge2 + '」,用户管理标签隐藏');

  // 直接访问 #users 应被拒并重定向到估算单页
  await evalJS(`location.hash = '#users'`);
  await sleep(500);
  const denied = await evalJS(`(() => ({
    hash: location.hash,
    usersHidden: document.getElementById('view-users').hidden
  }))()`);
  if (denied.hash !== '#estimates' || !denied.usersHidden) {
    console.error('✗ 普通用户访问 #users 未被拒绝: ' + JSON.stringify(denied)); process.exit(1);
  }
  console.log('✓ 普通用户访问 #users 被拒并重定向到 #estimates');

  // ---- 8. 清理测试账号并复位数据 ----
  for (const u of TEST_USERS) await api('api/users/' + u, 'DELETE', null, adminToken);
  await api('api/reset', 'POST', null, adminToken);
  await (await import('child_process')).execSync('node ' + JSON.stringify(path.join(__dirname, 'seed-demo.cjs')), { stdio: 'inherit' });

  if (pageErrors.length) { console.error('✗ 页面出现异常: ' + JSON.stringify(pageErrors)); process.exit(1); }
  console.log('\n✅ 全部登录/注册/用户管理浏览器测试通过(页面异常:无)');
  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
