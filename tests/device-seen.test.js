/* ══════════════════════════════════════════════════════════════════════
   排泄ケア記録を開いた端末のログインの有無（2026-11-03 代表者の決定・care-backend 統合 0062）の検証
   実行:  node tests/device-seen.test.js
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。端末の印は架空の値だけを使う。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html'), 'utf8');
const SRC = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const { makeExtractor } = require('./_extract.js');
const X = makeExtractor(SRC);

let pass = 0, fail = 0;
function t(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } }
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const KEY = 'a'.repeat(32);

function world(o) {
  const store = Object.assign({ su_device_key: KEY }, o.store || {});
  const posts = [], flags = [];
  let checks = 0;
  const A = {
    STATUS: { OK: 'ok', SIGNED_OUT: 'signed_out', DENIED: 'denied', ERROR: 'error' },
    check: async () => { checks++; return { status: o.status || 'ok', role: 'field' }; }
  };
  const ctx = {
    console, Promise, JSON, Object, Date, Error, Array, Uint8Array,
    localStorage: {
      getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
      get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i]
    },
    fetch: async (url, opt) => {
      if (/su-backend\.json/.test(url)) { flags.push(url); return { ok: true, json: async () => ({ supabase: { device_seen: o.on !== false } }) }; }
      posts.push({ url, opt, body: JSON.parse(opt.body) });
      if (o.netFail) throw new Error('net');
      return { ok: o.okReply !== false };
    },
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = 0xbb; return a; } },
    document: { createElement: () => ({}), head: { appendChild: () => {} } },
    window: { SUAuth: A, supabase: {}, crypto: { getRandomValues: a => a } }
  };
  ctx.window.crypto = ctx.crypto;
  vm.createContext(ctx);
  const names = ['hbMhLoadAuth_', 'hbSeenToday_', 'hbSeenHasSession_', 'hbSeenKey_', 'hbSeen_'];
  const vars = SRC.match(/var HB_CT=[^\n]*/)[0] + '\n' + SRC.match(/var HB_SEEN_URL=[^\n]*\nvar HB_SEEN_PUB=[^\n]*\nvar HB_SEEN_SENT=[^\n]*/)[0];
  vm.runInContext(vars + '\n' + names.map(n => X.fn(n)).join('\n') + '\nthis.api={' + names.map(n => n + ':' + n).join(',') + '};', ctx);
  return { api: ctx.api, store, posts, flags, checks: () => checks };
}
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  console.log('排泄ケア記録を開いた端末のログインの有無');
  {
    const w = world({ on: false });
    await w.api.hbSeen_(); await tick();
    t('スイッチ device_seen が切: 何も送らない（今までと同じ）', w.posts.length === 0 && !('hb_seen_sent' in w.store) && w.flags.length === 1, w.posts);
    t('スイッチは care-tools の su-backend.json を読む', /^\.\.\/care-tools\/su-backend\.json\?t=\d+$/.test(w.flags[0] || ''), w.flags);
  }
  {
    const w = world({ store: { su_device_role: 'field' } });
    await w.api.hbSeen_(); await tick();
    t('ログインの控えが無い現場の端末: 「ログインしていない」を送る（ログインの部品は呼ばない）',
      w.posts.length === 1 && JSON.stringify(w.posts[0].body) === JSON.stringify({ k: KEY, role: 'field', login: false, app: 'hb' }) && w.checks() === 0, w.posts.map(p => p.body));
    t('　受け口は device-seen・公開用の鍵だけ・資格情報を付けない', w.posts[0].url === 'https://jhbernqawjrzqwrmqrih.supabase.co/functions/v1/device-seen'
      && /^sb_publishable_/.test(w.posts[0].opt.headers.apikey) && w.posts[0].opt.credentials === 'omit' && !w.posts[0].opt.headers.Authorization);
    t('　送った印を控える（日付|用途|有無）', w.store.hb_seen_sent === today() + '|field|0', w.store);
    await w.api.hbSeen_(); await tick();
    t('　同じ日にもう一度開いても送らない（スイッチも読まない）', w.posts.length === 1 && w.flags.length === 1);
    w.store['sb-abc-auth-token'] = '{}';
    await w.api.hbSeen_(); await tick();
    t('　同じ日にログインしたら、確かめて「ログイン中」を送り直す', w.posts.length === 2 && w.posts[1].body.login === true && w.checks() === 1 && w.store.hb_seen_sent === today() + '|field|1', w.posts.map(p => p.body));
    await w.api.hbSeen_(); await tick();
    t('　ログイン中として送った後は、その日はもう確かめない', w.posts.length === 2 && w.checks() === 1);
  }
  {
    const w = world({ store: { 'sb-abc-auth-token': '{}' }, status: 'denied' });
    await w.api.hbSeen_(); await tick();
    t('使えないアカウント（denied）は「ログインしていない」・事務所の端末は office', w.posts.length === 1 && w.posts[0].body.login === false && w.posts[0].body.role === 'office', w.posts.map(p => p.body));
  }
  {
    const w = world({ store: { 'sb-abc-auth-token': '{}' }, status: 'error' });
    await w.api.hbSeen_(); await tick();
    t('確かめられない時（通信の失敗）は送らない・控えない', w.posts.length === 0 && !('hb_seen_sent' in w.store));
  }
  {
    const w = world({ store: { 'sb-abc-auth-token': '{}' }, status: 'mfa_verify' });
    await w.api.hbSeen_(); await tick();
    t('2段階認証の6桁がまだの管理者はログイン中として数える', w.posts.length === 1 && w.posts[0].body.login === true);
  }
  {
    const w = world({ okReply: false });
    await w.api.hbSeen_(); await tick();
    t('受け口が断った時は控えない（後で送り直す）', w.posts.length === 1 && !('hb_seen_sent' in w.store));
    await w.api.hbSeen_(); await tick();
    t('　断られた後の6時間は送り直さない（開くたびに繰り返さない）', w.posts.length === 1 && w.flags.length === 1);
    w.store.hb_seen_retry = String(Date.now() - 7 * 3600 * 1000);
    await w.api.hbSeen_(); await tick();
    t('　6時間を過ぎたら送り直す', w.posts.length === 2);
    const w2 = world({ netFail: true });
    let threw = false;
    try { await w2.api.hbSeen_(); await tick(); } catch (e) { threw = true; }
    t('届かない時も例外を外に出さない', !threw && !('hb_seen_sent' in w2.store));
  }
  {
    const w = world({ store: { su_device_key: '' } });
    await w.api.hbSeen_(); await tick();
    t('端末の印が無ければ32文字の乱数を作り、care-tools と同じ su_device_key に置く', /^[0-9a-f]{32}$/.test(w.store.su_device_key) && w.posts[0].body.k === w.store.su_device_key, w.store);
  }
  {
    const w = world({ store: { su_device_role: 'field', hb_seen_sent: '2000-01-01|field|0' } });
    await w.api.hbSeen_(); await tick();
    t('日が変わったら送り直す', w.posts.length === 1);
  }
  t('送る本文は印・用途・有無・アプリの名前の4つだけ（氏名・記録・メールを送らない）', /body:JSON\.stringify\(\{k:k,role:role,login:!!login,app:'hb'\}\)/.test(SRC));
  console.log('\n合格 ' + pass + ' / 不合格 ' + fail);
  process.exit(fail ? 1 : 0);
})();
