/**
 * 数据层:与本地服务端交互,提供 CRUD 与登录/用户管理。
 * 数据存于服务端 SQLite(data/brick.db);请求统一携带 Bearer token。
 */
(function (root) {
  'use strict';

  var TOKEN_KEY = 'brick_token';

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  var Store = {
    data: null,

    get token() { return root.localStorage.getItem(TOKEN_KEY) || ''; },
    set token(v) {
      if (v) root.localStorage.setItem(TOKEN_KEY, v);
      else root.localStorage.removeItem(TOKEN_KEY);
    },

    /** 带 Authorization 的原始 fetch(通用底层;备份导出等需要 blob/原始体时直接用) */
    authedFetch(url, opts) {
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {});
      if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
      var t = this.token;
      if (t) headers.Authorization = 'Bearer ' + t;
      return fetch(url, {
        method: opts.method || (opts.json !== undefined || opts.body ? 'POST' : 'GET'),
        headers: headers,
        body: opts.body !== undefined ? opts.body : (opts.json !== undefined ? JSON.stringify(opts.json) : undefined)
      });
    },

    /** 通用 JSON 请求(自动携带 Authorization;非 2xx 抛错) */
    async req(url, opts) {
      var r = await this.authedFetch(url, opts);
      var data = null;
      try { data = await r.json(); } catch (e) { /* 非 JSON */ }
      if (!r.ok) {
        var err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.status = r.status;
        throw err;
      }
      return data;
    },

    async login(username, password) {
      var d = await this.req('/api/auth/login', { json: { username: username, password: password } });
      this.token = d.token;
      return d.user;
    },
    async register(username, password, nickname) {
      var d = await this.req('/api/auth/register', { json: { username: username, password: password, nickname: nickname || '' } });
      return d.user;
    },
    async me() {
      var d = await this.req('/api/auth/me', { method: 'GET' });
      return d.user;
    },
    async logout() {
      try { await this.req('/api/auth/logout', { json: {} }); } catch (e) { /* ignore */ }
      this.token = '';
    },
    async changePassword(oldPassword, newPassword) {
      return this.req('/api/auth/password', { method: 'PUT', json: { oldPassword: oldPassword, newPassword: newPassword } });
    },
    async listUsers() {
      var d = await this.req('/api/users', { method: 'GET' });
      return d.users;
    },
    async addUser(username, password, nickname, role) {
      return this.req('/api/users', { json: { username: username, password: password, nickname: nickname || '', role: role || 'user' } });
    },
    async updateUser(username, patch) {
      return this.req('/api/users/' + encodeURIComponent(username), { method: 'PUT', json: patch });
    },
    async deleteUser(username) {
      return this.req('/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
    },

    /** 加载数据(需登录) */
    async load() {
      var r = await fetch('/api/data', { headers: this.token ? { Authorization: 'Bearer ' + this.token } : {} });
      if (!r.ok) throw new Error('加载数据失败:HTTP ' + r.status);
      this.data = await r.json();
      return this.data;
    },

    /** 保存整个数据对象(需登录) */
    async save() {
      var r = await fetch('/api/data', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.token ? { Authorization: 'Bearer ' + this.token } : {}),
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
