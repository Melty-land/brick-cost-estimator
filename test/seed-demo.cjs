/**
 * 演示数据种子脚本:重置数据为"11 种材料 + 1 个产品 + 2 个估算单"。
 * 运行:node test/seed-demo.cjs(需服务在跑;会先用内置 admin 登录)
 */
'use strict';

const path = require('path');
const API = 'http://127.0.0.1:8237/api/data';

const data = {
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
  products: [
    {
      id: 'p1', name: '标砖 240×115×53', code: 'BZ-240',
      recipe: [
        { materialId: 'm1', qtyPerPot: 200 }, { materialId: 'm2', qtyPerPot: 150 },
        { materialId: 'm3', qtyPerPot: 100 }, { materialId: 'm4', qtyPerPot: 300 },
        { materialId: 'm5', qtyPerPot: 80 },  { materialId: 'm6', qtyPerPot: 100 },
        { materialId: 'm7', qtyPerPot: 60 },  { materialId: 'm8', qtyPerPot: 5 },
        { materialId: 'm9', qtyPerPot: 40 },  { materialId: 'm10', qtyPerPot: 3 },
        { materialId: 'm11', qtyPerPot: 2 }
      ]
    }
  ],
  estimates: [],
  seq: { material: 11, product: 1, estimate: 0 }
};

const zones = {
  m1: '底料', m2: '底料', m3: '底料', m4: '底料', m5: '底料',
  m6: '面料', m7: '面料', m8: '面料', m9: '面料', m10: '面料', m11: '面料'
};
const names = {
  m1: '黑水泥', m2: '3-6', m3: '5-10', m4: '机制砂', m5: '石粉',
  m6: '白水泥', m7: '精白砂', m8: '金刚黑', m9: '普砂', m10: '增强剂', m11: '染料'
};
const prices = { m1: 500, m2: 90, m3: 85, m4: 80, m5: 60, m6: 600, m7: 150, m8: 1200, m9: 100, m10: 8000, m11: 6000 };
const up = { m1: 2, m2: 1, m3: 1, m4: 1, m5: 0.5, m6: 0.5, m7: 0, m8: 0, m9: 0, m10: 0, m11: 0 };
const jin = { m1: 3, m2: 2, m3: 1, m4: 1, m5: 0.5, m6: 1, m7: 1, m8: 0.5, m9: 0.5, m10: 0.1, m11: 0.05 };
const qty = { m1: 5, m2: 2, m3: 2, m4: 2, m5: 1, m6: 1, m7: 1, m8: 0.5, m9: 0.5, m10: 0.1, m11: 0.05 };

function makeEstimate(id, author, potBottom, potTop, startDate, endDate, calc) {
  const rows = Object.keys(names).map((mid, i) => ({
    id: id + '-r' + (i + 1), materialId: mid, name: names[mid], zone: zones[mid],
    qtyPerPot: data.products[0].recipe.find((r) => r.materialId === mid).qtyPerPot,
    price: prices[mid], stockOnHand: up[mid], stockIn: jin[mid], qty: qty[mid]
  }));
  return {
    id, productId: 'p1', name: '标砖 240×115×53', code: 'BZ-240',
    status: 'ready',
    startDate, endDate, author, potBottom, potTop, rows, calc
  };
}

data.estimates.push(makeEstimate('e1', '张三', 10, 8, '2026-09-01', '2026-09-30', {
  length: 240, width: 115, height: 53, perPieceWeight: 3.5, perModuleCount: 30, moldManual: 2,
  perSqmWeight: 126.81159420289855, perCubicWeight: 2392.672476439023, perPalletCount: 300,
  perPalletSqm: 10, perPalletWeight: 1268.1159420289854, planCount: 1.656, actualCount: '',
  yieldRate: '', tonPrice: 243286.5731462926, perSqmPrice: 1466183.5748792272,
  startMold: 1, endMold: 5
}));
data.estimates.push(makeEstimate('e2', '李四', 12, 10, '2026-10-01', '2026-10-31', {
  length: 240, width: 115, height: 53, perPieceWeight: 3.5, perModuleCount: 30, moldManual: 2,
  perSqmWeight: 126.81159420289855, perCubicWeight: 2392.672476439023, perPalletCount: 300,
  perPalletSqm: 10, perPalletWeight: 1268.1159420289854, planCount: 1.656, actualCount: '',
  yieldRate: '', tonPrice: 245406.30182421228, perSqmPrice: 1787198.0676328503,
  startMold: 6, endMold: 10
}));
data.seq.estimate = 2;

async function main() {
  // 先以内置 admin 登录获取 token
  const login = await fetch('http://127.0.0.1:8237/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  if (!login.ok) throw new Error('admin 登录失败: ' + login.status);
  const token = (await login.json()).token;
  const r = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('PUT failed: ' + r.status);
  // 同步镜像一份 data.json(供直接读盘的单测使用;运行以 SQLite 为准)
  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'data.json'), JSON.stringify(data, null, 2), 'utf8');
  console.log('✓ 演示数据已重置:材料 11 种、产品 1 个、估算单 2 个');
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
