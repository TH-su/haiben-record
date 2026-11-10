/* ══════════════════════════════════════════════════════════════════════
   管理者が配った接続先（2026-11-10 本人指示・care-tools の su-devcfg.js・統合 0080）の検証
   実行:  node tests/devcfg.test.js
   守ること:
     1. ログインしていない端末は何も読まない（部品もログインも読み込まない）
     2. ログインしていれば care-tools の部品を読み、系統 haiben の接続先と合言葉を返す
     3. 配っていない・形が違う・部品が読めない・ログインの部品が読めない時は null（今までどおり接続先なし）
     4. 配った接続先を使っている間は、保存の関数（5分ごと・同期の後の書き戻しも通る）が端末に書かない
     5. 起動の流れ: 端末に接続先が無い時だけ受け取り、手で入れた・解除した時は配った値の印を下ろす
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。接続先・合言葉は架空の値だけ。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html'), 'utf8');
const SRC = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const { makeExtractor } = require('./_extract.js');
const X = makeExtractor(SRC);

let pass = 0, fail = 0;
function t(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } }
const URL1 = 'https://script.google.com/macros/s/' + 'X'.repeat(20) + '/exec';
const TOK = 'dummy-token-1234';

function world(o) {
  const store = Object.assign({}, o.store || {});
  const loaded = [], readyCalls = [];
  const win = {};
  if (o.auth !== false) win.SUAuth = { STATUS: { OK: 'ok' }, check: async () => ({ status: 'ok' }) };
  win.supabase = {};
  const ctx = {
    console, Promise, JSON, Object, Date, Error, Array, String,
    localStorage: {
      getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
      get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i]
    },
    document: {
      createElement: () => ({}),
      head: { appendChild: s => { loaded.push(s.src); setTimeout(() => {
        if (o.loadFail) { s.onerror && s.onerror(); return; }
        if (/su-devcfg\.js/.test(s.src) && o.cfg !== 'nopart') win.SUDevCfg = { ready: ms => { readyCalls.push(ms); return Promise.resolve(); }, get: k => (o.cfg && o.cfg[k]) || null };
        s.onload && s.onload();
      }, 0); } }
    },
    setTimeout,
    window: win
  };
  vm.createContext(ctx);
  const names = ['hbMhLoadAuth_', 'hbSeenHasSession_', 'hbDevCfgLoad_'];
  const vars = SRC.match(/var HB_CT=[^\n]*/)[0] + '\n' + SRC.match(/var HB_DEVCFG_SRC=[^\n]*\nvar _hbDevCfg=[^\n]*/)[0];
  vm.runInContext(vars + '\n' + names.map(n => X.fn(n)).join('\n') + '\nthis.api={' + names.map(n => n + ':' + n).join(',') + '};', ctx);
  return { api: ctx.api, loaded, readyCalls };
}
const SESSION = { 'sb-abcdefgh-auth-token': '{"access_token":"x"}' };

(async () => {
  console.log('管理者が配った接続先');
  {
    const w = world({ cfg: { haiben: { url: URL1, token: TOK } } });
    const r = await w.api.hbDevCfgLoad_();
    t('1. ログインしていない端末は何も読まない', r === null && w.loaded.length === 0, w.loaded);
  }
  {
    const w = world({ store: SESSION, cfg: { haiben: { url: URL1, token: TOK } } });
    const r = await w.api.hbDevCfgLoad_();
    t('2. ログインしていれば系統 haiben の接続先と合言葉を返す', r && r.url === URL1 && r.token === TOK, r);
    t('2. 部品は care-tools から読む', w.loaded.length === 1 && /^\.\.\/care-tools\/su-devcfg\.js\?v=\d{4}-\d{2}-\d{2}/.test(w.loaded[0]), w.loaded);
    t('2. 受け取りの済むのを打ち切りつきで待つ', w.readyCalls.length === 1 && w.readyCalls[0] === 8000, w.readyCalls);
  }
  {
    const w = world({ store: SESSION, cfg: { ws: { url: URL1, token: TOK } } });
    t('3. 排泄ケア記録の系統を配っていない時は null', (await w.api.hbDevCfgLoad_()) === null);
  }
  {
    const w = world({ store: SESSION, cfg: { haiben: { url: 'https://example.com/exec', token: TOK } } });
    t('3. GAS の住所でない時は null', (await w.api.hbDevCfgLoad_()) === null);
  }
  {
    const w = world({ store: SESSION, loadFail: true, cfg: { haiben: { url: URL1, token: TOK } } });
    t('3. 部品が読めない時は null（止まらない）', (await w.api.hbDevCfgLoad_()) === null);
  }
  {
    const w = world({ store: SESSION, cfg: 'nopart' });
    t('3. 部品を読んでも中身が無い時は null', (await w.api.hbDevCfgLoad_()) === null);
  }
  {
    const w = world({ store: SESSION, auth: false, loadFail: true, cfg: { haiben: { url: URL1, token: TOK } } });
    t('3. ログインの部品が読めない時は null（部品を読みに行かない）', (await w.api.hbDevCfgLoad_()) === null && !w.loaded.some(s => /su-devcfg/.test(s)), w.loaded);
  }
  {
    const store = {}, cookies = [];
    const ctx = { _hbDevCfg: true, API_KEY: 'k1', API_KEY_BAK: 'k2', API_KEY_BAK2: 'k3', API_TOKEN_KEY: 't1', API_TOKEN_KEY_BAK: 't2', API_COOKIE: 'c1', API_COOKIE_BAK: 'c2', API_TOKEN_COOKIE: 'c3', API_IDB_KEY: 'i1', API_TOKEN_IDB_KEY: 'i2',
      localStorage: { setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
      sessionStorage: { setItem: (k, v) => { store['s:' + k] = v; }, removeItem: () => {} },
      _setCookie: (...a) => cookies.push(a), _delCookie: () => {}, _idbSet: () => Promise.resolve(), _idbDel: () => {}, navigator: {}, clearApiToken: () => { store.cleared = 1; }, console };
    vm.createContext(ctx);
    vm.runInContext(X.fn('saveApiUrl') + '\n' + X.fn('saveApiToken'), ctx);
    vm.runInContext('saveApiUrl(' + JSON.stringify(URL1) + ');saveApiToken(' + JSON.stringify(TOK) + ')', ctx);
    t('4. 配った接続先の間は、5分ごと・同期の後の書き戻しを含め端末に書かない（保存の関数の入口で止める）', Object.keys(store).length === 0 && cookies.length === 0, { store, cookies });
    let threw = null;
    try { vm.runInContext('_hbDevCfg=false;saveApiUrl(' + JSON.stringify(URL1) + ');saveApiToken(' + JSON.stringify(TOK) + ')', ctx); } catch (e) { threw = e.message; }
    t('4. 手で入れた接続先は今までどおり端末に書く', store.k1 === URL1 && store.t1 === TOK, { store, threw });
  }
  {
    const i = SRC.indexOf('function _applyDevCfg(');
    const blk = SRC.slice(i, SRC.indexOf('\n  }\n', i));
    t('5. 配った値で同期する時は端末に書かない（保存の関数を呼ばない）', i > 0 && !/saveApiUrl|saveApiToken|clearApiToken/.test(blk), blk.slice(0, 120));
    t('5. 見本の入居者を外してから同期する', /_seed/.test(blk) && /syncCatchUp\(true,\{reset:true\}\)/.test(blk));
    t('5. 端末に接続先が無い時だけ受け取る', /if\(!apiUrl\)\{\s*hbDevCfgLoad_\(\)\.then\(function\(c\)\{\s*if\(!c\|\|apiUrl\|\|_locked\)return;/.test(SRC));
    t('5. 手で入れた時は配った値の印を下ろす', /function _applyApiSave\(url,tk\)\{\s*_hbDevCfg=false;/.test(SRC));
    t('5. 解除した時も配った値の印を下ろす', /_hbDevCfg=false;\s*apiUrl='';clearApiUrl\(\);/.test(SRC));
  }
  console.log('\n' + (fail ? '✗' : '✓') + ' devcfg: ' + pass + ' 件成功 / ' + fail + ' 件失敗');
  process.exit(fail ? 1 : 0);
})();
