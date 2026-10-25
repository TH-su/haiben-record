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
const { makeExtractor, matchBrace } = require('./_extract.js');

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
const PENDING = [];
function ok(c, m, extra) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); } }
function head(t) { console.log('\n─── ' + t + ' ───'); }

/* デイの表示の関数をまとめて評価する箱。store は localStorage の中身、search・hash は URL */
const DC_FNS = ['hbDcParse', 'hbDcKana', 'hbDcCmp', 'hbDcCount', 'hbDcOn', 'hbDcKeep', 'hbDcLinkOk', 'hbDcOrder', 'hbDcListable',
  'hbDcMarkGet', 'hbDcMarkSet', 'hbDcReadParam', 'hbDcLoad', 'hbDcInit', 'hbDcBind', 'hbDcRenderBar', 'hbDcRefresh', 'hbDcOff', '_dcBackSig', 'hbDcBackNote', 'hbDcBack',
  'hbIsDayOnly', 'isExcretionTarget', 'hbDayOnlyEff', 'hbListTarget', 'hbDcTag', 'resSortKey', 'resSortAiu', 'hbReadViewParam'];
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
    customConfirm: (m) => { calls.confirm.push(m); if (opts.onConfirm) opts.onConfirm(b); return { then: (f) => f(!!opts.confirmYes) }; },
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
  ok(tl === '11,12,19,15,10,13', '時系列: デイの方だけ・五十音（あいう・いろは・かきく・さしす・わをん・架空Ｄ（ふりがな無し＝氏名・漢字はかなの後））。施設では対象外の方も出る（B1）・隠した方は出ない', tl);
  ok(run(b, exprOf(SRC, 'renderBoard', RE_RES), 'res') === tl, '一覧表も同じ対象・並び');
  ok(run(b, exprOf(SRC, 'buildResSel', RE_A), 'a') === tl, '入力の選択肢も同じ対象・並び');
  ok(run(b, exprOf(SRC, 'buildResSel', RE_A), 'a', null, 14) === '11,12,14,19,15,10,13', '選んでいる方（デイの方でない）は今の決まりどおり選択肢に残す（?masterId= で開いた方を選べる）');
  vm.runInContext('onlyAttn=true', b);
  ok(run(b, exprOf(SRC, 'renderTL', RE_RES), 'res') === '19,13', '「要注意だけ」はデイの方の中で効く');
  vm.runInContext('onlyAttn=false;showNonTargets=true', b);
  ok(run(b, exprOf(SRC, 'renderTL', RE_RES), 'res') === '11,12,19,15,10,13', '「対象外も表示」を入れても同じ（デイの表示では対象外の方もいつも出る・B1）');
  ok(b.hbDcTag(RES.find((r) => r.id === 15)) === '施設では対象外' && b.hbDcTag(RES.find((r) => r.id === 11)) === '', 'デイの表示の中の施設では対象外の方には「施設では対象外」の札（日数の判定を出さない）');
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
  ok(/デイ せせらぎ<\/b>　今日 4名　<span class="dc-miss">排泄ケア記録に居ない方 1名<\/span>/.test(b.els.dcBarTxt.innerHTML) && b.els.dcWarn.hidden === true, '今日: 「今日 4名・排泄ケア記録に居ない方 1名」（結べない方。施設では対象外の方は表に出るので数えない・B1）・警告なし', b.els.dcBarTxt.innerHTML);
  ok(!/架空/.test(b.els.dcBarTxt.innerHTML), '帯に氏名を出さない');
  b = mk({ hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2', 'm3'] }) }, { showNonTargets: true });
  ok(/今日 3名/.test(b.els.dcBarTxt.innerHTML) && !/居ない方/.test(b.els.dcBarTxt.innerHTML), '全員出ている時は「居ない方」を出さない（対象外の方も表に出る）', b.els.dcBarTxt.innerHTML);
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
      hbDcOn: () => dcOn, DC_EMPTY_MSG: 'EMPTY', hbDcTag: (r) => (r.dOnly ? 'デイのみ' : '')
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
  LIST[1].dOnly = true;
  const d2 = tiles(SRC, true);
  ok(/data-rid="2">[\s\S]*?<span class="rt-s rt-dc">デイのみ<\/span>/.test(d2.html) && !/data-rid="2">[\s\S]*?便\d+日[\s\S]*?data-rid="3"/.test(d2.html), 'デイだけの方のタイルは「便N日」の代わりに「デイのみ」（§9.9）');
  delete LIST[1].dOnly;
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


/* ══════════ (3) デイだけの方（2026-10-25・§9.9） ══════════ */
const DO_FNS = DC_FNS.concat(['_normName', '_normNameX', '_hbDcRoomKey', 'hbDcAddEnabled', 'hbDcMissing', 'hbDcMissFind', 'hbDcMissRender', 'hbDcAdd']);
/* 氏名の異体字の表（複数行の宣言）を括弧の対応で切り出す */
const NAMEX_DECL = (() => { const i = SRC.indexOf('var _NAMEX_MAP='); const o = SRC.indexOf('{', i); return SRC.slice(i, matchBrace(SRC, o) + 1) + ';'; })();
function boxDO(opts) {
  const b = box(opts);
  Object.assign(b, { apiUrl: opts && opts.apiUrl || '', _getLastSyncTs: () => (opts && opts.lastSync != null ? opts.lastSync : 1), ldShow() {}, ldHide() {}, syncFromAPI: async () => (opts && opts.onSync ? opts.onSync(b) : true) });
  vm.runInContext([NAMEX_DECL, X.varDecl('_dcAddBusy'), X.varDecl('DC_ADD_OFF_MSG'), ['_normName', '_normNameX', '_hbDcRoomKey', 'hbDcAddEnabled', 'hbDcMissing', 'hbDcMissFind', 'hbDcMissRender', 'hbDcAdd'].map((n) => X.fn(n)).join('\n')].join('\n'), b);
  if (!(opts && opts.addOff)) b.D.cfg = { dayOnlyOn: 1 };
  return b;
}
const DOR = (o) => Object.assign({ cfg: { dayOnly: true } }, o);

head('16 施設の対象（isExcretionTarget）: デイだけの方は targetExcretion===true の時だけ・ほかの方は前と同じ');
{
  const b = box();
  const oldBox = { console };
  vm.createContext(oldBox);
  if (OLD_SRC) vm.runInContext(makeExtractor(OLD_SRC).fn('isExcretionTarget'), oldBox);
  const plain = [null, {}, { targetExcretion: true }, { targetExcretion: false }, { cfg: { stoolWarnD: 2 } }, { cfg: '' }, { cfg: { dayOnly: false } }, { cfg: { dayOnly: 'true' } }];
  ok(!!OLD_SRC && plain.every((r) => b.isExcretionTarget(r) === oldBox.isExcretionTarget(r)), 'dayOnly が無い方（null・未設定・true・false・閾値だけ・空の cfg・文字の "true"）の判定は直す前と同じ');
  ok(b.isExcretionTarget(DOR({})) === false && b.isExcretionTarget(DOR({ targetExcretion: false })) === false && b.isExcretionTarget(DOR({ targetExcretion: true })) === true, 'デイだけの方: 未設定（ほかの端末がマスタと結ぶ前）でも対象外・マスタが対象と言った時だけ対象');
  ok(b.hbListTarget(DOR({})) === false, '施設の表示: デイだけの方は出さない');
  vm.runInContext('showNonTargets=true', b);
  ok(b.hbListTarget(DOR({})) === false && b.hbListTarget({ targetExcretion: false }) === true, '施設の表示で「対象外も表示」を入れても、デイだけの方は出さない（ほかの対象外の方は今までどおり出る）');
}

head('17 施設の端末: デイだけの方が名簿に増えても、一覧・時系列・入力・帳票・要注意は前と同じ');
{
  const extra = [DOR({ id: 40, name: '架空デイ一', yomi: 'あ', room: '110', masterId: 'm40' }), DOR({ id: 41, name: '架空デイ二', yomi: 'か', room: '210', masterId: 'm41', attn: true })];
  if (OLD_SRC) {
    const cases = [['renderTL', RE_RES, 'res'], ['renderBoard', RE_RES, 'res'], ['buildResSel', RE_A, 'a']];
    let allSame = true; const diffs = [];
    for (const [fn, re, name] of cases) {
      const oldE = exprOf(OLD_SRC, fn, re), newE = exprOf(SRC, fn, re);
      for (const flags of [{}, { onlyAttn: true }, { showNonTargets: true }, { onlyAttn: true, showNonTargets: true }]) {
        const b = box(flags);
        const o = run(b, oldE, name);   // 直す前の版・デイだけの方なし
        vm.runInContext('var D={residents:' + JSON.stringify(RES.concat(extra)) + '};', b);
        const n = vm.runInContext('(function(){var ci={rid:null};var date="2026-10-24";' + newE + 'return ' + name + '.map(function(r){return r.id}).join(",")})()', b);
        if (o !== n) { allSame = false; diffs.push([fn, flags, o, n]); }
      }
    }
    ok(allSame, '時系列・一覧表・入力の選択肢: デイだけの方を足した名簿でも、直す前の版（デイだけの方なし）と同じ対象・並び（要注意だけ・対象外も表示の 4通り × 3画面）', diffs);
  }
  // 帳票
  const rb = { console, isUserRes: (r) => !r.staff, isValidRes: (r) => !!r.room, D: { residents: RES.concat(extra) } };
  vm.createContext(rb);
  vm.runInContext([X.fn('hbIsDayOnly'), X.fn('isExcretionTarget'), X.fn('hbDayOnlyEff'), X.fn('rpResidents')].join('\n'), rb);
  const ids = rb.rpResidents().map((r) => r.id);
  ok(ids.indexOf(40) < 0 && ids.indexOf(41) < 0 && ids.indexOf(15) >= 0, '帳票（月の一覧・未排便など）の対象からデイだけの方を外す（ほかの対象外の方は今までどおり入る）', ids);
  // 要注意
  const ab = { console, isFullHospDay: () => false, lastR: () => null, elH: () => null, badgeCls: () => 'eb-ng', today: () => '2026-10-24', tlOvdForRes: () => [], _tlNowMin: () => 600 };
  vm.createContext(ab);
  ab.hbDcOn = () => false;
  vm.runInContext([X.fn('hbIsDayOnly'), X.fn('isExcretionTarget'), X.fn('hbDayOnlyEff'), X.fn('hbDcTag'), X.fn('isAttnRes')].join('\n'), ab);
  ok(ab.isAttnRes(DOR({ id: 40 }), '2026-10-24') === false && ab.isAttnRes({ id: 1 }, '2026-10-24') === true, '要注意: デイだけの方は要注意にしない（記録が無くても）・ほかの方は今までどおり');
  ok(/hbListTarget\(re\)&&hbDcKeep\(re\)&&tlOvdForRes/.test(X.fn('tlOvdRefresh')), '1分ごとの更新（期限切れの判定）も同じ対象の決まり');
}

head('18 デイの表示: デイだけの方は表に出て、帯の「居ない方」に数えない');
{
  const extra = [DOR({ id: 40, name: '架空デイ一', yomi: 'あ', room: '110', masterId: 'm40' })];
  const store = { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m11', 'm40'] }) };
  const b = box({ store, residents: RES.concat(extra) });
  b.hbDcInit();
  vm.runInContext('var D={residents:' + JSON.stringify(RES.concat(extra)) + '};', b);
  const tl = vm.runInContext('(function(){var ci={rid:null};var date="2026-10-24";' + exprOf(SRC, 'renderTL', RE_RES) + 'return res.map(function(r){return r.id}).join(",")})()', b);
  const sel = vm.runInContext('(function(){var ci={rid:null};' + exprOf(SRC, 'buildResSel', RE_A) + 'return a.map(function(r){return r.id}).join(",")})()', b);
  ok(tl === '40,11' && sel === '40,11', 'デイの表示では、デイだけの方も時系列・入力の選択肢に出る（五十音）', [tl, sel]);
  const c = b.hbDcCount(b.D.residents, b._dc, b.hbDcListable);
  ok(c.n === 2 && c.shown === 2 && c.miss === 0, '帯の数: デイだけの方は「表に出る方」に入れる', c);
  b.hbDcRenderBar();
  ok(b.els.dcBarTxt.innerHTML.indexOf('居ない方') < 0, '居ない方がいなければ帯に出さない');
}

head('19 入居者を直す画面（saveRes）: 閾値以外の cfg のキー（dayOnly ほか）を残す');
{
  function runSave(res, thr) {
    const els2 = {};
    const v = (id, val) => { els2[id] = { value: val }; };
    v('mRN', res.name); v('mRR', res.room); v('mRG', '女性'); v('mRY', ''); v('mRS', 'active'); v('mRLax', '');
    v('mRUW', thr.uw || ''); v('mRUD', thr.ud || ''); v('mRSW', thr.sw || ''); v('mRSD', thr.sd || '');
    els2.mRes = { classList: { remove() {} } };
    const pushes = [];
    const sb = { console, $: (id) => els2[id] || null, hbFieldDeny: () => false, D: { residents: [res] }, editResId: res.id,
      psEditResult: () => ({ day: [], night: [] }), _psOrig: JSON.stringify({ day: [], night: [] }), save() {}, apiPush: (a, d) => pushes.push([a, JSON.parse(JSON.stringify(d))]),
      renderCfg() {}, buildResSel() {}, showToast() {}, nextResId: () => 99 };
    vm.createContext(sb);
    vm.runInContext([X.varDecl('RES_CFG_KEYS'), X.fn('saveRes')].join('\n'), sb);
    sb.saveRes();
    return { r: sb.D.residents[0], pushes };
  }
  let o = runSave({ id: 1, name: '架空', room: '101', cfg: { dayOnly: true, stoolWarnD: 2, other: 'x' } }, { sd: '4' });
  ok(JSON.stringify(o.r.cfg) === JSON.stringify({ dayOnly: true, other: 'x', stoolDangerD: 4 }) && o.pushes.length === 1 && o.pushes[0][1].resident.cfg.dayOnly === true, '閾値は入れ直し（空にした stoolWarnD は消える）、dayOnly ほかのキーは残して送る', o.r.cfg);
  o = runSave({ id: 1, name: '架空', room: '101', cfg: { stoolWarnD: 2 } }, {});
  ok(o.r.cfg === undefined, '閾値だけの方で全部空にしたら cfg を消す（今までと同じ）');
  o = runSave({ id: 1, name: '架空', room: '101' }, { uw: '5' });
  ok(JSON.stringify(o.r.cfg) === JSON.stringify({ urineWarnH: 5 }), '閾値を入れたら cfg に入る（今までと同じ）');
  o = runSave({ id: 1, name: '架空', room: '101', cfg: '' }, {});
  ok(o.r.cfg === undefined, 'サーバーから空の cfg が来ていた方は今までどおり消す');
}

head('20 居ない方の一覧（hbDcMissing・純関数）');
{
  const resid = [
    { id: 1, name: '架空一', masterId: 'm1' },
    { id: 2, name: '架空二', yomi: 'かくうに', room: '102', masterId: 'm2', targetExcretion: false },
    { id: 3, name: '架空三', masterId: 'm3', hidden: true },
    { id: 4, name: '架空四', masterId: 'm4', active: false },
    { id: 5, name: '架空五', masterId: 'm5', mm: true },
    { id: 6, name: '架空七', room: '107' },
    DOR({ id: 12, name: '架空十二', masterId: 'm12' })
  ];
  const ro = {
    m6: { masterId: 'm6', name: '架空六', kana: 'カクウロク', room: '106', active: true },
    m7: { masterId: 'm7', name: '架空 七', kana: 'カクウナナ', room: '107' },
    m8: { masterId: 'm8', name: '架空八', room: '108', active: false },
    m9: { masterId: 'm9', name: '架空九', room: '' },
    m10: { masterId: 'm10', name: '架空十', room: '110' }
  };
  const store = { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', '<x>'] }) };
  const b = boxDO({ store, residents: resid });
  b.hbDcInit();
  const nx = (s) => vm.runInContext('_normNameX(' + JSON.stringify(s) + ')', b);
  const idx = { byMid: ro, nameCount: { [nx('架空十')]: 2, [nx('架空六')]: 1, [nx('架空 七')]: 1 } };
  const m = b.hbDcMissing(resid, b._dc, idx, b.hbDcListable);
  const by = {}; m.rows.forEach((x) => { by[x.mid] = x; });
  ok(!by.m1 && !by.m12, '表に出ている方（施設の対象・デイだけの方）は一覧に出ない');
  ok(!by.m2 && m.rows.every((x) => x.act !== 'mark'), '同じ masterId の施設では対象外の行は、デイの表示で表に出る＝一覧に出ず、印も書かない（B1・mark をやめた）');
  ok(by.m3 && !by.m3.act && /非表示/.test(by.m3.why), '非表示の行: 加えず理由');
  ok(by.m4 && !by.m4.act && /退去/.test(by.m4.why), '退去の行: 加えず理由');
  ok(by.m5 && !by.m5.act && /紐づけがずれて/.test(by.m5.why), '紐づけのずれ: 加えず理由');
  ok(by.m6 && by.m6.act === 'add' && by.m6.name === '架空六' && by.m6.kana === 'カクウロク' && by.m6.room === '106', '名簿にいて、まだ居ない方: 名簿の氏名・ふりがな・居室で「加える」');
  ok(by.m7 && !by.m7.act && /同じ氏名の方がいます/.test(by.m7.why), '排泄ケア記録に同じ氏名（空白違い）の在籍の方がいる: 足さない');
  ok(by.m8 && /入居者マスタで退去/.test(by.m8.why) && by.m9 && /居室がありません/.test(by.m9.why) && by.m10 && /2人以上/.test(by.m10.why) && by.m11 && /見つかりません/.test(by.m11.why), '名簿で退去・居室なし・同姓同名・名簿に無い: 加えず理由');
  ok(m.badN === 1, '形の違う値は数だけ');
  const m2 = b.hbDcMissing(resid, b._dc, null, b.hbDcListable);
  const by2 = {}; m2.rows.forEach((x) => { by2[x.mid] = x; });
  ok(by2.m6 && !by2.m6.act && /名簿がありません/.test(by2.m6.why) && !by2.m2, 'この端末に名簿が無い時は新しく足さない（既にある行の方は表に出る）');
  // 反証 重大1: 名簿と表記の違う未連携の行（同じ居室・同じふりがな）
  const v1 = b.hbDcMissing(resid.concat([{ id: 70, name: '架空ロク', room: '１０６号室' }]), b._dc, idx, b.hbDcListable).rows.find((x) => x.mid === 'm6');
  ok(v1 && !v1.act && /居室かふりがなが同じ/.test(v1.why), '居室が同じ（全角・「号室」つきでも）で結ばれていない在籍の行があれば足さない', v1);
  const v2 = b.hbDcMissing(resid.concat([{ id: 71, name: '架空ろく', room: '999', yomi: 'かくうろく' }]), b._dc, idx, b.hbDcListable).rows.find((x) => x.mid === 'm6');
  ok(v2 && !v2.act && /居室かふりがなが同じ/.test(v2.why), 'ふりがなが同じ（ひらがな・カタカナの違いは同じ）で結ばれていない在籍の行があれば足さない', v2);
  const v3 = b.hbDcMissing(resid.concat([{ id: 72, name: '架空ロク', room: '106', masterId: 'm10' }, { id: 73, name: '架空ロク', room: '106', active: false }]), b._dc, idx, b.hbDcListable).rows.find((x) => x.mid === 'm6');
  ok(v3 && v3.act === 'add', '同じ居室でも、名簿にいる別の方と結ばれている行・退去の行は妨げない（相部屋・前の入居者）', v3);
  const v4 = b.hbDcMissing(resid.concat([{ id: 74, name: '架空ロク', room: '106', masterId: 'm77' }]), b._dc, idx, b.hbDcListable).rows.find((x) => x.mid === 'm6');
  ok(v4 && !v4.act && /居室かふりがなが同じ/.test(v4.why), '名簿に無い masterId の行（登録し直された方の古い行など）で居室が同じなら足さない（確認の反証 軽A）', v4);
}

head('22a 履歴の小窓・帯のボタン（反証 中5・軽6）');
{
  const h = X.fn('showHist');
  ok(/var _dTag=\(typeof hbDcTag==='function'\)\?hbDcTag\(res\):'',_dOnly=!!_dTag;/.test(h) && /_dOnly\?\(padSetHistHtml\(rid\)\+guideRateHtml\(rid\)\+padUseHtml\(rid\)\)/.test(h) && /if\(_sb&&_dOnly\)\{_sb\.innerHTML=_dOnlyNote\}/.test(h), '履歴の小窓: 札のある方（デイのみ・施設では対象外）は排便のカレンダー・平均間隔・下剤の反応を出さず1行');
  ok(/\.dcbar \.dc-acts \[hidden\]\{display:none\}/.test(HTML), '帯のボタンの hidden が効く（ボタンの display に負けない）');
}

head('22c 一覧表の下剤の反応（確認の反証 中2）');
{
  const bd = X.fn('renderBoard');
  ok(/'<\/span> '\+\(dcOnly\?'':laxReactHtml\(r\)\)/.test(bd) && bd.indexOf('var dcTag=hbDcTag(re),dcOnly=!!dcTag;') < bd.indexOf('var laxHtml='), '一覧表: 札のある方には下剤の「24時間 反応なし」を出さない（札は下剤の欄より前に決める）');
  ok(/\.dc-only\{[^}]*font-size: 0\.9375rem/.test(HTML), '札の文字は 15px（0.9375rem）');
}

head('22 入居者マスタが後から排泄の対象にしたら dayOnly を外す（親の追加の決まり・mergeCommonResidents を動かす）');
function mergeBox(src) {
  const XX = makeExtractor(src);
  const nameMap = (() => { const i = src.indexOf('var _NAMEX_MAP='); const o = src.indexOf('{', i); return src.slice(i, matchBrace(src, o) + 1) + ';'; })();
  const store = new Map();
  const sb = {
    console, Date, Math, JSON, String, Number, Array, Object, isFinite, parseInt, parseFloat,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    pushes: [], toasts: [], _recIdx: null, D: { residents: [], records: [], cfg: {} }
  };
  sb.save = () => {}; sb.apiPush = (a, d) => sb.pushes.push([a, JSON.parse(JSON.stringify(d))]); sb.showToast = (m) => sb.toasts.push(m);
  vm.createContext(sb);
  const vars = ['SU_COMMON_KEY', 'MASTER_ROSTER_KEY', 'MASTER_ROSTER_TS_KEY', 'RES_ID_HW_KEY', 'SYS_STAFF_ROOM', 'SYS_STAFF_ROOM_LEGACY', 'LEGACY_SYS_RID', 'LEGACY_SYS_NAME_PREFIX', '_linkFreezeN', '_linkDropN', '_linkIdxCache'];
  const fns = ['toNum', '_isStaffRes', 'isUserRes', 'isValidRes', '_normName', '_normNameX', '_rosterFreshness', 'loadStoredMasterRoster', 'buildRosterIndex', 'checkResLink', '_midNameOk',
    '_invalidateLinkIdx', '_linkIdx', '_linkStateOf', '_resIdHw', '_bumpResIdHw', 'nextResId', 'getActiveHospAt', 'isCurrentlyHospitalized', 'isHospNow', 'pushMasterHospState', 'mergeCommonResidents'];
  const has = (n) => { try { XX.fn(n); return true; } catch (e) { return false; } };
  vm.runInContext(vars.map((v) => XX.varDecl(v)).concat([nameMap]).concat(fns.map((f) => XX.fn(f))).concat(has('hbIsDayOnly') ? [XX.fn('hbIsDayOnly'), XX.fn('isExcretionTarget')] : []).join('\n'), sb);
  return sb;
}
{
  const row = (o) => Object.assign({ id: 1, name: '架空一', room: '101', active: true, masterId: 'm1' }, o);
  /* 共有名簿（su_residents_common）からの突き合わせ＝targetApps が届く経路（代理名簿には targetApps が無い） */
  const common = (b, apps, at) => b.localStorage.setItem('su_residents_common', JSON.stringify(Object.assign({ residents: [Object.assign({ masterId: 'm1', name: '架空一', room: '101', active: true }, apps === undefined ? {} : { targetApps: apps })] }, at ? { updatedAt: new Date(at).toISOString() } : {})));
  const T0 = Date.parse('2026-10-25T00:00:00Z');
  let b = mergeBox(SRC);
  b.D.residents = [row({ cfg: { dayOnly: true, dayOnlyAt: T0, stoolWarnD: 3 } })];
  common(b, ['excretion'], T0 + 60000);
  b.mergeCommonResidents(null, { noAdd: true });
  let r = b.D.residents[0];
  ok(JSON.stringify(r.cfg) === JSON.stringify({ stoolWarnD: 3 }) && r.targetExcretion === true && b.isExcretionTarget(r) === true, '加えた後の共有名簿で対象になったら、dayOnly と dayOnlyAt が外れ、ほかのキー（閾値）は残る・施設の対象になる', r.cfg);
  ok(b.pushes.length === 1 && b.pushes[0][0] === 'saveRes' && JSON.stringify(b.pushes[0][1].resident.cfg) === JSON.stringify({ stoolWarnD: 3 }), 'saveRes で dayOnly の無い cfg をサーバーへ送る（退去の解除と同じ送り方）', b.pushes);
  b.mergeCommonResidents(null, { noAdd: true });
  ok(b.pushes.length === 1, 'もう一度突き合わせても、二度は送らない');
  b = mergeBox(SRC);
  b.D.residents = [row({ cfg: { dayOnly: true, dayOnlyAt: T0 } })];
  common(b, ['excretion'], T0 + 60000);
  b.mergeCommonResidents(null, { noAdd: true });
  ok(b.D.residents[0].cfg === undefined && b.pushes.length === 1 && b.pushes[0][1].resident.cfg === undefined, '印だけの cfg は cfg ごと消して送る（GAS の列は空になる）');
  // B2: 名簿の新しさの関門
  for (const [lbl, at] of [['加えた時刻より古い共有名簿', T0 - 60000], ['更新時刻の無い共有名簿', 0]]) {
    b = mergeBox(SRC);
    b.D.residents = [row({ cfg: { dayOnly: true, dayOnlyAt: T0, stoolWarnD: 3 } })];
    common(b, ['excretion'], at);
    b.mergeCommonResidents(null, { noAdd: true });
    ok(b.D.residents[0].cfg.dayOnly === true && b.pushes.length === 0, lbl + 'の「対象」では外さない（足しては外される往復をしない・B2）');
  }
  for (const [lbl, apps] of [['対象外（targetApps に excretion が無い）', ['weight']], ['名簿に targetApps が無い', undefined]]) {
    b = mergeBox(SRC);
    b.D.residents = [row({ cfg: { dayOnly: true, dayOnlyAt: T0, stoolWarnD: 3 } })];
    common(b, apps, T0 + 60000);
    b.mergeCommonResidents(null, { noAdd: true });
    r = b.D.residents[0];
    ok(r.cfg.dayOnly === true && r.cfg.stoolWarnD === 3 && b.pushes.length === 0 && b.isExcretionTarget(r) === false, lbl + ': dayOnly は外れない・何も送らない');
  }
  b = mergeBox(SRC);
  b.D.residents = [row({ cfg: { dayOnly: true, dayOnlyAt: T0 } })];
  b.mergeCommonResidents([{ masterId: 'm1', name: '架空一', room: '101', active: true, targetApps: ['excretion'] }], { noAdd: true });
  ok(b.D.residents[0].cfg.dayOnly === true && b.pushes.length === 0, '代理名簿（配列で渡す経路）の突き合わせでは外さない（新しさが代理名簿の時刻になるため）');
  // 2台が同時に外しても同じ中身
  const pay = [0, 1].map(() => { const x = mergeBox(SRC); x.D.residents = [row({ cfg: { stoolWarnD: 3, dayOnly: true, dayOnlyAt: T0, other: 'k' } })]; common(x, ['excretion'], T0 + 60000); x.mergeCommonResidents(null, { noAdd: true }); return JSON.stringify(x.pushes); });
  ok(pay[0] === pay[1] && /"other":"k"/.test(pay[0]) && !/dayOnly/.test(pay[0]), '2台が同時に外しても、送る中身は同じ（dayOnly の無い cfg）');
  // dayOnly の無い方の突き合わせは直す前と同じ
  if (OLD_SRC) {
    const same = [['excretion'], ['weight'], undefined].every((apps) => {
      const o = mergeBox(OLD_SRC), n = mergeBox(SRC);
      for (const x of [o, n]) { x.D.residents = [row({ cfg: { stoolWarnD: 3 } })]; common(x, apps, T0); x.mergeCommonResidents(null, { noAdd: true }); }
      return JSON.stringify(o.D.residents) === JSON.stringify(n.D.residents) && JSON.stringify(o.pushes) === JSON.stringify(n.pushes);
    });
    ok(same, 'dayOnly の無い方の名簿の突き合わせ（結果の行・送る中身）は直す前の版と同じ');
  }
}

head('22b 設定の切り替え「デイだけの方を加えられるようにする」（B3）');
{
  // cfgSendPayload: dayOnlyOn を送る（Config は全行の書き直し）
  const cs = { console, D: { cfg: { urineWarnH: 6, dayOnlyOn: 1 } } };
  vm.createContext(cs); vm.runInContext(X.fn('cfgSendPayload'), cs);
  const p1 = cs.cfgSendPayload();
  vm.runInContext('D.cfg.dayOnlyOn=0', cs); const p0 = cs.cfgSendPayload();
  vm.runInContext('delete D.cfg.dayOnlyOn', cs); const pn = cs.cfgSendPayload();
  ok(p1.dayOnlyOn === 1 && p0.dayOnlyOn === 0 && !('dayOnlyOn' in pn) && p1.urineWarnH === 6, '設定を送る時に dayOnlyOn（1・0）も送る（送らないとサーバーから消える）・持っていなければ送らない', [p1, p0, pn]);
  ok(/_send\.dayOnlyOn=Number\(D\.cfg\.dayOnlyOn\)/.test(X.src), '〔設定を保存〕（閾値の保存）でも dayOnlyOn を消さない');
  // 確認の反証 中1: サーバーの設定に dayOnlyOn が無ければ手元も消す（取り込みの1行を動かす）
  {
    const sync = X.fn('syncFromAPI');
    const i = sync.indexOf("    D.cfg=json.cfg?Object.assign");
    const j = sync.indexOf("delete D.cfg.dayOnlyOn;", i);
    ok(i > 0 && j > i, '同期の取り込みに dayOnlyOn の消し方がある');
    const code = sync.slice(i, j + 'delete D.cfg.dayOnlyOn;'.length);
    const run2 = (local, server) => { const sb = { D: { cfg: local }, json: { cfg: server } }; vm.createContext(sb); vm.runInContext(code, sb); return sb.D.cfg; };
    ok(run2({ urineWarnH: 6, dayOnlyOn: 1 }, { urineWarnH: 6 }).dayOnlyOn === undefined, 'サーバーに無い（旧い画面の保存で消えた）→ 手元の 1 も消す＝切');
    ok(run2({ dayOnlyOn: 1 }, { dayOnlyOn: 0 }).dayOnlyOn === 0 && run2({}, { dayOnlyOn: 1 }).dayOnlyOn === 1, 'サーバーの 0・1 はそのまま手元へ');
    ok(JSON.stringify(run2({ urineWarnH: 6, padKinds: 'a' }, { urineWarnH: 7 })) === JSON.stringify({ urineWarnH: 7, padKinds: 'a' }), 'dayOnlyOn を持たない端末の設定の重ね方は今までどおり');
  }
  // hbDcAddToggle
  async function tog(on, yes, field) {
    const pushes = [], toasts = [], cb = { checked: on };
    const sb = { console, D: { cfg: {} }, hbFieldDeny: () => !!field, customConfirm: async () => !!yes, save() {}, apiPush: (a, d) => pushes.push([a, d]), showToast: (m) => toasts.push(m), _dc: null, hbDcRerender() {} };
    vm.createContext(sb); vm.runInContext([X.fn('cfgSendPayload'), X.fn('hbDcAddEnabled'), X.fn('hbDcAddToggle')].join('\n'), sb);
    await sb.hbDcAddToggle(cb);
    return { cb, pushes, toasts, cfg: sb.D.cfg, enabled: sb.hbDcAddEnabled() };
  }
  PENDING.push(Promise.all([tog(true, true), tog(true, false), tog(false, true), tog(true, true, true)]).then(([a, c, d, f]) => {
    ok(a.cfg.dayOnlyOn === 1 && a.enabled && a.pushes.length === 1 && a.pushes[0][0] === 'saveCfg' && a.pushes[0][1].cfg.dayOnlyOn === 1, '入れる: 確かめて dayOnlyOn=1 を saveCfg で送る');
    ok(c.cb.checked === false && c.pushes.length === 0 && !('dayOnlyOn' in c.cfg), '確かめで「キャンセル」なら入れない');
    ok(d.cfg.dayOnlyOn === 0 && d.pushes[0][1].cfg.dayOnlyOn === 0 && !d.enabled, '切る: 消すのではなく 0 を送る（ほかの端末の 1 を確実に上書きする）');
    ok(f.cb.checked === false && f.pushes.length === 0, '現場の端末では切り替えられない（hbFieldDeny）');
    ok(a.cb.checked === true && d.cb.checked === false, '書いた後に箱を書いた値に合わせる（確かめの間に描き直されても外れて見えない・確認の反証 軽D）');
  }));
}

head('21 〔デイの記録に加える〕（hbDcAdd を動かす）');
const asyncTests = (async () => {
  const ro = { m6: { masterId: 'm6', name: '架空六', kana: 'カクウロク', room: '106', gender: '女', careLevel: '要介護1', active: true, hospitalized: false } };
  const idx = { byMid: ro, nameCount: {} };
  const mk = (o) => {
    const resid = [{ id: 2, name: '架空二', room: '102', masterId: 'm2', targetExcretion: false, cfg: { stoolWarnD: 3 } }];
    const b = boxDO(Object.assign({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m2', 'm6'] }) }, residents: resid }, o || {}));
    const pushes = [];
    Object.assign(b, { _linkIdx: () => idx, nextResId: () => 77, save() {}, apiPush: (a, d) => pushes.push([a, JSON.parse(JSON.stringify(d))]), hbDcMissRender() {} });
    b.hbDcInit();
    b.pushes = pushes;
    return b;
  };
  let b = mk({ confirmYes: true });
  await b.hbDcAdd('m6');
  const nr = b.D.residents.find((r) => r.id === 77);
  ok(!!nr && nr.name === '架空六' && nr.yomi === 'カクウロク' && nr.room === '106' && nr.gender === '女性' && nr.careLevel === '要介護1' && nr.active === true && nr.masterId === 'm6' && nr._fromMaster === true && nr.cfg.dayOnly === true && nr.cfg.dayOnlyAt > 0 && Object.keys(nr.cfg).length === 2 && nr.masterHosp === false && nr.targetExcretion === undefined, '加える: 名簿からの新規の取り込みと同じ作り＋cfg.dayOnly と加えた時刻 dayOnlyAt（targetExcretion は付けない）', nr);
  ok(b.pushes.length === 1 && b.pushes[0][0] === 'saveRes' && b.pushes[0][1].resident.cfg.dayOnly === true && b.calls.rerender === 1, '保存は今の入居者の保存と同じ送信（saveRes）を1回・描き直す');
  ok(/氏名: 架空六（カクウロク）/.test(b.calls.confirm[0]) && /居室: 106号室/.test(b.calls.confirm[0]) && /施設の一覧・時系列・帳票には出ません/.test(b.calls.confirm[0]), '確かめの小窓に氏名・ふりがな・居室を出す（取り違え防止）', b.calls.confirm[0]);
  await b.hbDcAdd('m6');
  ok(b.D.residents.filter((r) => r.masterId === 'm6').length === 1 && b.pushes.length === 1, 'もう一度押しても二重に足さない（もう表に出ている）');
  b = mk({ confirmYes: true });
  await b.hbDcAdd('m2');
  const r2 = b.D.residents.find((r) => r.id === 2);
  ok(b.D.residents.length === 1 && JSON.stringify(r2.cfg) === JSON.stringify({ stoolWarnD: 3 }) && b.pushes.length === 0 && b.calls.confirm.length === 0, '既にある施設では対象外の行には印を書かない（B1・その方はデイの表示で表に出ている）', r2.cfg);
  // B3: 切り替えが入っていない時
  b = mk({ confirmYes: true, addOff: true });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && /設定（入居者管理）で「デイだけの方を加えられるようにする」/.test(b.calls.toast.join()), '設定の切り替え（dayOnlyOn）が入っていない時は加えない（B3）');
  b = mk({ confirmYes: false });
  await b.hbDcAdd('m6');
  ok(b.D.residents.length === 1 && b.pushes.length === 0, '「キャンセル」なら何も書かない');
  b = mk({ confirmYes: true, onConfirm: (bb) => { bb.D.residents.push({ id: 50, name: '架空六', room: '106', masterId: 'm6' }); } });
  await b.hbDcAdd('m6');
  ok(b.D.residents.filter((r) => r.masterId === 'm6').length === 1 && b.pushes.length === 0 && /状態が変わった/.test(b.calls.toast.join()), '確かめている間に同期で同じ方が入ったら書かない（押した後にもう一度確かめる）');
  b = mk({ confirmYes: true, store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m99'] }) } });
  await b.hbDcAdd('m99');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && /加えられません/.test(b.calls.toast.join()), '加えられない方（名簿に無い）は確かめも出さず理由を出す');
  // 反証 中4: 同期の関門
  b = mk({ confirmYes: true, apiUrl: 'https://x', lastSync: 0 });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && /まだサーバーと同期できていません/.test(b.calls.toast.join()), '一度も同期できていない端末では加えない');
  b = mk({ confirmYes: true, apiUrl: 'https://x' }); b.unsent = 2;
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && /送れていない記録があります/.test(b.calls.toast.join()), '送れていない書き込みがある時は加えない');
  b = mk({ confirmYes: true, apiUrl: 'https://x', onSync: () => false });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && /照らし合わせられませんでした/.test(b.calls.toast.join()), '足す前の同期に失敗したら加えない（確かめも出さない）');
  b = mk({ confirmYes: true, apiUrl: 'https://x', onSync: (bb) => { bb.D.residents.push(DOR({ id: 60, name: '架空六', room: '106', masterId: 'm6' })); return true; } });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && b.D.residents.filter((r) => r.masterId === 'm6').length === 1, '同期でほかの端末が足した同じ方が入ってきたら、確かめを出さずに止める（2行にしない）');
  b = mk({ confirmYes: true, apiUrl: 'https://x' });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 1 && b.calls.confirm.length === 1, '同期できていれば、照らし合わせてから確かめて加える');
  // 確認の反証 軽C: 照らし合わせの間に〔施設の表示に戻す〕・小窓を閉じた
  b = mk({ confirmYes: true, apiUrl: 'https://x', onSync: (bb) => { bb.hbDcOff(); return true; } });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0 && !/ほかの端末/.test(b.calls.toast.join()), '照らし合わせの間に施設の表示に戻したら、何も出さずにやめる');
  b = mk({ confirmYes: true, apiUrl: 'https://x', onSync: (bb) => { bb.els.mDcMiss.classList.on = false; return true; } });
  b.els.mDcMiss = { classList: { on: true, contains(c) { return c === 'on' && this.on; } } };
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 0 && b.calls.confirm.length === 0, '照らし合わせの間に小窓を閉じたら、後から確かめの小窓を出さない');
  b = mk({ confirmYes: true, apiUrl: 'https://x', onSync: async (bb) => { await bb.hbDcAdd('m6'); return true; } });
  await b.hbDcAdd('m6');
  ok(b.pushes.length === 1 && /照らし合わせています/.test(b.calls.toast.join()), '照らし合わせの間にもう一度押したら「照らし合わせています」と出す（二重にしない）');
  // 小窓の中身（hbDcMissRender を動かす）
  b = boxDO({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m6', 'm99', '<x>'] }) }, residents: [] });
  b.els.mDcMissList = { innerHTML: '', addEventListener() {} }; b._linkIdx = () => idx; b.hbDcInit(); b.hbDcMissRender();
  const li = b.els.mDcMissList.innerHTML;
  ok(/<b>架空六<\/b><span class="dcm-sub">カクウロク<\/span><span class="dcm-sub">106号室<\/span><\/div><button type="button" class="bn bp dcm-add" data-mid="m6">デイの記録に加える<\/button>/.test(li) && /<b>氏名がわからない方<\/b><\/div><div class="dcm-why">⚠ 入居者マスタの名簿に見つかりません/.test(li) && /形の違う値が 1件/.test(li) && li.indexOf('架空六') < li.indexOf('氏名がわからない方'), '小窓: 氏名・ふりがな・居室と〔加える〕、名簿に無い方は理由（後ろ）、形の違う値は数', li);
  b = boxDO({ store: { hbcr_daycare: '1', [HANDOFF]: key({ v: 1, day: '2026-10-24', mids: ['m6'] }) }, residents: [], addOff: true });
  b.els.mDcMissList = { innerHTML: '', addEventListener() {} }; b._linkIdx = () => idx; b.hbDcInit(); b.hbDcMissRender();
  ok(!/dcm-add/.test(b.els.mDcMissList.innerHTML) && /「デイだけの方を加えられるようにする」を入れてください/.test(b.els.mDcMissList.innerHTML) && /架空六/.test(b.els.mDcMissList.innerHTML), '切り替えが入っていない時は、小窓に氏名と「設定で入れてください」を出し、ボタンは出さない（B3）');
  // 帯の〔居ない方の一覧〕
  b = mk(); b.els.dcMiss = { hidden: true }; b.hbDcRenderBar();
  ok(b.els.dcMiss.hidden === false, '居ない方がいる時は〔居ない方の一覧〕を出す');
  const f = box({ store: {} }); f.els.dcMiss = { hidden: false }; f.hbDcRenderBar();
  ok(f.els.dcMiss.hidden === true, '施設の端末では出さない');
  ok(!/hbFieldDeny/.test(X.fn('hbDcAdd')), '（決め）デイの表示から加える操作は現場端末の守り（hbFieldDeny）では止めない＝デイのタブレットで使う操作のため');
})();

Promise.all([asyncTests].concat(PENDING)).then(() => {
  console.log('\n══════════════════════════════════');
  console.log('  合格 ' + pass + ' / 不合格 ' + fail);
  process.exit(fail ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
