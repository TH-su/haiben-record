/* ══════════════════════════════════════════════════════════════════════
   入居者マスタの正本を切り替えた後の入院の印（新しい保存先 res_set_hosp）の検証（2026-10-29）
   実行:  node tests/master-hosp-sb.test.js
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。架空の利用者No だけを使う。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html'), 'utf8');
const SRC = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const { makeExtractor } = require('./_extract.js');
const X = makeExtractor(SRC);

let pass = 0, fail = 0;
function t(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } }
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function world(o) {
  const store = {}, toasts = [], rpcs = [], fetches = [];
  const A = {
    STATUS: { OK: 'ok' },
    check: async () => (o.signedOut ? { status: 'signed_out' } : { status: 'ok', role: 'field' }),
    client: () => ({ rpc: async (name, args) => { rpcs.push([name, args]); if (o.gate) await o.gate; return o.reply ? o.reply(args) : { data: { ok: true }, error: null }; } })
  };
  const ctx = {
    console, Promise, JSON, Object, Date, Error,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    fetch: async (url) => { fetches.push(url); if (o.flagsErr) throw new Error('net'); return { ok: true, json: async () => ({ supabase: { master_live: o.live === true } }) }; },
    showToast: m => toasts.push(m),
    document: { createElement: () => ({}), head: { appendChild: () => {} } },
    window: { SUAuth: A, supabase: {} }
  };
  vm.createContext(ctx);
  const names = ['hbMhLiveOn_', 'hbMhPend_', 'hbMhSave_', 'hbMhQueue_', 'hbMhLoadAuth_', 'hbMhSend_'];
  const vars = SRC.match(/var HB_MH_PEND=[^\n]*\nvar HB_CT=[^\n]*\nvar _hbMhFlags=[^\n]*/)[0];
  vm.runInContext(vars + '\n' + names.map(n => X.fn(n)).join('\n') + '\nthis.api={' + names.map(n => n + ':' + n).join(',') + '};', ctx);
  return { api: ctx.api, store, toasts, rpcs, fetches };
}

(async () => {
  console.log('入院の印を新しい保存先へ');
  {
    const w = world({ live: false });
    w.api.hbMhQueue_('101', true); await tick();
    t('スイッチが切: 新しい保存先へ送らず、控えも作らない（今までと同じ）', w.rpcs.length === 0 && !('hb_master_hosp_pending' in w.store));
    t('スイッチは care-tools の su-backend.json を読む', /^\.\.\/care-tools\/su-backend\.json\?t=\d+$/.test(w.fetches[0] || ''), w.fetches);
  }
  {
    const w = world({ live: true });
    w.api.hbMhQueue_('101', true); await tick();
    t('スイッチが入: 入院の印だけを res_set_hosp へ送り、届いたら控えを消す', JSON.stringify(w.rpcs) === '[["res_set_hosp",{"p_id":"101","p_hospitalized":true}]]' && !('hb_master_hosp_pending' in w.store), w.rpcs);
  }
  {
    const w = world({ live: true, reply: () => ({ data: { ok: false, error: 'shadow' }, error: null }) });
    w.api.hbMhQueue_('101', false); await tick();
    t('まだ写しの期間（shadow）: Google だけで足りるので控えを消す', w.rpcs.length === 1 && !('hb_master_hosp_pending' in w.store));
  }
  {
    const w = world({ live: true, signedOut: true });
    w.api.hbMhQueue_('101', true); await tick();
    w.api.hbMhQueue_('102', false); await tick();
    t('ログインしていない: 送らずに控える（利用者No と入院中かだけ）・知らせは1回', w.rpcs.length === 0 && w.store.hb_master_hosp_pending === '{"101":true,"102":false}' && w.toasts.length === 1, [w.store, w.toasts]);
  }
  {
    const w = world({ live: true, reply: () => ({ data: null, error: { message: 'Failed to fetch' } }) });
    w.api.hbMhQueue_('101', true); await tick();
    t('届かない: 控えを残す', w.store.hb_master_hosp_pending === '{"101":true}');
  }
  {
    let open; const gate = new Promise(r => { open = r; });
    const w = world({ live: true, gate });
    w.api.hbMhQueue_('101', true); await tick();
    w.api.hbMhQueue_('101', false); await tick();
    const during = w.rpcs.length;
    open(); await tick(60);
    t('送っている間に同じ方の印が変わったら、最後の印を送り直す（古い印で控えを消さない）', during === 1 && w.rpcs.length === 2 && w.rpcs[1][1].p_hospitalized === false
      && !('hb_master_hosp_pending' in w.store), [during, w.rpcs, w.store]);
  }
  {
    const w = world({ live: false });
    w.store.hb_master_hosp_pending = '{"101":true}';
    await w.api.hbMhSend_(); await tick();
    t('スイッチが切に戻った: 控えを捨てる（Google へは送ってある）', w.rpcs.length === 0 && !('hb_master_hosp_pending' in w.store));
  }
  {
    const w = world({ live: true, flagsErr: true });
    w.store.hb_master_hosp_pending = '{"101":true}';
    await w.api.hbMhSend_(); await tick();
    t('スイッチを読めない: 何もせず控えを残す', w.rpcs.length === 0 && w.store.hb_master_hosp_pending === '{"101":true}');
  }
  t('入院の印を送る所（pushMasterHospState）で、Google への送信の後に新しい保存先へも送る',
    /apiPush\('setMasterState',\{masterId:String\(r\.masterId\),hospitalized:nowHosp\}\);\n\s*if\(typeof hbMhQueue_==='function'\)hbMhQueue_\(String\(r\.masterId\),nowHosp\);/.test(SRC));
  t('開いた時・通信が戻った時に控えを送り直す', /init\(\);\n\s*try\{hbMhSend_\(\)\}catch\(e\)\{\}/.test(SRC) && /addEventListener\('online',function\(\)\{try\{hbMhSend_\(\)\}catch\(e\)\{\}\}\)/.test(SRC));

  console.log(`\n合格 ${pass} / 不合格 ${fail}`);
  process.exitCode = fail ? 1 : 0;
})();
