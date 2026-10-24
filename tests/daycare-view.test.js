/* ══════════════════════════════════════════════════════════════════════
   デイ（せせらぎ）の表示の検証（2026-10-24・正本 §9.7）
   実行:  node tests/daycare-view.test.js
   ──────────────────────────────────────────────────────────────────────
   守る約束:
     1 受け渡しのキー su_daycare_handoff_v1 の読み解き（無い・壊れている・今日・今日でない）。§9.7 の形の見本の値で確かめる（care-log 側の試験も同じ値を使うとそろう）
     2 並びはふりがなの五十音（NFKC・カタカナはひらがな・無ければ氏名。読みのそろえ方は care-log の kanaSortKey と同じ。同じ読みの時はこのアプリの id 順）
     3 帯の数: n＝受け取った人数／居ない方＝表に出ない方（「対象外も表示」の時は対象外の方を表に出し、数えない）
     4 印もキーも無い端末（施設の端末）は今までと同じ対象・並び。直す前の版（c840fb1）の式と同じ結果になる
     5 キーがあっても印が無ければ施設の表示（施設の端末に care-log が書いたキーがあっても変わらない）
     6 ?view=daycare は読んだらすぐ URL から消す。?masterId= と hash は残す。今の ?view=（hist・5day）の読み方は変えない
     7 このアプリはキーを書かない・消さない（読むだけ）
     8 〔デイ せせらぎへ戻る〕の行き先は公開の URL で care-log のデイの画面
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。HAIBEN_HTML で差し替えは変異テスト用。
   ★架空データだけ。接続先は設定しない＝サーバーへは何も送らない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { makeExtractor } = require('./_extract.js');

const ROOT = path.join(__dirname, '..');
const FILE = process.env.HAIBEN_HTML || path.join(ROOT, 'haiben-record.html');
const HTML = fs.readFileSync(FILE, 'utf8');
const scriptOf = (h) => /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(h)[1];
const SRC = scriptOf(HTML);
const X = makeExtractor(SRC);
/* 直す前の最後の版（デイの表示を足す前の main）。施設の端末の対象・並びがこれと同じであることを確かめる */
const OLD_SHA = 'c840fb1';
let OLD_SRC = null;
try { OLD_SRC = scriptOf(cp.execFileSync('git', ['-C', ROOT, 'show', OLD_SHA + ':haiben-record.html'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })); } catch (e) { OLD_SRC = null; }

let pass = 0, fail = 0;
function ok(c, m, extra) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); } }
function head(t) { console.log('\n─── ' + t + ' ───'); }

/* デイの表示の関数をまとめて評価する箱。store は localStorage の中身、search・hash は URL */
const DC_FNS = ['hbDcParse', 'hbDcKana', 'hbDcCmp', 'hbDcCount', 'hbDcOn', 'hbDcKeep', 'hbDcLinkOk', 'hbDcOrder', 'hbDcListable',
  'hbDcMarkGet', 'hbDcMarkSet', 'hbDcReadParam', 'hbDcLoad', 'hbDcInit', 'hbDcBind', 'hbDcRenderBar', 'hbDcRefresh', 'hbDcOff', '_dcBackSig', 'hbDcBackNote', 'hbDcBack',
  'isExcretionTarget', 'resSortKey', 'resSortAiu', 'hbReadViewParam'];
function box(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const writes = [];
  const cls = new Set();
  const listeners = [];
  const handlers = {};
  const loc = { search: opts.search || '', pathname: '/haiben-record/haiben-record.html', hash: opts.hash || '' };
  /* 帯の部品の代役（文・警告・ボタン）。hbDcRenderBar を実際に動かして中身を確かめる */
  const els = { dcBarTxt: { textContent: '', innerHTML: '' }, dcWarn: { textContent: '', hidden: true }, dcNote: { textContent: '', hidden: true }, mConf: { classList: { contains: () => !!opts.confOpen } }, dcBack: { href: 'https://th-su.github.io/care-log/#/record/daycare', addEventListener: (ev) => listeners.push('dcBack:' + ev) }, dcOff: { addEventListener: (ev) => listeners.push('dcOff:' + ev) } };
  const calls = { rerender: 0, toast: [], confirm: [], go: [] };
  const timers = [];
  const b = {
    TODAY: opts.today || '2026-10-24',
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { if (opts.readOnly) throw new Error('QuotaExceededError'); writes.push(['set', k, String(v)]); store[k] = String(v); },
      removeItem: (k) => { writes.push(['remove', k]); delete store[k]; }
    },
    location: loc,
    history: { replaceState: (s, t, url) => { const u = new URL(url, 'https://th-su.github.io'); loc.search = u.search; loc.hash = u.hash; loc.pathname = u.pathname; } },
    URLSearchParams, URL,
    document: {
      documentElement: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } },
      addEventListener: (ev, fn) => { listeners.push('document:' + ev); handlers[ev] = fn; },
      removeEventListener: (ev, fn) => { if (handlers[ev] === fn) delete handlers[ev]; }
    },
    window: { addEventListener: (ev) => listeners.push('window:' + ev) },
    $: (id) => els[id] || null,
    showToast: (m) => calls.toast.push(m),
    hbDcRerender: () => { calls.rerender++; },
    escapeHtmlText: (x) => String(x).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'),
    fmtMD: (d) => { const p = String(d).split('-'); return parseInt(p[1], 10) + '/' + parseInt(p[2], 10); },
    _linkStateOf: (r) => (r && r.mm ? 'mismatch' : 'ok'),
    unsent: 0,
    _unsentCount: function () { return b.unsent; },
    _writeDrain: () => {},
    _writeQ: [], _pqCount: 0, _wqCurrent: null, _writeSending: false, _pqFlushing: false,
    customConfirm: (m) => { calls.confirm.push(m); return { then: (f) => f(!!opts.confirmYes) }; },
    setInterval: () => { timers.push('interval'); return 0; },
    setTimeout: (f) => { timers.push(f); return 0; },
    D: { residents: opts.residents || [] },
    console,
    isUserRes: (r) => !!r && !r.staff,
    isAttnRes: (r) => !!r.attn,
    showNonTargets: !!opts.showNonTargets,
    onlyAttn: !!opts.onlyAttn,
    store, writes, cls, listeners, handlers, loc, els, calls, timers
  };
  loc.set = (h) => calls.go.push(h);
  vm.createContext(b);
  vm.runInContext([
    X.varDecl('DC_MARK_KEY'), X.varDecl('_dc'), X.varDecl('_dcMem'), X.varDecl('_dcBound'), X.varDecl('DC_BACK_IDLE_MS'), 'var __T=1e6;Date.now=function(){return __T};',
    "Object.defineProperty(location,'href',{set:function(h){location.set(h)},get:function(){return ''}});",
    'function today(){return TODAY}',
    DC_FNS.map((n) => X.fn(n)).join('\n')
  ].join('\n'), b);
  return b;
}
const HANDOFF = 'su_daycare_handoff_v1';
const key = (o) => JSON.stringify(o);

head('1 受け渡しのキーの読み解き（§9.7 の形・care-log と同じ値）');
{
  const b = box();
  const P = (raw, td) => b.hbDcParse(raw, td || '2026-10-24');
  /* care-log が書く値と同じ形（at はミリ秒・mids は入居者マスタの id の文字列） */
  const sample = key({ v: 1, day: '2026-10-24', at: 1761292800000, mids: ['m001', 'm002', 'R-3_x'] });
  const o = P(sample);
  ok(o.st === 'ok' && o.day === '2026-10-24' && o.mids.join(',') === 'm001,m002,R-3_x' && o.badN === 0, '今日の一覧は ok・mids をそのまま受け取る', o);
  ok(P(sample, '2026-10-25').st === 'stale' && P(sample, '2026-10-25').mids.length === 3, '今日でない一覧は stale（mids は残す＝一覧を空にしない）');
  ok(P(key({ v: 1, day: '2026-10-24', mids: ['a'] })).st === 'ok', 'at が無くても受け付ける（at は読まない）');
  ok(P(null).st === 'none' && P('').st === 'none', 'キーが無い → none');
  const bad = [
    ['JSON でない', '{v:1'], ['配列', '[1,2]'], ['数', '1'], ['null', 'null'],
    ['v が 2', key({ v: 2, day: '2026-10-24', mids: [] })], ['v が文字', key({ v: '1', day: '2026-10-24', mids: [] })],
    ['day の形が違う', key({ v: 1, day: '2026/10/24', mids: [] })], ['day が無い', key({ v: 1, mids: [] })],
    ['mids が配列でない', key({ v: 1, day: '2026-10-24', mids: 'a,b' })], ['mids が多すぎる', key({ v: 1, day: '2026-10-24', mids: Array.from({ length: 1001 }, (_, i) => 'm' + i) })]
  ];
  bad.forEach(([lbl, raw]) => ok(P(raw).st === 'bad', '壊れている → bad（' + lbl + '）'));
  const mix = P(key({ v: 1, day: '2026-10-24', mids: ['a1', 'a1', ' b2 ', 7, '', null, '<x>', 'x'.repeat(33), { id: 1 }] }));
  ok(mix.st === 'ok' && mix.mids.join(',') === 'a1,b2,7' && mix.badN === 5, '重複は1つ・前後の空白は落とす・形の違う値は捨てて badN に数える', mix);
  ok(P(key({ v: 1, day: '2026-10-24', mids: [] })).st === 'ok' && P(key({ v: 1, day: '2026-10-24', mids: [] })).mids.length === 0, '空の一覧（全員休み）も ok');
}

head('2 五十音の並び（care-log の kanaSortKey と同じ）');
{
  const b = box();
  ok(b.hbDcKana({ yomi: 'ミホン', name: '見本' }) === 'みほん', 'カタカナはひらがなにそろえる');
  ok(b.hbDcKana({ yomi: 'ｶｸｳ', name: '架空' }) === 'かくう', '半角カナは NFKC でそろえてからひらがな');
  ok(b.hbDcKana({ yomi: '  ', name: ' 架空 ' }) === '架空' && b.hbDcKana({ name: '架空' }) === '架空', 'ふりがなが無い・空白だけの時は氏名');
  ok(b.hbDcKana({ yomi: 'ヴィ' }) === 'ゔぃ' && b.hbDcKana({ yomi: 'ヶ' }) === 'ゖ', 'ァ〜ヶ の範囲をひらがなへ');
  const arr = [{ id: 3, yomi: 'カ' }, { id: 1, yomi: 'あ' }, { id: 2, yomi: 'か' }, { id: 9, yomi: '', name: 'さ' }];
  ok(arr.slice().sort(b.hbDcCmp).map((r) => r.id).join(',') === '1,2,3,9', '同じ読みは id の小さい順（カタカナとひらがなは同じ読み）');
}

head('3 帯の数（n＝受け取った人数・居ない方＝表に出ない方）');
{
  const RES = [
    { id: 1, name: '架空一', masterId: 'm1' },
    { id: 2, name: '架空二', masterId: 'm2', targetExcretion: false },
    { id: 3, name: '架空三', masterId: 'm3', active: false },
    { id: 4, name: '架空四', masterId: 'm4', hidden: true },
    { id: 5, name: '架空五', masterId: 5 }
  ];
  const dc = { mids: ['m1', 'm2', 'm3', 'm4', '5', 'm9'], badN: 1 };
  const b = box();
  let c = b.hbDcCount(RES, dc, b.hbDcListable);
  ok(c.n === 7 && c.shown === 2 && c.miss === 5, '対象外・退去・隠した・結べない・形の違う値は「居ない方」（masterId は文字列で比べる）', c);
  const b2 = box({ showNonTargets: true });
  c = b2.hbDcCount(RES, dc, b2.hbDcListable);
  ok(c.n === 7 && c.shown === 3 && c.miss === 4, '「対象外も表示」の時は対象外の方を表に出し、居ない方に数えない（親の補足 1）', c);
}

head('4 施設の端末（印もキーも無い）は今までと同じ対象・並び');
const RES = [
  { id: 10, name: '架空Ａ', yomi: 'ワヲン', room: '305', masterId: 'm10' },
  { id: 11, name: '架空Ｂ', yomi: 'あいう', room: '101', masterId: 'm11' },
  { id: 12, name: '架空Ｃ', yomi: 'ｲﾛﾊ', room: '201', masterId: 'm12' },
  { id: 13, name: '架空Ｄ', yomi: '', room: '102', masterId: 'm13', attn: true },
  { id: 14, name: '架空Ｅ', yomi: 'かきく', room: '202' },
  { id: 15, name: '架空Ｆ', yomi: 'さしす', room: '203', masterId: 'm15', targetExcretion: false },
  { id: 16, name: '架空Ｇ', yomi: 'たちつ', room: '204', masterId: 'm16', hidden: true },
  { id: 17, name: '架空Ｈ', yomi: 'なにぬ', room: '205', masterId: 'm17', active: false },
  { id: 18, name: '職員の控え', room: '', staff: true, masterId: 'm18' },
  { id: 19, name: '架空Ｉ', yomi: 'カキク', room: '103', masterId: 'm19', attn: true }
];
/* render の中の対象・並びの式だけを取り出す（一覧・時系列は const res=…;、入力は const a=…sort(resSortAiu)…;） */
function exprOf(src, fn, re) {
  const body = makeExtractor(src).fn(fn);
  const m = re.exec(body);
  if (!m) throw new Error(fn + ' の式が見つかりません');
  return m[0];
}
const RE_RES = /const res=[^\n]*;/;
const RE_A = /const a=[\s\S]*?\.sort\(resSortAiu\)\)?;/;
function run(b, expr, name, date, ciRid) {
  vm.runInContext('var D={residents:' + JSON.stringify(RES) + '};var ci={rid:' + JSON.stringify(ciRid == null ? null : ciRid) + '};var date=' + JSON.stringify(date || '2026-10-24') + ';', b);
  return vm.runInContext('(function(){' + expr + 'return ' + name + '.map(function(r){return r.id}).join(",")})()', b);
}
{
  ok(!!OLD_SRC, '直す前の版（' + OLD_SHA + '）を git から取り出せた');
  if (OLD_SRC) {
    const cases = [['renderTL', RE_RES, 'res'], ['renderBoard', RE_RES, 'res'], ['buildResSel', RE_A, 'a']];
    for (const [fn, re, name] of cases) {
      const oldE = exprOf(OLD_SRC, fn, re), newE = exprOf(SRC, fn, re);
      for (const flags of [{}, { onlyAttn: true }, { showNonTargets: true }, { onlyAttn: true, showNonTargets: true }]) {
        for (const ciRid of [null, 15]) {
          const b = box(flags);
          const o = run(b, oldE, name, null, ciRid), n = run(b, newE, name, null, ciRid);
          ok(o === n && b._dc === null, fn + ' ' + JSON.stringify(flags) + ' 選択中=' + ciRid + ': 直す前と同じ（' + n + '）', { old: o, new: n });
        }
      }
    }
  }
  /* キーがあっても印が無ければ施設の表示（care-log が書いたキーが施設の端末に残っていても変わらない） */
  const b = box({ store: { [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m11', 'm12'] }) } });
  const fromUrl = b.hbDcInit();
  ok(fromUrl === false && b._dc === null && !b.cls.has('hb-daycare'), 'キーがあっても印が無ければデイの表示にしない（_dc は null・html の印なし）');
  ok(b.writes.length === 0 && b.listeners.length === 0, '施設の端末では何も書かず、待ち受けも付けない', { writes: b.writes, listeners: b.listeners });
  const arr = [{ id: 1 }, { id: 2 }];
  ok(b.hbDcOrder(arr) === arr && b.hbDcKeep({ id: 1 }) === true && b.hbDcKeep(null) === true && b.hbDcOn() === false, '素通し: hbDcOrder は同じ配列をそのまま返し、hbDcKeep は常に true');
}

head('5 デイの表示（印＋今日のキー）');
{
  const store = { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', at: 1, mids: ['m10', 'm11', 'm12', 'm13', 'm15', 'm16', 'm19', 'm99'] }) };
  const b = box({ store });
  b.hbDcInit();
  ok(b._dc && b._dc.st === 'ok' && b.hbDcOn() && b.cls.has('hb-daycare'), '印とキーがあればデイの表示（html に hb-daycare）');
  ok(b.listeners.indexOf('document:visibilitychange') >= 0 && b.listeners.indexOf('window:focus') >= 0 && b.listeners.indexOf('window:pageshow') >= 0, '画面が前に出るたびにキーを読み直す（visibilitychange・focus・pageshow）', b.listeners);
  const tl = run(b, exprOf(SRC, 'renderTL', RE_RES), 'res');
  ok(tl === '11,12,19,10,13', '時系列: デイの方だけ・五十音（あいう・いろは・かきく・わをん・架空Ｄ（ふりがな無し＝氏名・漢字はかなの後））。対象外・隠した方は出ない', tl);
  ok(run(b, exprOf(SRC, 'renderBoard', RE_RES), 'res') === tl, '一覧表も同じ対象・並び');
  ok(run(b, exprOf(SRC, 'buildResSel', RE_A), 'a') === tl, '入力の選択肢も同じ対象・並び');
  ok(run(b, exprOf(SRC, 'buildResSel', RE_A), 'a', null, 14) === '11,12,14,19,10,13', '選んでいる方（デイの方でない）は今の決まりどおり選択肢に残す（?masterId= で開いた方を選べる）');
  vm.runInContext('onlyAttn=true', b);
  ok(run(b, exprOf(SRC, 'renderTL', RE_RES), 'res') === '19,13', '「要注意だけ」はデイの方の中で効く');
  vm.runInContext('onlyAttn=false;showNonTargets=true', b);
  ok(run(b, exprOf(SRC, 'renderTL', RE_RES), 'res') === '11,12,19,15,10,13', '「対象外も表示」はデイの方の中の対象外の方を出す');
  /* 中身が同じなら描き直さない・変われば描き直す */
  ok(b.hbDcLoad() === false, '同じキーを読み直しても「変わった」にしない（押している最中に表を差し替えない）');
  b.store[HANDOFF] = key({ v: 1, day: '2026-10-24', mids: ['m10'] });
  ok(b.hbDcLoad() === true && b._dc.mids.join(',') === 'm10', 'キーが変われば読み直して描き直す');
  vm.runInContext('TODAY="2026-10-25"', b);
  ok(b.hbDcLoad() === true && b._dc.st === 'stale' && b.hbDcOn() && run(b, exprOf(SRC, 'renderTL', RE_RES), 'res', '2026-10-25') === '10', '日付が変わると stale（警告を出し、一覧は空にせず mids で絞り続ける）');
}

head('6 キーが無い・壊れている時（印はある）');
{
  for (const [lbl, raw] of [['無い', undefined], ['壊れている', '{oops']]) {
    const store = { hbcr_daycare: '1' };
    if (raw !== undefined) store[HANDOFF] = raw;
    const b = box({ store });
    b.hbDcInit();
    ok(b._dc && (b._dc.st === 'none' || b._dc.st === 'bad') && !b.hbDcOn() && b.cls.has('hb-daycare'), lbl + ': 帯は出す（1行）が絞り込まない＝施設の表示');
    const o = run(b, exprOf(SRC, 'renderTL', RE_RES), 'res');
    vm.runInContext('_dc=null', b);
    ok(o === run(b, exprOf(SRC, 'renderTL', RE_RES), 'res'), lbl + ': 対象・並びは施設の端末と同じ', o);
  }
  const src = X.fn('hbDcRenderBar');
  ok(/デイの一覧がこの端末にありません/.test(src) && /デイの一覧を読めませんでした/.test(src) && /いまは施設の表示です/.test(src), '無い・壊れているの文言');
  ok(/デイの一覧が今日のものではありません。デイ せせらぎから開き直してください/.test(src), '今日でない時の文言は §9.7 のとおり');
  ok(/排泄ケア記録に居ない方 '\+c\.miss\+'名/.test(src) && !/r\.name|\.yomi/.test(src), '結べない方は数だけ（帯に氏名を出さない）');
}

head('7 ?view=daycare の読み方（読んだらすぐ URL から消す・親の補足 2）');
{
  let b = box({ search: '?view=daycare', hash: '#cfg=x' });
  ok(b.hbDcInit() === true && b.store.hbcr_daycare === '1', '?view=daycare で印を付ける');
  ok(b.loc.search === '' && b.loc.hash === '#cfg=x', 'URL から view だけを消す（接続先の救済の hash は残す）', b.loc);
  b = box({ search: '?view=daycare&masterId=m11' });
  ok(b.hbDcInit() === true && b.loc.search === '?masterId=m11' && b.hbReadViewParam() === '', '?masterId= は残し、今の入口が読む（view は消えているので履歴を開くと取り違えない）', b.loc);
  for (const s of ['?view=hist&masterId=m1', '?view=5day&masterId=m1', '?masterId=m1', '', '?view=Daycare']) {
    b = box({ search: s });
    ok(b.hbDcInit() === false && b.loc.search === s && b.writes.length === 0 && b._dc === null, 'デイの指定でない URL は触らない（' + (s || '空') + '）');
  }
  ok(box({ search: '?view=hist' }).hbReadViewParam() === 'hist' && box({ search: '?view=5day' }).hbReadViewParam() === '5day' && box({ search: '?view=daycare' }).hbReadViewParam() === '', '今の ?view=（hist・5day）の読み方は変えていない');
  b = box({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: [] }) } });
  b.hbDcInit(); b.hbDcMarkSet(false); b.hbDcLoad();
  ok(b._dc === null && !b.cls.has('hb-daycare') && b.store[HANDOFF] !== undefined, '〔施設の表示に戻す〕は自分の印だけを消す（キーは残す）');
  b = box({ store: { hbcr_daycare: 'yes', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m11'] }) } });
  ok(b.hbDcInit() === false && b._dc === null, '印は既知の値（"1"）だけを受け付ける');
}

head('8 書かない・戻り先・つなぎ込み');
{
  const writesKey = /(setItem|removeItem)\(\s*(DC_HANDOFF_KEY|['"]su_daycare_handoff_v1['"])/.test(SRC);
  ok(!writesKey && (SRC.match(/su_daycare_handoff_v1/g) || []).length >= 1, 'このアプリはキーを書かない・消さない（読むだけ）');
  ok(/DC_HANDOFF_KEY='su_daycare_handoff_v1'/.test(X.varDecl('DC_MARK_KEY')) && /DC_MARK_KEY='hbcr_daycare'/.test(X.varDecl('DC_MARK_KEY')), 'キーの名前は §9.7 のとおり・印は hbcr_ で始まる');
  const m = /<a id="dcBack" href="([^"]+)">デイ せせらぎへ戻る<\/a>/.exec(HTML);
  ok(!!m && new URL(m[1], 'https://th-su.github.io/haiben-record/haiben-record.html').href === 'https://th-su.github.io/care-log/#/record/daycare', '〔デイ せせらぎへ戻る〕は同じタブで care-log のデイの画面（公開の URL に解いて確かめる）', m && m[1]);
  ok(/<button type="button" id="dcOff">施設の表示に戻す<\/button>/.test(HTML), '〔施設の表示に戻す〕がある');
  ok(/hbDcKeep\(re\)&&tlOvdForRes/.test(X.fn('tlOvdRefresh')), '1分ごとの更新も同じ対象で判定する（要注意だけの時に毎分描き直さない）');
  ok(/if\(hbDcOn\(\)\)hbDcScrollDay\(\)/.test(X.fn('showSc')) && /tlCompact\)return/.test(X.fn('hbDcScrollDay')) && /hr-top'\)\[8\]/.test(X.fn('hbDcScrollDay')), '時系列を開くと 8:30 の位置へ送る（全体表示は送らない）');
  const init = X.fn('_initRest');
  ok(init.indexOf('_dcFromUrl=hbDcInit()') >= 0 && init.indexOf('_dcFromUrl=hbDcInit()') < init.indexOf('buildResSel()') && init.indexOf('restoreSc()') < init.indexOf("showSc('tl')") && init.indexOf("showSc('tl')") < init.indexOf('hbApplyMasterIdParam()'), '起動の順: デイの判定 → 最初の描画 → 画面の復元 → ?view=daycare なら時系列 → ?masterId=');
  ok(/\$\('dcBar'\)\]\.concat/.test(X.fn('_fitScrollBox')) && /if\(dc&&dc\.offsetParent\)\{/.test(X.fn('layoutStickyTops')) && /if\(dcFit\)t\+=dc\.offsetHeight/.test(X.fn('layoutStickyTops')), '貼り付く位置と表の高さの計算に帯を足す（出ていない時は数えない）');
  ok(/dc\.style\.position=dcFit\?'':'static'/.test(X.fn('layoutStickyTops')) && /_boxFloor\(abox\)/.test(X.fn('layoutStickyTops')), '表に見出しと1行も残らない時は帯を貼り付けない（日付の操作バーと同じ判定）');
  ok(/\.dcbar\{display:none\}/.test(HTML) && /html\.hb-daycare \.dcbar\{position:sticky/.test(HTML) && /@media print\{\.dcbar\{display:none !important\}\}/.test(HTML), '帯は印のある端末だけに出し、印刷には出さない');
}


head('9 帯の文（hbDcRenderBar を動かす）');
{
  const RES9 = [{ id: 1, name: '架空一', masterId: 'm1' }, { id: 2, name: '架空二', masterId: 'm2' }, { id: 3, name: '架空三', masterId: 'm3', targetExcretion: false }];
  const mk = (store, o) => { const b = box(Object.assign({ store, residents: RES9 }, o || {})); b.hbDcInit(); b.hbDcRenderBar(); return b; };
  let b = mk({ hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2', 'm3', 'm9'] }) });
  ok(/デイ せせらぎ<\/b>　今日 4名　<span class="dc-miss">排泄ケア記録に居ない方 2名<\/span>/.test(b.els.dcBarTxt.innerHTML) && b.els.dcWarn.hidden === true, '今日: 「今日 4名・排泄ケア記録に居ない方 2名」（対象外と結べない方）・警告なし', b.els.dcBarTxt.innerHTML);
  ok(!/架空/.test(b.els.dcBarTxt.innerHTML), '帯に氏名を出さない');
  b = mk({ hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2', 'm3'] }) }, { showNonTargets: true });
  ok(/今日 3名/.test(b.els.dcBarTxt.innerHTML) && !/居ない方/.test(b.els.dcBarTxt.innerHTML), '「対象外も表示」の時は対象外の方を数えない（全員出ている時は「居ない方」を出さない）', b.els.dcBarTxt.innerHTML);
  b = mk({ hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-23', mids: ['m1'] }) });
  ok(/10\/23 1名/.test(b.els.dcBarTxt.innerHTML) && b.els.dcWarn.hidden === false && b.els.dcWarn.textContent.indexOf('デイの一覧が今日のものではありません。デイ せせらぎから開き直してください') >= 0 && /施設の端末では〔施設の表示に戻す〕を押してください/.test(b.els.dcWarn.textContent), '今日でない: 一覧の日付と、§9.7 の警告＋施設の端末向けの出口', [b.els.dcBarTxt.innerHTML, b.els.dcWarn.textContent]);
  b = mk({ hbcr_daycare: '1' });
  ok(/デイの一覧がこの端末にありません/.test(b.els.dcBarTxt.innerHTML) && /いまは施設の表示です/.test(b.els.dcBarTxt.innerHTML) && b.els.dcWarn.hidden === true, 'キーなし: 1行（施設の表示）');
  b = mk({ hbcr_daycare: '1', [HANDOFF]: '{oops' });
  ok(/デイの一覧を読めませんでした/.test(b.els.dcBarTxt.innerHTML) && b.els.dcWarn.hidden === true, '壊れたキー: 1行（施設の表示）');
  { // 同じ文なら書き直さない（帯は読み上げの対象。1分ごとの読み直しで毎分読ませない）
    const bb = box({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-23', mids: ['m1'] }) }, residents: RES9 });
    let nT = 0, nW = 0, vT = '', vW = '';
    bb.els.dcBarTxt = { get innerHTML() { return vT; }, set innerHTML(v) { nT++; vT = v; }, textContent: '' };
    bb.els.dcWarn = { get textContent() { return vW; }, set textContent(v) { nW++; vW = v; }, hidden: true };
    bb.hbDcInit(); bb.hbDcRenderBar(); bb.hbDcRenderBar(); bb.hbDcRefresh(); bb.hbDcRenderBar();
    ok(nT === 1 && nW === 1 && /10\/23/.test(vT), '同じ文なら帯の文・警告を書き直さない（4回描いても1回だけ書く）', { nT, nW });
  }
  b = box({ store: {}, residents: RES9 }); b.hbDcRenderBar();
  ok(b.els.dcBarTxt.textContent === '' && b.els.dcWarn.hidden === true, '施設の端末: 帯の文は空（CSS で帯も出ない）');
}

head('10 紐づけがずれている方（mismatch）はデイの方として出さない');
{
  const R = [{ id: 1, name: '架空一', masterId: 'm1' }, { id: 2, name: '架空二', masterId: 'm2', mm: true }];
  const b = box({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2'] }) }, residents: R });
  b.hbDcInit();
  ok(b.hbDcKeep(R[0]) === true && b.hbDcKeep(R[1]) === false, 'masterId は一致しても、紐づけが別人を指す行は出さない');
  const c = b.hbDcCount(R, b._dc, b.hbDcListable);
  ok(c.n === 2 && c.shown === 1 && c.miss === 1, 'その方は「居ない方」に数える', c);
  vm.runInContext('_linkStateOf=function(){throw new Error("x")}', b);
  ok(b.hbDcKeep(R[1]) === true, '判定できない時は ?masterId= の入口と同じく信じる');
  const f = box({ residents: R }); f.hbDcInit();
  ok(f.hbDcKeep(R[1]) === true, '施設の端末では今までどおり（判定しない）');
}

head('11 〔施設の表示に戻す〕・読み直し（関数を動かす）');
{
  const store = { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1'] }) };
  let b = box({ store });
  b.hbDcInit();
  ok(b.listeners.indexOf('dcOff:click') >= 0 && b.listeners.indexOf('dcBack:click') >= 0 && b.timers.indexOf('interval') >= 0, 'ボタン2つの待ち受けと、日付をまたいだ時の1分ごとの読み直しを付ける', [b.listeners, b.timers.length]);
  b.hbDcRefresh();
  ok(b.calls.rerender === 0, '中身が同じなら描き直さない');
  b.store[HANDOFF] = key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2'] });
  b.hbDcRefresh();
  ok(b.calls.rerender === 1, 'キーが変われば描き直す');
  vm.runInContext('TODAY="2026-10-25"', b);
  b.hbDcRefresh();
  ok(b.calls.rerender === 2 && b._dc.st === 'stale', '日付をまたぐと（1分ごとの読み直しで）今日でない扱いにして描き直す');
  b.hbDcOff();
  ok(b._dc === null && b.store.hbcr_daycare === undefined && b.store[HANDOFF] !== undefined && b.calls.rerender === 3 && !b.cls.has('hb-daycare') && /施設の表示に戻しました/.test(b.calls.toast.join()), '〔施設の表示に戻す〕: 自分の印だけ消し、施設の表示で描き直す（キーは残す）');
  b.hbDcRefresh();
  ok(b.calls.rerender === 3 && b._dc === null, '戻した後の読み直しは何もしない');
  const f = box({ store: { [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1'] }) } });
  f.hbDcInit(); f.hbDcRefresh();
  ok(f._dc === null && f.calls.rerender === 0 && f.writes.length === 0, '施設の端末（キーだけ）: 読み直しても何も変えない');
}

head('12 〔デイ せせらぎへ戻る〕は送り終えてから移る（関数を動かす）');
{
  const store = { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1'] }) };
  const mk = (o) => { const b = box(Object.assign({ store: Object.assign({}, store) }, o || {})); b.hbDcInit(); return b; };
  const T = (b, t) => vm.runInContext('__T=' + t, b);
  const tick = (b) => { const f = b.timers.filter((x) => typeof x === 'function').pop(); b.timers.length = 0; if (f) f(); return !!f; };
  let prevented = false;
  const ev = { preventDefault: () => { prevented = true; } };
  let b = mk();
  b.unsent = 0; b.hbDcBack(ev);
  ok(!prevented && b.calls.go.length === 0, '送信待ちが無ければリンクのまま（止めない）');
  b.unsent = 2; prevented = false; b.hbDcBack(ev);
  ok(prevented && /記録を送っています（2件）/.test(b.els.dcNote.textContent) && b.els.dcNote.hidden === false && typeof b.handlers.pointerdown === 'function', '送信待ちがあれば止めて、帯に「送っています」を出し続ける（ほかを押したらやめる待ち受け）', b.els.dcNote.textContent);
  const tok = b._dcBackTok; b.hbDcBack(ev);
  ok(b._dcBackTok === tok && b.calls.go.length === 0, '待っている間にもう一度押しても二重に動かない');
  b.unsent = 0; tick(b);
  ok(b.calls.go.length === 1 && /care-log\/#\/record\/daycare$/.test(b.calls.go[0]) && b.els.dcNote.hidden === true && !b.handlers.pointerdown, '送り終えたら care-log のデイの画面へ移る（帯の「送っています」と待ち受けは外す）', b.calls.go);
  // ほかを押したらやめる
  b = mk(); b.unsent = 2; b.hbDcBack(ev);
  b.handlers.pointerdown({ target: { closest: () => null } });
  b.unsent = 0; tick(b);
  ok(b.calls.go.length === 0 && /戻るのをやめました/.test(b.calls.toast.join()) && b.els.dcNote.hidden === true && b._dcBackBusy === false, 'ほかを押すと待つのをやめ、数秒後に勝手に移らない');
  b = mk(); b.unsent = 2; b.hbDcBack(ev);
  b.handlers.pointerdown({ target: { closest: (q) => (q === '#dcBack' ? {} : null) } });
  b.unsent = 0; tick(b);
  ok(b.calls.go.length === 1, '〔戻る〕をもう一度押しただけではやめない');
  // 〔施設の表示に戻す〕を押したらやめる
  b = mk(); b.unsent = 2; b.hbDcBack(ev); b.hbDcOff(); b.unsent = 0; tick(b);
  ok(b.calls.go.length === 0 && b.els.dcNote.hidden === true, '待っている間に〔施設の表示に戻す〕を押したら移らない');
  // 送っている最中は待ち続ける・進まなくなったら確かめる
  b = mk(); T(b, 0); vm.runInContext('_writeSending=true', b); b.unsent = 2; b.hbDcBack(ev);
  T(b, 20000); tick(b);
  ok(b.calls.confirm.length === 0 && b.timers.length > 0, '送っている最中（GAS の待ち）は 8秒を過ぎても待ち続ける');
  vm.runInContext('_writeSending=false', b); T(b, 20500); tick(b); T(b, 29000); tick(b);
  ok(b.calls.confirm.length === 1 && /まだ送れていない記録が 2 件あります/.test(b.calls.confirm[0]) && /施設の画面に出るのは、この端末で次に排泄ケア記録を開いて送り終えた時です/.test(b.calls.confirm[0]) && !b.handlers.pointerdown, '進まないまま 8秒たったら、遅れることを書いて確かめる（小窓のボタンでやめにならないよう待ち受けを外す）', b.calls.confirm);
  ok(b.calls.go.length === 0 && b._dcBackBusy === false, '「キャンセル」なら移らない');
  b = mk({ confirmYes: true }); T(b, 0); b.unsent = 1; b.hbDcBack(ev); T(b, 9000); tick(b);
  ok(b.calls.go.length === 1, '「実行する」なら移る');
  b = mk(); T(b, 0); vm.runInContext('_writeSending=true', b); b.unsent = 1; b.hbDcBack(ev); T(b, 46000); tick(b);
  ok(b.calls.confirm.length === 1, '送っている最中でも最長 45秒で確かめる');
  b = mk(); T(b, 0); b.unsent = 1; b.hbDcBack(ev); T(b, 2000); vm.runInContext('_pqCount=3', b); tick(b); T(b, 9000); tick(b);
  ok(b.calls.confirm.length === 0, '件数が動いていれば（進んでいる）待ち続ける');
  b = mk({ confOpen: true }); T(b, 0); b.unsent = 1; b.hbDcBack(ev); T(b, 9000); tick(b);
  ok(b.calls.confirm.length === 0 && b.timers.length > 0, 'ほかの確かめの小窓が開いている間は確かめを出さずに待つ');
}

head('13 印を端末に書けない時（?view=daycare）');
{
  const b = box({ search: '?view=daycare', readOnly: true, store: { [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1'] }) } });
  ok(b.hbDcInit() === true && b.hbDcOn() === true && b._dcMem === true, '書けなくても、この画面の間はデイの表示にする');
  b.hbDcRenderBar();
  ok(/印を残せませんでした/.test(b.els.dcWarn.textContent) && b.els.dcWarn.hidden === false, '帯に「印を残せませんでした」を出す');
  b.hbDcOff();
  ok(b._dc === null && b._dcMem === false, '〔施設の表示に戻す〕で、この画面の印も消す');
}

head('14 入力のタイル（renderResTiles）: 施設の端末は直す前と同じ・デイは1つのまとまり');
{
  const LIST = [
    { id: 1, name: '架空一', room: '201', yomi: 'さ' }, { id: 2, name: '架空二', room: '101', yomi: 'か' },
    { id: 3, name: '架空三', room: '１０５', yomi: 'あ' }, { id: 4, name: '架空四', room: '', yomi: 'た' }, { id: 5, name: '架空五', room: '202', yomi: 'な' }
  ];
  function tiles(src, dcOn) {
    const XX = makeExtractor(src);
    const elsT = { resTiles: { innerHTML: '' } };
    const sb = {
      $: (id) => elsT[id] || null, escapeHtmlText: (x) => String(x), syncResPick: () => {},
      lastR: (rid, t) => (rid % 2 ? { date: '2026-10-22' } : null), elH: () => 30, badgeCls: (h, t, rid) => (rid === 3 ? 'eb-ng' : 'eb-ok'),
      dayDiff: (a, b2) => 2, today: () => '2026-10-24', padSetFor: (r) => ({ list: r.id === 2 ? [{ n: '見本パッド' }] : [] }), Date,
      hbDcOn: () => dcOn, DC_EMPTY_MSG: 'EMPTY'
    };
    vm.createContext(sb);
    vm.runInContext(['_roomNum', 'roomToFloor', 'floorLabel', 'renderResTiles'].map((n) => XX.fn(n)).join('\n'), sb);
    sb.renderResTiles(LIST.slice());
    const empty = (sb.renderResTiles([]), elsT.resTiles.innerHTML);
    sb.renderResTiles(LIST.slice());
    return { html: elsT.resTiles.innerHTML, empty };
  }
  ok(!!OLD_SRC, '直す前の版がある');
  if (OLD_SRC) {
    const o = tiles(OLD_SRC, false), n = tiles(SRC, false);
    ok(o.html === n.html && o.empty === n.empty && /1階/.test(n.html) && /2階/.test(n.html), '施設の端末: タイルの中身（階ごとのまとまり・空の時の文）が直す前と同じ');
  }
  const d = tiles(SRC, true);
  ok((d.html.match(/class="rt-fl"/g) || []).length === 1 && /デイ せせらぎ（五十音順）/.test(d.html) && d.empty.indexOf('EMPTY') >= 0, 'デイ: 階に分けず1つのまとまり。空の時はデイ向けの文');
  const order = (d.html.match(/data-rid="(\d+)"/g) || []).map((x) => x.replace(/\D/g, '')).join(',');
  ok(order === '1,2,3,4,5', 'デイ: 受け取った並び（五十音に並べた後の順）のまま', order);
}


head('15 帯の貼り付け（layoutStickyTops を寸法の代役で動かす）');
{
  function lay(vh, dcShown) {
    const dc = { style: {}, offsetParent: dcShown ? {} : null, offsetHeight: 60 };
    const fb = { style: {}, offsetParent: null, offsetHeight: 0 };
    const box9 = {};
    const ah = { offsetHeight: 50, parentElement: { querySelector: () => box9 } };
    const sb = {
      document: { querySelector: (q) => (q === '.hdr' ? { offsetHeight: 76 } : q === '.scr.on .bd-hdr' ? ah : null) },
      $: (id) => (id === 'fromMaster' ? fb : id === 'dcBar' ? dc : null), $$: () => [],
      _smallVh: () => vh, _boxBelow: () => 80, _boxFloor: () => 120
    };
    vm.createContext(sb);
    vm.runInContext(X.fn('layoutStickyTops'), sb);
    sb.layoutStickyTops();
    return dc.style;
  }
  const tall = lay(820, true), low = lay(360, true), off = lay(820, false), edge = lay(390, true);
  ok(tall.position === '' && tall.top === '76px', 'タブレットの高さ: ヘッダの下に貼り付ける', tall);
  ok(low.position === 'static' && low.top === '', '低い画面（表に見出しと1行が残らない）: 貼り付けない', low);
  ok(edge.position === '', 'ちょうど見出し＋1行が残る高さ（390）では貼り付ける（境目は日付の操作バーと同じ「以上」）', edge);
  ok(off.position === undefined && off.top === undefined, '帯が出ていない端末（施設）: 帯に何も書かない', off);
}

console.log('\n══════════════════════════════════');
console.log('  合格 ' + pass + ' / 不合格 ' + fail);
process.exit(fail ? 1 : 0);
