/**
 * 备份 API 验证:导出 zip → 修改数据 → 导入 zip 恢复 → 校验。
 * 运行:node test/db-backup-check.cjs(依赖服务在跑;需 admin 登录)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = 'http://127.0.0.1:8237/';

async function main() {
  // 0) admin 登录,后续请求统一带 token
  const login = await fetch(APP + 'api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  if (!login.ok) throw new Error('admin 登录失败: ' + login.status);
  const token = (await login.json()).token;
  const auth = { 'Authorization': 'Bearer ' + token };

  // 1) 导出 zip
  const exp = await fetch(APP + 'api/db/export', { method: 'POST', headers: auth });
  if (!exp.ok) throw new Error('export HTTP ' + exp.status);
  const zipBuf = Buffer.from(await exp.arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'brick-export-test.zip');
  fs.writeFileSync(tmp, zipBuf);
  console.log('✓ 导出 zip 成功,大小=' + zipBuf.length + 'B');

  // 2) 记录当前数据快照(用于回灌后对比)
  const before = await (await fetch(APP + 'api/data', { headers: auth })).json();

  // 3) 制造一条数据变更并 PUT(模拟用户新增估算单)
  const modified = JSON.parse(JSON.stringify(before));
  modified.materials.push({ id: 'mTEST', name: '测试水泥', zone: '底料' });
  modified.seq.material = modified.materials.length;
  const put = await fetch(APP + 'api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(modified)
  });
  if (!put.ok) throw new Error('PUT HTTP ' + put.status);
  const afterPut = await (await fetch(APP + 'api/data', { headers: auth })).json();
  if (afterPut.materials.length !== before.materials.length + 1) throw new Error('PUT 未生效');
  console.log('✓ 数据已变更(新增 1 个材料),materials=' + afterPut.materials.length);

  // 4) 用导出的 zip 导入恢复
  const imp = await fetch(APP + 'api/db/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', ...auth },
    body: zipBuf
  });
  const impJson = await imp.json();
  if (!impJson.ok) throw new Error('import 失败: ' + impJson.error);
  console.log('✓ 导入 zip 成功(导入前已自动快照)');

  // 5) 校验数据恢复为导出时状态
  const after = await (await fetch(APP + 'api/data', { headers: auth })).json();
  if (after.materials.length !== before.materials.length) throw new Error('导入后材料数不符');
  const hasTest = after.materials.some((m) => m.id === 'mTEST');
  if (hasTest) throw new Error('导入后仍残留测试数据');
  if (after.estimates.length !== before.estimates.length) throw new Error('导入后估算单数不符');
  console.log('✓ 导入后数据与导出一致(测试数据已清除)');

  // 6) 直接 JSON 回灌导入路径
  const imp2 = await fetch(APP + 'api/db/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(before)
  });
  const j2 = await imp2.json();
  if (!j2.ok) throw new Error('JSON 回灌失败: ' + j2.error);
  console.log('✓ JSON 直接回灌导入成功');

  // 7) 恢复演示数据
  const cp = require('child_process');
  cp.execSync('node ' + JSON.stringify(path.join(__dirname, 'seed-demo.cjs')), { stdio: 'inherit' });
  console.log('✓ 全部备份验证通过');
}

main().catch((e) => { console.error('✗ 备份验证失败:', e.message); process.exit(1); });
