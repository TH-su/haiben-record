/* ══════════════════════════════════════════════════════════════════════
   切り替える前から、ログインしていない端末に出す帯（2026-11-14 代表者の決定「この文で出して」）の検証
   実行:  node tests/prelogin-band.test.js
   守ること:
     1 ログインの控えが無い端末: 帯を出す（ログインの部品は読まない＝通信しない）
     2 控えがあり、確かめて「ログインしていない」「使えないアカウント」: 出す／「使える」: 出さない／確かめられない（通信の失敗）: 出さない
     3 切り替えた後の帯（hbNoLogin）が出ている間は出さない。切り替えた後の帯を出す時は、この帯を消す
     4 文は代表者が決めた文のまま・画面だけ（印刷しない）
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。
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
const TEXT = 'この端末はまだログインしていません。排泄ケア記録の保存先の切り替えに向けて、事務所で「端末登録の QR」を出してもらい、この端末のカメラで読んでください。';

function world(o) {
  const store = Object.assign({}, o.store || {});
  let checks = 0;
  const A = {
    STATUS: { OK: 'ok', SIGNED_OUT: 'signed_out', DENIED: 'denied', ERROR: 'error' },
    check: async () => { checks++; if (o.throws) throw new Error('net'); return { status: o.status || 'ok', role: 'field' }; }
  };
  const pre = { hidden: true }, no = { hidden: o.noLoginShown ? false : true };
  const ctx = {
    console, Promise, JSON, Object, Date, Error, Array,
    localStorage: { getItem: k => (k in store ? store[k] : null), get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i] },
    document: { getElementById: id => (id === 'hbPreLogin' ? pre : id === 'hbNoLogin' ? no : null), createElement: () => ({}), head: { appendChild: () => {} } },
    window: { SUAuth: A, supabase: {} }
  };
  vm.createContext(ctx);
  const names = ['hbMhLoadAuth_', 'hbSeenHasSession_', 'hbNoLoginBand_', 'hbPreLoginBand_'];
  const vars = SRC.match(/var HB_CT=[^\n]*/)[0] + '\nvar _hbPreBusy=false;';
  vm.runInContext(vars + '\n' + names.map(n => X.fn(n)).join('\n') + '\nthis.api={' + names.map(n => n + ':' + n).join(',') + '};', ctx);
  return { api: ctx.api, pre, no, checks: () => checks };
}

(async () => {
  console.log('切り替える前のログインの帯');
  {
    const w = world({});
    await w.api.hbPreLoginBand_(); await tick();
    t('1 ログインの控えが無い端末: 帯を出す・ログインの部品で確かめない（通信しない）', w.pre.hidden === false && w.checks() === 0);
  }
  for (const [st, want, label] of [['signed_out', false, 'ログインしていない'], ['denied', false, '使えないアカウント'], ['ok', true, '使える'], ['error', true, '確かめられない']]) {
    const w = world({ store: { 'sb-abc-auth-token': '{}' }, status: st });
    await w.api.hbPreLoginBand_(); await tick();
    t('2 控えがあり「' + label + '」: 帯を' + (want ? '出さない' : '出す'), w.pre.hidden === want && w.checks() === 1, w.pre);
  }
  {
    const w = world({ store: { 'sb-abc-auth-token': '{}' }, throws: true });
    w.pre.hidden = false;
    await w.api.hbPreLoginBand_(); await tick();
    t('2 確かめの途中で失敗（通信）: 帯を出さない', w.pre.hidden === true);
  }
  {
    const w = world({ noLoginShown: true });
    await w.api.hbPreLoginBand_(); await tick();
    t('3 切り替えた後の帯が出ている間は出さない', w.pre.hidden === true);
    const w2 = world({});
    await w2.api.hbPreLoginBand_(); await tick();
    w2.api.hbNoLoginBand_(true);
    t('3 切り替えた後の帯を出す時は、この帯を消す', w2.pre.hidden === true && w2.no.hidden === false);
  }
  {
    const m = /<div class="hb-nologin" id="hbPreLogin" role="status" hidden>([^<]*)<\/div>/.exec(HTML);
    t('4 文は代表者が決めた文のまま（id hbPreLogin・始めは隠す・読み上げの status）', !!m && m[1] === TEXT, m && m[1]);
    t('4 印刷しない（.hb-nologin は印刷で出さない）', /@media print\{\.hb-nologin\{display:none !important\}\}/.test(HTML));
    t('4 開いた時・見えた時・別のタブでログインした時に確かめる', /hbPreLoginBand_\(\);document\.addEventListener\('visibilitychange'/.test(SRC) && /auth-token\$\/\.test\(String\(e\.key\)\)\)hbPreLoginBand_\(\)/.test(SRC));
  }
  console.log(`\n合格 ${pass} / 不合格 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
