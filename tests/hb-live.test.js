/* ══════════════════════════════════════════════════════════════════════
   排泄ケア記録の正本を新しい保存先へ切り替えた後の送り先（2026-11-05 代表者の決定・care-backend 統合 0064）の検証
   実行:  node tests/hb-live.test.js
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。記録は架空の値だけを使う。
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

function world(o) {
  const store = Object.assign({}, o.store || {}), flags = [], modes = [], rpcs = [], toasts = [], pend = [], statuses = [];
  let now = 1800000000000;
  const band = { hidden: true };
  const A = {
    STATUS: { OK: 'ok', SIGNED_OUT: 'signed_out', DENIED: 'denied', ERROR: 'error' },
    check: async () => ({ status: o.auth || 'ok', role: 'field' }),
    client: () => ({ rpc: async (name, args) => { rpcs.push([name, args]); return o.reply ? o.reply(args) : { data: { ok: true, via: 'sb' }, error: null }; } })
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Promise, JSON, Object, Error, Array, String, Number, Math, setTimeout, clearTimeout,
    Date: Object.assign(function () { return new Date(now); }, { now: () => now }),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    fetch: async (url) => { flags.push(url); if (o.flagErr) throw new Error('net'); return { ok: true, json: async () => ({ supabase: { haiben: o.on === true } }) }; },
    fetchTO: async (url, opt) => { modes.push({ url, opt }); if (o.modeErr) throw new Error('net'); return { ok: true, json: async () => ({ ok: true, mode: o.mode || 'shadow' }) }; },
    document: { getElementById: id => (id === 'hbNoLogin' ? band : null), createElement: () => ({}), head: { appendChild() {} } },
    window: { SUAuth: A, supabase: {} },
    showToast: m => toasts.push(m), apiSetStatus: (s, m) => statuses.push([s, m]), enqueuePending: (a, d) => pend.push(a), _wqPersist() {}, flushPendingQueue() {},
    _recentDelAdd() {}, isDroppableOnOldGas: (a, r) => a === 'setMasterState' && r && /unknown action/.test(r.error || ''),
    apiPost: async () => o.postReply
  };
  vm.createContext(ctx);
  const names = ['hbLiveFlag_', 'hbLiveMode_', 'hbLiveReset_', 'hbLiveOn_', 'hbReadSrc_', 'hbNoLoginBand_', 'hbTimeout_', 'hbTryLive_', 'hbMhLoadAuth_', '_writeDrain'];
  const vars = SRC.match(/var HB_CT=[^\n]*/)[0] + '\n' + SRC.match(/var HB_SEEN_PUB=[^\n]*/)[0] + '\n' + SRC.match(/var HB_SB_URL=[^\n]*\nvar _hbLiveSt=[^\n]*/)[0]
    + '\n' + SRC.match(/var HB_READ_SRC=[^\n]*/)[0] + '\nvar _writeQ=[], _writeSending=false, _wqCurrent=null;';
  vm.runInContext(vars + '\n' + names.map(n => X.fn(n)).join('\n') + '\nthis.api={' + names.map(n => n + ':' + n).join(',') + '};this.q=function(){return _writeQ};', ctx);
  return { api: ctx.api, ctx, store, flags, modes, rpcs, toasts, pend, statuses, band, adv: ms => { now += ms; } };
}

(async () => {
  console.log('保存先を切り替えた後の送り先');
  {
    const w = world({ on: false });
    const r1 = await w.api.hbTryLive_({ action: 'getAll', token: 'x' }, 1000, false);
    const r2 = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('スイッチ haiben が切: 今までどおり Google へ（新しい保存先へ1回も問い合わせない）', r1 === undefined && r2 === undefined && w.modes.length === 0 && w.rpcs.length === 0, { r1, r2, modes: w.modes });
    t('　スイッチは care-tools の su-backend.json を読む・1分の間は読み直さない', w.flags.length === 1 && /^\.\.\/care-tools\/su-backend\.json\?t=\d+$/.test(w.flags[0]), w.flags);
    w.adv(61000); await w.api.hbTryLive_({ action: 'getAll' }, 1000, false);
    t('　1分を過ぎたら読み直す', w.flags.length === 2);
  }
  {
    const w = world({ on: true, mode: 'shadow' });
    const r = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('スイッチが入でも印が写しの期間なら Google へ', r === undefined && w.rpcs.length === 0 && w.modes.length === 1
      && w.modes[0].url === 'https://jhbernqawjrzqwrmqrih.supabase.co/functions/v1/x'.replace('functions/v1/x', 'rest/v1/rpc/hb_mode_public')
      && /^sb_publishable_/.test(w.modes[0].opt.headers.apikey) && w.modes[0].opt.credentials === 'omit' && !w.modes[0].opt.headers.Authorization, w.modes);
  }
  {
    const w = world({ on: true, modeErr: true });
    const r = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('印を読めない時は Google へ（保存は Google が断れば端末に控える）', r === undefined && w.rpcs.length === 0);
  }
  {
    const w = world({ on: true, mode: 'live' });
    const r = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1', notes: '見本' }, id: undefined, token: 'aikotoba' }, 1000, true);
    t('切り替えた後・ログイン中: 新しい保存先の hb_call へ同じ本文を送る（合言葉は付けない）', r && r.via === 'sb'
      && JSON.stringify(w.rpcs) === JSON.stringify([['hb_call', { p_body: { action: 'addRecord', record: { id: 'r1', notes: '見本' } } }]]), w.rpcs);
    t('　帯は出さない', w.band.hidden === true);
    const g = await w.api.hbTryLive_({ action: 'getAll', since: 123, heal: false, token: 'aikotoba' }, 1000, false);
    t('　Google から読んでいた後に初めて読む時は全件で読む（差分の基準をそろえる）', w.rpcs[1][1].p_body.since === undefined && w.rpcs[1][1].p_body.heal === undefined && w.store.hb_read_src === 's', w.rpcs[1]);
    await w.api.hbTryLive_({ action: 'getAll', since: 456 }, 1000, false);
    t('　その後は差分で読む', w.rpcs[2][1].p_body.since === 456, w.rpcs[2]);
  }
  {
    const w = world({ on: true, mode: 'live', auth: 'signed_out' });
    const r = await w.api.hbTryLive_({ action: 'saveRecord', record: { id: 'r1' } }, 1000, true);
    t('切り替えた後・ログインしていない: 保存は送らず hb_switched（端末に控える）・帯を出す', JSON.stringify(r) === '{"ok":false,"error":"hb_login","code":"hb_switched"}' && w.rpcs.length === 0 && w.band.hidden === false, r);
    const g = await w.api.hbTryLive_({ action: 'getAll' }, 1000, false);
    t('　読み取りは今までどおり Google から', g === undefined && w.rpcs.length === 0 && w.store.hb_read_src === 'g');
  }
  {
    const w = world({ on: true, mode: 'live', auth: 'denied' });
    const r = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('使えないアカウントもログインしていないと同じ（控えて帯）', r.code === 'hb_switched' && w.band.hidden === false);
  }
  {
    const w = world({ on: true, mode: 'live', auth: 'error' });
    let threw = false;
    try { await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true); } catch (e) { threw = true; }
    t('ログインを確かめられない時（通信の失敗）は失敗にする・帯は出さない', threw && w.band.hidden === true);
  }
  {
    const w = world({ on: true, mode: 'live', reply: () => ({ data: null, error: { code: '42501' } }) });
    const r = await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('新しい保存先が断った（許可リストに無い）時もログインしていないと同じ', r.code === 'hb_switched' && w.band.hidden === false);
  }
  {
    const w = world({ on: true, mode: 'live', reply: () => ({ data: null, error: { code: 'PGRST000' } }) });
    let threw = false;
    try { await w.api.hbTryLive_({ action: 'getAll' }, 1000, false); } catch (e) { threw = true; }
    t('新しい保存先から読めない時は Google へ流さず失敗（読み先を混ぜない）', threw);
  }
  {
    const w = world({ on: true, mode: 'live', reply: () => ({ data: { ok: false, error: 'hb_not_live', code: 'hb_switched' }, error: null }) });
    await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    const before = w.flags.length;
    await w.api.hbTryLive_({ action: 'addRecord', record: { id: 'r1' } }, 1000, true);
    t('切り替え中・戻した直後（hb_switched）は次に印を読み直す', w.flags.length === before + 1);
  }
  // 書き込みの順番待ち（_writeDrain）の受け方
  {
    const w = world({ postReply: { ok: false, error: 'hb_login', code: 'hb_switched' } });
    w.ctx.q().push({ action: 'addRecord', data: { record: { id: 'r1' } } });
    w.api._writeDrain(); await tick();
    t('_writeDrain: hb_switched は端末に控える・失敗の知らせは出さない（帯で知らせる）', JSON.stringify(w.pend) === '["addRecord"]' && w.toasts.length === 0 && w.statuses.some(s => s[0] === 'er'), { pend: w.pend, toasts: w.toasts });
  }
  {
    const w = world({ postReply: { ok: false, error: 'invalid date', code: 'hb_bad' } });
    w.ctx.q().push({ action: 'addRecord', data: { record: { id: 'r1' } } });
    w.api._writeDrain(); await tick();
    t('_writeDrain: hb_bad は送り直さない（控えに入れない）・知らせる', w.pend.length === 0 && w.toasts.length === 1 && /日付/.test(w.toasts[0]), w.toasts);
  }
  {
    const w = world({ postReply: { ok: false, error: 'サーバーで処理できませんでした' } });
    w.ctx.q().push({ action: 'addRecord', data: { record: { id: 'r1' } } });
    w.api._writeDrain(); await tick();
    t('_writeDrain: ほかの失敗は今までどおり（控えて失敗を知らせる）', JSON.stringify(w.pend) === '["addRecord"]' && w.toasts.length === 1 && /失敗/.test(w.toasts[0]));
  }
  t('帯の文は画面にある・印刷に出さない', /id="hbNoLogin" role="status" hidden>この端末はログインしていません。/.test(HTML) && /@media print\{\.hb-nologin\{display:none !important\}\}/.test(HTML));
  t('Google への本文の組み立ては変えていない（apiPost の JSON.stringify は今までと同じ）',
    /body:JSON\.stringify\(\{action:action,record:data\.record,id:data\.id,resident:data\.resident,schedule:data\.schedule,padSet:data\.padSet,cfg:data\.cfg,masterId:data\.masterId,hospitalized:data\.hospitalized,token:apiToken\|\|undefined\}\)\},30000\);/.test(SRC));
  console.log('\n合格 ' + pass + ' / 不合格 ' + fail);
  process.exit(fail ? 1 : 0);
})();
