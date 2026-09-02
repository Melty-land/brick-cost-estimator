/**
 * 数据层:与本地服务端 /api/data 交互,提供 CRUD。
 * 所有修改后调用 Store.save() 落盘到 data/data.json。
 */
(function (root) {
  'use strict';

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  var Store = {
    data: null,

    /** 加载数据(首次启动自动由服务端初始化种子材料) */
    async load() {
      var r = await fetch('/api/data');
      if (!r.ok) throw new Error('加载数据失败:HTTP ' + r.status);
      this.data = await r.json();
      return this.data;
    },

    /** 保存整个数据对象到磁盘 */
    async save() {
      var r = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.data)
      });
      if (!r.ok) throw new Error('保存失败:HTTP ' + r.status);
      return true;
    },

    nextId(prefix) {
      this.data.seq = this.data.seq || {};
      var v = (this.data.seq[prefix] || 0) + 1;
      this.data.seq[prefix] = v;
      return prefix + v;
    },

    materialById(id) {
      return (this.data.materials || []).find(function (m) { return m.id === id; }) || null;
    },

    // ---------- 材料 ----------
    addMaterial(name, zone) {
      var m = { id: this.nextId('material'), name: name.trim(), zone: zone };
      this.data.materials.push(m);
      return m;
    },
    updateMaterial(id, patch) {
      var m = this.data.materials.find(function (x) { return x.id === id; });
      if (m) Object.assign(m, patch);
      return m;
    },
    /** 材料被产品配方或估算单引用时不允许删除 */
    deleteMaterial(id) {
      var usedByProduct = this.data.products.some(function (p) {
        return p.recipe.some(function (r) { return r.materialId === id; });
      });
      var usedByEstimate = this.data.estimates.some(function (e) {
        return e.rows.some(function (r) { return r.materialId === id; });
      });
      if (usedByProduct || usedByEstimate) {
        return { ok: false, reason: '该材料已被产品配方或估算单引用,不能删除' };
      }
      this.data.materials = this.data.materials.filter(function (x) { return x.id !== id; });
      return { ok: true };
    },

    // ---------- 产品与配方 ----------
    addProduct(name, code, recipe) {
      var p = { id: this.nextId('product'), name: name.trim(), code: (code || '').trim(), recipe: recipe };
      this.data.products.push(p);
      return p;
    },
    updateProduct(id, patch) {
      var p = this.data.products.find(function (x) { return x.id === id; });
      if (p) Object.assign(p, patch);
      return p;
    },
    /** 删除产品:其历史估算单保留快照,但解除 productId 关联 */
    deleteProduct(id) {
      this.data.products = this.data.products.filter(function (x) { return x.id !== id; });
      this.data.estimates.forEach(function (e) { if (e.productId === id) e.productId = null; });
      return { ok: true };
    },

    // ---------- 估算单 ----------
    addEstimate(est) {
      est.id = this.nextId('estimate');
      this.data.estimates.push(est);
      return est;
    },
    updateEstimate(id, patch) {
      var i = this.data.estimates.findIndex(function (x) { return x.id === id; });
      if (i >= 0) this.data.estimates[i] = patch;
      return i >= 0;
    },
    deleteEstimate(id) {
      this.data.estimates = this.data.estimates.filter(function (x) { return x.id !== id; });
      return { ok: true };
    },
    cloneEstimate(id) {
      var src = this.data.estimates.find(function (x) { return x.id === id; });
      if (!src) return null;
      var c = deepClone(src);
      c.id = this.nextId('estimate');
      c.cloneOf = src.id;
      this.data.estimates.push(c);
      return c;
    }
  };

  root.Store = Store;
})(window);
