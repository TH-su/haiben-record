/* ══════════════════════════════════════════════════════════════════════
   マスタ連携の紐づけガード 検証ハーネス（2026-08-06）
   実行:  node tests/link-guard.test.js
   ──────────────────────────────────────────────────────────────────────
   ★haiben-record.html の【実物のソース】から関数と該当ブロックを切り出して評価する。
     テスト用にロジックを写経しない（写経すると本体を直してもテストが緑のままになる）。
   ★入居者の氏名は合成データ（入居者A/B/C・職員S）。実在の氏名は一切使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 既定は本体。HAIBEN_HTML で差し替えられるのは変異テスト（ガードを外した写しでテストが
   ちゃんと赤くなるかの確認）のため。通常運用では指定しない。 */
const HTML = fs.readFileSync(process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html'), 'utf8');
const SRC = (function () {
  const m = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if (!m) throw new Error('script ブロックが見つかりません');
  return m[1];
})();

/* ── JS を字句レベルで走査して対応する } を探す（文字列・テンプレート・正規表現・コメントを飛ばす） ── */
function matchBrace(src, openIdx) {
  let depth = 0, i = openIdx, prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '/') {
      // 直前の意味のある文字で「正規表現の開始か除算か」を決める
      let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--;
      const p = j >= 0 ? src[j] : '';
      if (p === '' || '(,=:[!&|?{};+-*%~^<>'.includes(p)) {
        i++; let cls = false;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') cls = true;
          else if (src[i] === ']') cls = false;
          else if (src[i] === '/' && !cls) { i++; break; }
          else if (src[i] === '\n') break;
          i++;
        }
        continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++; prev = c;
  }
  throw new Error('対応する } が見つかりません');
}

function extractFn(name) {
  const re = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('関数が見つかりません: ' + name);
  const from = m.index + (SRC[m.index] === '\n' ? 1 : 0);
  const open = SRC.indexOf('{', m.index + m[0].length);
  return SRC.slice(from, matchBrace(SRC, open) + 1);
}
/* var NAME = ... ; の1文（複数行リテラルも可）を切り出す */
function extractVar(name) {
  const re = new RegExp('(?:^|\\n)\\s*(?:var|let|const)\\s+' + name + '\\s*=');
  const m = re.exec(SRC);
  if (!m) throw new Error('変数が見つかりません: ' + name);
  const start = m.index + (SRC[m.index] === '\n' ? 1 : 0);
  let i = m.index + m[0].length, depth = 0;
  while (i < SRC.length) {
    const c = SRC[i];
    if (c === '/' && SRC[i + 1] === '/') { const n = SRC.indexOf('\n', i); i = n < 0 ? SRC.length : n; continue; }
    if (c === '/' && SRC[i + 1] === '*') { const n = SRC.indexOf('*/', i + 2); i = n < 0 ? SRC.length : n + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < SRC.length) { if (SRC[i] === '\\') { i += 2; continue; } if (SRC[i] === q) { i++; break; } i++; } continue; }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if ((c === ';' || c === '\n') && depth === 0) break;
    i++;
  }
  return SRC.slice(start, i + 1);
}
/* マーカー行から始まり、指定の終端文字列までを切り出す（同期のマージ処理など関数でない塊用） */
function extractBetween(startMark, endMark) {
  const a = SRC.indexOf(startMark);
  if (a < 0) throw new Error('開始マーカーが見つかりません: ' + startMark);
  const b = SRC.indexOf(endMark, a);
  if (b < 0) throw new Error('終了マーカーが見つかりません: ' + endMark);
  return SRC.slice(a, b + endMark.length);
}

/* ── サンドボックス（DOM なし・localStorage はメモリ実装） ── */
function makeCtx() {
  const store = new Map();
  const sandbox = {
    console,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    Date, Math, JSON, String, Number, Array, Object, isFinite, parseInt, parseFloat,
    _store: store,
    pushes: [],          // apiPush の記録
    toasts: [],
    saveCount: 0,
    _recIdx: null,
    D: { residents: [], records: [], cfg: {} },
  };
  sandbox.save = function () { sandbox.saveCount++; };
  sandbox.apiPush = function (action, data) { sandbox.pushes.push({ action, data }); };
  sandbox.showToast = function (m) { sandbox.toasts.push(m); };
  /* 名簿から新しく取り込む方の試験（K）で使う画面まわりの代役 */
  sandbox.hbFieldDeny = function () { return false; };
  sandbox.renderLinkAudit = function () {}; sandbox.renderCfg = function () {}; sandbox.buildResSel = function () {};
  sandbox.renderBoard = function () {}; sandbox.tlRenderKeepScroll = function () {};
  sandbox.document = { querySelector: function () { return null; } };
  sandbox.customConfirm = async function () { return true; };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const parts = [
    extractVar('SU_COMMON_KEY'),
    extractVar('MASTER_ROSTER_KEY'),
    extractVar('MASTER_ROSTER_TS_KEY'),
    extractVar('RES_ID_HW_KEY'),
    extractVar('SYS_STAFF_ROOM'),
    extractVar('SYS_STAFF_ROOM_LEGACY'),
    extractVar('LEGACY_SYS_RID'),
    extractVar('LEGACY_SYS_NAME_PREFIX'),
    extractVar('_NAMEX_MAP'),
    extractVar('_linkFreezeN'),
    extractVar('_linkDropN'),
    extractVar('_linkIdxCache'),
    extractFn('toNum'),
    extractFn('_isStaffRes'),
    extractFn('isUserRes'),
    extractFn('isValidRes'),
    extractFn('_normName'),
    extractFn('_normNameX'),
    extractFn('_rosterFreshness'),
    extractFn('loadStoredMasterRoster'),
    extractFn('buildRosterIndex'),
    extractFn('checkResLink'),
    extractFn('_midNameOk'),
    extractFn('_invalidateLinkIdx'),
    extractFn('_linkIdx'),
    extractFn('_linkStateOf'),
    extractFn('_resIdHw'),
    extractFn('_bumpResIdHw'),
    extractFn('nextResId'),
    extractFn('getActiveHospAt'),
    extractFn('isCurrentlyHospitalized'),
    extractFn('isHospNow'),
    extractFn('pushMasterHospState'),
    extractFn('mergeCommonResidents'),
    extractFn('auditResLinks'),
    /* 同期の「サーバー行を採用しつつ clientOnly を引き継ぐ」ブロックを関数化して評価する */
    'function __syncTransplant(apiRes, localRes){\n' +
    '  var seenResId={},mergedRes=[];\n' +
    '  var localResById={};localRes.forEach(function(r){if(r&&r.id!=null)localResById[toNum(r.id)]=r});\n' +
    extractVar('clientOnly') + '\n' +
    extractVar('clientOnlyIdent') + '\n' +
    extractBetween('    // APIを先に入れる（勝者）', 'mergedRes.push(r);seenResId[k]=true}}});') + '\n' +
    '  return mergedRes;\n}',
    /* 修復の適用部（targets への書き込み）だけを関数化して評価する */
    'function __applyRepair(targets){\n' +
    '  var n=0;\n' +
    extractBetween('  targets.forEach(function(x){\n    var r=x.r,c=x.cand;', '  });') + '\n' +
    '  return n;\n}',
    /* 名簿から新しく取り込む方をサーバーへ送る（2026-10-25・入居者番号の混線の直し）。接続先（apiUrl）を置かない区画では今までどおりの動き */
    extractVar('DC_ID_MIN'), extractFn('_isDcId'), extractFn('hbDcNewId'),
    extractVar('_resImportQ'), extractVar('_resNotMade'), extractVar('_resSrvIds'),
    extractFn('hbResCommonList'), extractFn('hbMasterTargetSet'), extractFn('hbResRosterInfo'), extractFn('hbResNoteSrv'), extractFn('hbResLocalOnly'),
    extractFn('hbResHashId'), extractFn('hbResIdFor'), extractFn('_hbDcRoomKey'), extractFn('hbDcKana'), extractFn('_resSimilar'),
    extractFn('hbResPlan'), extractFn('hbResLinkByHash'), extractFn('_resLinked'), extractFn('hbResLinkCands'), extractFn('hbResMake'), extractFn('_resHealRedraw'),
    extractFn('hbResHeal'), extractFn('hbResAddNotMade'), extractFn('hbResLinkNotMade'),
    extractFn('delRes'), extractFn('hbDcLinkOk'), extractFn('hbDcMissing'),
    /* const 宣言は vm の globalThis に載らないため、テストから使うキー名を明示的に公開する */
    'globalThis.K={SU_COMMON_KEY:SU_COMMON_KEY,MASTER_ROSTER_KEY:MASTER_ROSTER_KEY,' +
    'MASTER_ROSTER_TS_KEY:MASTER_ROSTER_TS_KEY,RES_ID_HW_KEY:RES_ID_HW_KEY};',
  ];
  vm.runInContext(parts.join('\n\n'), ctx, { filename: 'haiben-extracted.js' });
  return ctx;
}

/* ── 極小テストランナー ── */
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' — ' + e.message); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || '') + ' 期待 ' + sb + ' / 実際 ' + sa);
}
function ok(v, msg) { if (!v) throw new Error(msg || '真であるべき'); }

/* ── 合成データ ── */
const ROSTER = [
  { masterId: 1, name: '入居者A', kana: 'ニュウキョシャエー', room: '101', careLevel: '要介護1', active: true, hospitalized: false },
  { masterId: 2, name: '入居者B', kana: 'ニュウキョシャビー', room: '202', careLevel: '要介護3', active: true, hospitalized: true },
  { masterId: 3, name: '入居者C', kana: 'ニュウキョシャシー', room: '303', careLevel: '要介護2', active: true, hospitalized: false },
];
function setRoster(ctx, list, key) {
  ctx.localStorage.setItem(key || ctx.K.SU_COMMON_KEY,
    JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), residents: list }));
}
function res(o) { return Object.assign({ active: true }, o); }

console.log('\n=== A. 氏名の比較用正規化（_normNameX） ===');
{
  const c = makeCtx();
  t('空白の有無を吸収する', () => eq(c._normNameX('入居者 A'), c._normNameX('入居者A')));
  t('異体字を吸収する（髙/高・﨑/崎・邊/辺）', () => {
    eq(c._normNameX('髙橋'), c._normNameX('高橋'));
    eq(c._normNameX('山﨑'), c._normNameX('山崎'));
    eq(c._normNameX('渡邊'), c._normNameX('渡辺'));
  });
  t('全角英数・半角カナを吸収する（NFKC）', () => eq(c._normNameX('ﾆｭｳ'), c._normNameX('ニュウ')));
  t('別人は一致しない', () => ok(c._normNameX('入居者A') !== c._normNameX('入居者B')));
  t('表示・保存には使わない（元の値を変えない）', () => {
    const r = { name: '髙橋' }; c._normNameX(r.name); eq(r.name, '髙橋');
  });
}

console.log('\n=== B. 名簿索引（buildRosterIndex） ===');
{
  let c = makeCtx();
  t('名簿がまったく無ければ null（判定不能）', () => eq(c.buildRosterIndex(), null));

  c = makeCtx(); setRoster(c, ROSTER);
  t('共有名簿だけでも索引を作る', () => { const i = c.buildRosterIndex(); eq(i.size, 3); eq(i.byMid['2'].room, '202'); });

  c = makeCtx();
  setRoster(c, [{ masterId: 1, name: '入居者A', kana: 'キュウ', room: '古', active: true }]);
  c.localStorage.setItem(c.K.MASTER_ROSTER_KEY, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(),
    residents: [{ masterId: 1, name: '入居者A', kana: 'シン', room: '新', active: true }] }));
  t('代理名簿（サーバー直取得）を共有名簿より優先する', () => eq(c.buildRosterIndex().byMid['1'].room, '新'));

  c = makeCtx();
  setRoster(c, [{ masterId: 1, name: '入居者A', room: '101', active: true },
                { masterId: 9, name: '入居者A', room: '109', active: false }]);
  t('同名の退去者は氏名の一意判定を潰さない', () => eq(c.buildRosterIndex().nameCount[c._normNameX('入居者A')], 1));
}

console.log('\n=== C. 紐づけ判定（checkResLink） ===');
{
  const c = makeCtx(); setRoster(c, ROSTER);
  const idx = c.buildRosterIndex();
  t('masterId 未設定は none', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', room: '101' }), idx), 'none'));
  t('名簿が無ければ unknown（mismatch に倒さない）', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', masterId: 1 }), null), 'unknown'));
  t('masterId の相手と氏名が一致 → ok', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', masterId: 1 }), idx), 'ok'));
  t('masterId の相手が別人 → mismatch', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', masterId: 2 }), idx), 'mismatch'));
  t('masterId が名簿に無い → unknown', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', masterId: 99 }), idx), 'unknown'));
  t('表記ゆれ確認済み（midAck）は ok', () => eq(c.checkResLink(res({ id: 1, name: '入居者A', masterId: 2, midAck: true }), idx), 'ok'));
  t('職員の隠し行は判定対象外（none）', () => eq(c.checkResLink(res({ id: 9, name: '職員S', room: 'STAFF', yomi: 'S0000', hidden: true, masterId: 2 }), idx), 'none'));
}

console.log('\n=== D. 名簿の取り込み（mergeCommonResidents）＝症状の発生経路 ===');
{
  /* 本丸: 誤リンクの行に別人の居室・フリガナを書かない */
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '101', yomi: 'ニュウキョシャエー', masterId: 2 })];
  c.mergeCommonResidents();
  const r = c.D.residents[0];
  t('【回帰】誤リンクでは居室が書き換わらない', () => eq(r.room, '101'));
  t('【回帰】誤リンクではフリガナが書き換わらない', () => eq(r.yomi, 'ニュウキョシャエー'));
  t('【回帰】誤リンクでは氏名も当然そのまま', () => eq(r.name, '入居者A'));
  t('凍結件数が画面へ出る（無言で止めない）', () => eq(c._linkFreezeN, 1));
  t('誤リンクでは入院の写し（masterHosp）も入れない', () => eq(r.masterHosp, undefined));
  t('誤リンクではサーバーへ何も送らない', () => eq(c.pushes.length, 0));
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '旧', yomi: '', masterId: 1 })];
  c.mergeCommonResidents();
  const r = c.D.residents[0];
  t('正しいリンクでは従来どおり居室・フリガナ・介護度が入る', () => {
    eq(r.room, '101'); eq(r.yomi, 'ニュウキョシャエー'); eq(r.careLevel, '要介護1');
  });
  t('正しいリンクでは入院の写しも入る（C6 維持）', () => eq(r.masterHosp, false));
}
{
  /* 2026-08-07: フリガナは空欄補完のみ（手入力の保護）。この1行が戻されたらここで検出する */
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '旧', yomi: 'テニュウリョク', masterId: 1 })];
  c.mergeCommonResidents();
  const r = c.D.residents[0];
  t('【回帰】非空のフリガナはマスタで上書きされない（空欄補完のみ）', () => eq(r.yomi, 'テニュウリョク'));
  t('【回帰】居室は従来どおり非空マスタ常勝', () => eq(r.room, '101'));
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '旧', yomi: '　 ', masterId: 1 })];
  c.mergeCommonResidents();
  t('【回帰】空白だけのフリガナは空欄として補完される', () => eq(c.D.residents[0].yomi, 'ニュウキョシャエー'));
}
{
  const c = makeCtx();
  setRoster(c, [{ masterId: 1, name: '入居者A', kana: 'エー1', room: '101', active: true },
                { masterId: 2, name: '入居者A', kana: 'エー2', room: '202', active: true }]);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '不明', yomi: '' })];
  c.mergeCommonResidents();
  t('同姓同名は氏名フォールバックで紐づけない', () => {
    eq(c.D.residents[0].masterId, undefined); eq(c.D.residents[0].room, '不明');
  });
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 10, name: '入居者C', room: '不明', yomi: '' })];
  c.mergeCommonResidents();
  t('未連携＋氏名が名簿で一意なら紐づけて更新する', () => {
    eq(c.D.residents[0].masterId, 3); eq(c.D.residents[0].room, '303');
  });
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  /* 既に別の masterId が付いている行に、氏名一致で上書きしない（rank4 の封鎖） */
  c.D.residents = [res({ id: 10, name: '入居者C', room: '999', yomi: 'モト', masterId: 77 })];
  c.mergeCommonResidents();
  t('別の紐づけを持つ行に氏名フォールバックで上書きしない', () => {
    eq(c.D.residents[0].masterId, 77); eq(c.D.residents[0].room, '999'); eq(c.D.residents[0].yomi, 'モト');
  });
}
{
  const c = makeCtx();
  setRoster(c, [{ masterId: 2, name: '入居者B', room: '202', kana: 'ビー', active: false }]);
  c.D.residents = [res({ id: 10, name: '入居者A', room: '101', yomi: 'エー', masterId: 2 })];
  c.mergeCommonResidents();
  t('【重要】誤リンク行は退去鏡映でも在籍を落とさない', () => {
    eq(c.D.residents[0].active, true); eq(c.pushes.length, 0);
  });
}
{
  const c = makeCtx();
  setRoster(c, [{ masterId: 2, name: '入居者B', room: '202', kana: 'ビー', active: false }]);
  c.D.residents = [res({ id: 10, name: '入居者B', room: '202', yomi: 'ビー', masterId: 2 })];
  c.mergeCommonResidents();
  t('正しいリンクの退去鏡映（C5）は従来どおり働く', () => {
    eq(c.D.residents[0].active, false); eq(c.pushes.length, 1); eq(c.pushes[0].action, 'saveRes');
  });
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [res({ id: 90, name: '職員S', room: 'STAFF', yomi: 'S0000', hidden: true, masterId: 2 })];
  c.mergeCommonResidents();
  t('職員の隠し行には一切触れない（居室・並び順を守る）', () => {
    eq(c.D.residents[0].room, 'STAFF'); eq(c.D.residents[0].yomi, 'S0000');
  });
}
{
  /* 名簿の入居者と職員の氏名がたまたま同じでも、職員の隠し行を書き換えない。
     ここが破れると room='STAFF'/yomi='S0000' が消え、その職員が全画面から消える。 */
  const c = makeCtx();
  setRoster(c, [{ masterId: 4, name: '職員S', kana: 'ショクインエス', room: '404', active: true }]);
  c.D.residents = [res({ id: 90, name: '職員S', room: 'STAFF', yomi: 'S0000', hidden: true })];
  c.mergeCommonResidents();
  t('氏名が同じでも職員の隠し行に名簿を貼り付けない', () => {
    const s = c.D.residents.find(x => x.id === 90);
    eq(s.room, 'STAFF'); eq(s.yomi, 'S0000'); eq(s.masterId, undefined);
  });
  t('名簿側の同名入居者は別行として取り込まれる', () => eq(c.D.residents.length, 2));
}
{
  const c = makeCtx();
  c.D.residents = [res({ id: 10, name: '入居者A', room: '101', yomi: 'エー', masterId: 2 })];
  const before = JSON.stringify(c.D.residents);
  c.mergeCommonResidents();
  t('名簿が無ければ1バイトも書き換えない', () => eq(JSON.stringify(c.D.residents), before));
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [];
  c.mergeCommonResidents(null, { noAdd: true });
  t('noAdd では新規追加しない（同期前のローカル再採番を止める）', () => eq(c.D.residents.length, 0));
  c.mergeCommonResidents();
  t('noAdd なしなら従来どおり取り込む', () => eq(c.D.residents.length, 3));
}

console.log('\n=== E. 同期時の引き継ぎ（clientOnly の氏名ゲート）＝誤リンクの供給源 ===');
{
  const c = makeCtx();
  const api = [{ id: 7, name: '入居者A', room: '101', yomi: 'エー', active: true }];
  const loc = [{ id: 7, name: '入居者A', room: '101', masterId: 1, masterHosp: true, laxNote: 'メモ' }];
  const out = c.__syncTransplant(api, loc);
  t('氏名が一致すれば紐づけを引き継ぐ（従来動作の維持）', () => { eq(out[0].masterId, 1); eq(out[0].masterHosp, true); });
  t('業務データ（下剤メモ）は従来どおり引き継ぐ', () => eq(out[0].laxNote, 'メモ'));
}
{
  const c = makeCtx();
  const api = [{ id: 7, name: '入居者A', room: '101', active: true }];
  const loc = [{ id: 7, name: '入居者B', room: '202', masterId: 2, masterHosp: true, laxNote: 'メモ', schedule: [{ t: '08:00' }] }];
  const out = c.__syncTransplant(api, loc);
  t('【本丸】氏名が違えば紐づけを引き継がない', () => { eq(out[0].masterId, undefined); eq(out[0].masterHosp, undefined); });
  t('引き継がなかった件数を数える（点検に出す）', () => eq(c._linkDropN, 1));
  t('業務データ（予定・下剤メモ）は氏名が違っても温存する＝消さない側に倒す', () => {
    eq(out[0].laxNote, 'メモ'); eq(out[0].schedule, [{ t: '08:00' }]);
  });
  t('氏名はサーバー側が勝つ（従来どおり）', () => eq(out[0].name, '入居者A'));
}

console.log('\n=== F. 入居者idの高水位（再採番の衝突防止） ===');
{
  const c = makeCtx();
  c.D.residents = [res({ id: 3, name: '入居者A', room: '101' })];
  t('通常はローカル最大+1', () => eq(c.nextResId(), 4));
  c.localStorage.setItem(c.K.RES_ID_HW_KEY, '40');
  t('高水位が大きければそちら+1（端末消去後の若いid衝突を防ぐ）', () => eq(c.nextResId(), 41));
  t('採番のたびに高水位が上がる', () => eq(c.nextResId(), 42));
}

console.log('\n=== G. 修復の適用（氏名・id・記録を動かさない） ===');
{
  const c = makeCtx();
  /* 名簿側の氏名をわざと表記ゆれ（全角Ａ＋空白）にする。比較では一致するが文字列は別物なので、
     修復が氏名を書き換えていればこのテストが落ちる＝「氏名を触らない」を機械的に固定できる。 */
  setRoster(c, [Object.assign({}, ROSTER[0], { name: '入居者 Ａ' }), ROSTER[1], ROSTER[2]]);
  const r = res({ id: 10, name: '入居者A', room: '202', yomi: 'ニュウキョシャビー', masterId: 2,
                  schedule: [{ t: '08:00' }], hospitalizations: [{ in: '2026-01-01' }], laxNote: 'メモ' });
  c.D.residents = [r];
  c.D.records = [{ id: 'rec1', residentId: 10, datetime: '2026-08-01T09:00' }];
  const beforeName = r.name, beforeId = r.id;
  const beforeRecs = JSON.stringify(c.D.records);
  const idx = c.buildRosterIndex();
  const n = c.__applyRepair([{ r: r, cand: idx.byMid['1'] }]);
  t('修復件数を返す', () => eq(n, 1));
  t('紐づけが正しい相手へ張り替わる', () => eq(r.masterId, 1));
  t('居室とフリガナが本人のものになる', () => { eq(r.room, '101'); eq(r.yomi, 'ニュウキョシャエー'); });
  t('【不変】氏名は1文字も変わらない', () => eq(r.name, beforeName));
  t('【不変】入居者idは変わらない', () => eq(r.id, beforeId));
  t('【不変】記録は一切変わらない', () => eq(JSON.stringify(c.D.records), beforeRecs));
  t('【不変】排泄予定・入院履歴・下剤メモは変わらない', () => {
    eq(r.schedule, [{ t: '08:00' }]); eq(r.hospitalizations, [{ in: '2026-01-01' }]); eq(r.laxNote, 'メモ');
  });
  t('サーバーへ saveRes を1件だけ送る（シートの汚染も是正）', () => {
    eq(c.pushes.length, 1); eq(c.pushes[0].action, 'saveRes');
  });
  /* 冪等性: 修復後は点検で対象が消える */
  c._invalidateLinkIdx();
  const after = c.auditResLinks();
  t('冪等：修復後は要修復0件・正常1件', () => { eq(after.items.length, 0); eq(after.ok, 1); });
}
{
  /* 居室が空の名簿行では居室を消さない（isValidRes で入居者が画面から消えるのを防ぐ） */
  const c = makeCtx();
  setRoster(c, [{ masterId: 1, name: '入居者A', kana: '', room: '', active: true }]);
  const r = res({ id: 10, name: '入居者A', room: '101', yomi: 'エー', masterId: 5 });
  c.D.residents = [r];
  const idx = c.buildRosterIndex();
  c.__applyRepair([{ r: r, cand: idx.byMid['1'] }]);
  t('名簿の居室が空なら居室を空にしない', () => eq(r.room, '101'));
  t('名簿のフリガナが空ならフリガナを空にしない', () => eq(r.yomi, 'エー'));
}

console.log('\n=== H. 誤リンク中は外向きの書き込みと入院表示を止める ===');
{
  const c = makeCtx(); setRoster(c, ROSTER);
  /* 入居者Aの行が入居者B（入院中）へ誤リンクしている状態 */
  const bad = res({ id: 10, name: '入居者A', room: '101', masterId: 2, masterHosp: true });
  const good = res({ id: 11, name: '入居者B', room: '202', masterId: 2, masterHosp: true });
  t('誤リンクの行ではマスタの入院フラグを信じない（別人の入院で入力を止めない）', () => eq(c.isHospNow(bad), false));
  t('正しいリンクの行では従来どおり入院中として扱う（C6 維持）', () => eq(c.isHospNow(good), true));
  t('自分で登録した入院履歴は誤リンクでも有効', () => {
    const h = res({ id: 12, name: '入居者A', room: '101', masterId: 2,
      hospitalizations: [{ admissionAt: '2020-01-01T00:00' }] });
    eq(c.isHospNow(h), true);
  });
}
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.apiUrl = 'https://example.invalid/exec';
  const bad = res({ id: 10, name: '入居者A', room: '101', masterId: 2,
    hospitalizations: [{ admissionAt: '2020-01-01T00:00' }] });
  c.pushMasterHospState(bad, false);
  t('【他アプリ保護】誤リンク中は入居者マスタへ入院状態を送らない', () => eq(c.pushes.length, 0));
  t('送らなかったことを職員に伝える（無言で止めない）', () => ok(c.toasts.length === 1 && /紐づけ/.test(c.toasts[0])));
  const good = res({ id: 11, name: '入居者B', room: '202', masterId: 2,
    hospitalizations: [{ admissionAt: '2020-01-01T00:00' }] });
  c.pushMasterHospState(good, false);
  t('正しいリンクなら従来どおりマスタへ併送する（C4 維持）', () => {
    eq(c.pushes.length, 1); eq(c.pushes[0].action, 'setMasterState'); eq(c.pushes[0].data.masterId, '2');
  });
}

console.log('\n=== I. 点検の集計（auditResLinks） ===');
{
  const c = makeCtx(); setRoster(c, ROSTER);
  c.D.residents = [
    res({ id: 10, name: '入居者A', room: '101', masterId: 1 }),                 // ok
    res({ id: 11, name: '入居者B', room: '999', masterId: 3 }),                 // mismatch（自動修復可）
    res({ id: 12, name: '入居者X', room: '888', masterId: 99 }),                // unknown（名簿に該当なし＝要手動）
    res({ id: 13, name: '入居者Y', room: '777' }),                              // none（未連携）
    res({ id: 90, name: '職員S', room: 'STAFF', yomi: 'S0000', hidden: true }), // 職員（対象外）
    res({ id: 14, name: '入居者Z', room: '666', masterId: 1, active: false }),  // 退去（対象外）
  ];
  const a = c.auditResLinks();
  t('在籍の入居者だけを数える（職員・退去は除く）', () => eq(a.total, 4));
  t('正常1・未連携1', () => { eq(a.ok, 1); eq(a.none, 1); });
  t('要修復2件（別人1・該当なし1）', () => eq(a.items.length, 2));
  t('自動修復できるのは氏名が一意に一致する1件', () => { eq(a.fixable, 1); eq(a.manual, 1); });
}
{
  const c = makeCtx();
  c.D.residents = [res({ id: 10, name: '入居者A', room: '101', masterId: 1 })];
  const a = c.auditResLinks();
  t('名簿が無い端末では1件も要修復に出さない（判定不能で騒がない）', () => eq(a.items.length, 0));
}

console.log('\n=== J. 事故の再現（端末データ消去 → 起動時マージ → 同期） ===');
{
  /* 実際に起きた順番をそのまま再現する。
     ・共有名簿の並び（＝マスタのシート行順）は B, A, C
     ・サーバー Residents の id は登録順で A=6, B=7, C=8（サンプル5件と重なる帯）
     旧実装では「サンプル5件で1〜5が埋まる → 名簿を6,7,8でローカル採番 → 同期でidが入れ替わる」
     の順で masterId だけが別人へ移り、氏名は正しいまま居室・ヨミが別人になった。 */
  const rosterOrder = [ROSTER[1], ROSTER[0], ROSTER[2]];          // B, A, C
  const server = [
    { id: 6, name: '入居者A', yomi: 'ニュウキョシャエー', room: '101', active: true },
    { id: 7, name: '入居者B', yomi: 'ニュウキョシャビー', room: '202', active: true },
    { id: 8, name: '入居者C', yomi: 'ニュウキョシャシー', room: '303', active: true },
  ];

  // ── 現行実装（サンプル抑止＋noAdd＋氏名ゲート） ──
  const c = makeCtx(); setRoster(c, rosterOrder);
  c.D.residents = [];                                             // 接続済み端末はサンプルを作らない
  c.mergeCommonResidents(null, { noAdd: true });                  // 同期前は新規採番しない
  t('同期前は1人もローカル採番しない', () => eq(c.D.residents.length, 0));
  c.D.residents = c.__syncTransplant(server.map(o => Object.assign({}, o)), c.D.residents);
  c._invalidateLinkIdx();
  c.mergeCommonResidents();                                        // 同期後のマージ（従来どおり）
  const byName = {}; c.D.residents.forEach(r => (byName[r.name] = r));
  t('復旧後：入居者Aの居室・ヨミ・紐づけが本人のもの', () => {
    eq(byName['入居者A'].room, '101'); eq(byName['入居者A'].yomi, 'ニュウキョシャエー'); eq(byName['入居者A'].masterId, 1);
  });
  t('復旧後：入居者Bも本人のもの', () => { eq(byName['入居者B'].room, '202'); eq(byName['入居者B'].masterId, 2); });
  t('復旧後：入居者Cも本人のもの', () => { eq(byName['入居者C'].room, '303'); eq(byName['入居者C'].masterId, 3); });
  t('復旧後：要修復0件', () => { c._invalidateLinkIdx(); eq(c.auditResLinks().items.length, 0); });
  t('復旧後：入居者idはサーバーのまま（記録が孤児にならない）',
    () => eq(c.D.residents.map(r => r.id).sort(), [6, 7, 8]));

  // ── 旧実装の条件（サンプルが id 1〜5 を占め、noAdd 無しで先にローカル採番）でも壊れないこと ──
  const c2 = makeCtx(); setRoster(c2, rosterOrder);
  c2.D.residents = [1, 2, 3, 4, 5].map(i => res({ id: i, name: '見本' + i, room: '10' + i, _seed: true }));
  c2.mergeCommonResidents();                                       // ← 旧経路: ローカル採番で 6,7,8 を作る
  t('旧条件では名簿順にローカル採番される（事故の前提を再現できている）', () => {
    const added = c2.D.residents.filter(r => r.masterId != null).map(r => [r.id, r.name]);
    eq(added, [[6, '入居者B'], [7, '入居者A'], [8, '入居者C']]);
  });
  c2.D.residents = c2.__syncTransplant(server.map(o => Object.assign({}, o)), c2.D.residents);
  c2._invalidateLinkIdx();
  c2.mergeCommonResidents();
  const byName2 = {}; c2.D.residents.forEach(r => { if (!r._seed) byName2[r.name] = r; });
  t('【本丸】id が入れ替わっても入居者Aに別人の居室が入らない', () => eq(byName2['入居者A'].room, '101'));
  t('【本丸】入居者Aに別人のヨミが入らない', () => eq(byName2['入居者A'].yomi, 'ニュウキョシャエー'));
  t('【本丸】入居者Bにも別人の値が入らない', () => { eq(byName2['入居者B'].room, '202'); eq(byName2['入居者B'].yomi, 'ニュウキョシャビー'); });
  t('氏名は全員そのまま', () => eq(Object.keys(byName2).sort(), ['入居者A', '入居者B', '入居者C']));
}

/* ── K. 名簿から新しく取り込む方をサーバーへ送る（2026-10-25・入居者番号の混線の直し・案A を「新しく取り込む方だけ」に絞った） ── */
console.log('\n=== K. 名簿から新しく取り込む方をサーバーへ送る（2026-10-25・入居者番号の混線の直し・案A） ===');
const ROSTER_T = ROSTER.map(r => Object.assign({ targetApps: ['excretion'] }, r));
{
  /* 取り込み: 接続先のある端末は作らずに候補に置く・接続先の無い端末は今までどおり */
  const c = makeCtx(); setRoster(c, ROSTER_T);
  c.apiUrl = 'https://example.invalid/exec'; let soon = 0; c.hbResHealSoon = () => { soon++; };
  c.mergeCommonResidents();
  t('接続先のある端末: 名簿の新しい方をその場では作らない', () => eq(c.D.residents.length, 0));
  t('候補に置き、照らし合わせを呼ぶ（masterId ごと・1回）', () => { eq(Object.keys(c._resImportQ).sort(), ['1', '2', '3']); eq(soon, 1); });
  t('候補にも入院の写しを持つ', () => eq(c._resImportQ['2'].hosp, true));
  t('サーバーへは何も送らない（作る時に送る）', () => eq(c.pushes.length, 0));
  const o = makeCtx(); setRoster(o, ROSTER_T); o.mergeCommonResidents();
  t('接続先の無い端末は今までどおりその場で作る（nextResId）', () => { eq(o.D.residents.map(r => r.id), [1, 2, 3]); eq(Object.keys(o._resImportQ).length, 0); });
}
{
  /* 番号の決め方・高水位 */
  const c = makeCtx();
  const a = c.hbResHashId(42), b = makeCtx().hbResHashId('42');
  t('この方の番号は masterId から決まり、専用の幅（10億〜20億）に入る', () => { eq(a, b); ok(a >= 1e9 && a < 2e9); ok(c.hbResHashId(43) !== a); });
  t('作る番号は、使われていなければこの方の番号', () => eq(c.hbResIdFor(42, [], {}), a));
  t('手元にこの方の番号の記録が残っていれば（入居者マスタの番号の使い回し）、専用の幅の別の番号', () => {
    const r = makeCtx(); r.D.records = [{ id: 'x', residentId: String(a) }]; const z = r.hbResIdFor(42, [], {}); ok(z !== a && z >= 1e9 && z < 2e9);
  });
  t('この方の番号が手元かサーバーで使われていれば、専用の幅の別の番号', () => {
    const x = c.hbResIdFor(42, [res({ id: a, name: 'Z' })], {}); ok(x !== a && x >= 1e9 && x < 2e9);
    const y = c.hbResIdFor(42, [], { [a]: 1 }); ok(y !== a && y >= 1e9 && y < 2e9);
  });
  c._store.set(c.K.RES_ID_HW_KEY, '1500000000');
  t('高水位が専用の幅の値なら数えない（nextResId が同じ番号を返し続けない）', () => { eq(c._resIdHw(), 0); c.D.residents = [res({ id: 3, name: 'A' })]; eq(c.nextResId(), 4); });
}
{
  /* 照らし合わせの段取り（純関数） */
  const c = makeCtx();
  const q = (mid, name) => ({ c: { masterId: mid, name, room: '1' + mid }, tExc: true });
  const P = (srv, cands, residents, nc, byMid) => c.hbResPlan(srv, cands, residents || [], nc ? { nameCount: nc, byMid: byMid || {} } : null);
  t('どこにも同じ氏名がいなければ作る', () => eq(P([], [q(1, '入居者A')]).create.length, 1));
  t('もう結ばれている方（表記ゆれで氏名が違っても）は作らない・点検にも出さない', () => { const p = P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者亜', masterId: 1 })]); eq([p.create.length, p.notMade.length], [0, 0]); });
  t('サーバーにこの方の番号で同じ氏名の行がある（よその端末が作った）→ 作らない・点検にも出さない（同姓同名でも）', () => {
    const p = P([{ id: c.hbResHashId(1), name: '入居者A', active: true }], [q(1, '入居者A')], [], { [c._normNameX('入居者A')]: 2 });
    eq([p.create.length, p.notMade.length], [0, 0]);
  });
  t('サーバーにこの方の番号で氏名の違う行がある → 作らずに点検（hashName・乱数の2行目を作らない）', () => {
    const p = P([{ id: c.hbResHashId(7), name: '入居者齊', active: true }], [q(7, '入居者斉')]); eq(p.notMade.map(x => x.why), ['hashName']); eq(p.create.length, 0);
  });
  t('居室かふりがなが同じで、入居者マスタと結ばれていない在籍の行（手元）がある → 作らずに点検（similar）', () => {
    eq(P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者亜', room: '11' })]).notMade.map(x => x.why), ['similar']);
    eq(P([], [{ c: { masterId: 1, name: '入居者A', room: '999', kana: 'ニュウキョシャエー' } }], [res({ id: 5, name: '入居者亜', room: '1', yomi: 'にゅうきょしゃえー' })]).notMade.map(x => x.why), ['similar']);
  });
  t('居室が同じでも、退去の行・名簿の方と結ばれた行は妨げない', () => {
    eq(P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者亜', room: '11', active: false })]).create.length, 1);
    eq(P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者亜', room: '11', masterId: 9 })], { x: 1 }, { 9: {} }).create.length, 1);
  });
  t('名簿に無い masterId と結ばれた（ずれた）同じ居室の行は、結ばれていない行として扱う', () => {
    eq(P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者亜', room: '11', masterId: 88 })], { x: 1 }, { 9: {} }).notMade.map(x => x.why), ['similar']);
  });
  t('まだ手元に届いていないサーバーの行で居室が同じ → 作らずに点検（similar）', () => {
    eq(P([{ id: 50, name: '入居者亜', room: '11', active: true }], [q(1, '入居者A')]).notMade.map(x => x.why), ['similar']);
    eq(P([{ id: 50, name: '入居者亜', room: '11', active: true }], [q(1, '入居者A')], [res({ id: 50, name: '入居者亜', room: '11', masterId: 9 })], { x: 1 }, { 9: {} }).create.length, 1);
  });
  t('サーバーに同じ氏名（空白違い）の在籍の方がいる → 作らない（次の同期で名簿の氏名で結ばれる）・点検に出さない', () => {
    const p = P([{ id: '9', name: '入居者 A', active: 'TRUE' }], [q(1, '入居者A')]); eq([p.create.length, p.notMade.length], [0, 0]);
  });
  t('サーバーの同じ氏名の方が退去（"FALSE"）なら妨げない', () => eq(P([{ id: 9, name: '入居者A', active: 'FALSE' }], [q(1, '入居者A')]).create.length, 1));
  t('手元に同じ氏名の在籍の行がある → 作らない', () => eq(P([], [q(1, '入居者A')], [res({ id: 5, name: '入居者A' })]).create.length, 0));
  t('名簿に同じ氏名が2人以上いて、同じ氏名の行がある → 作らずに点検（multi）', () => {
    const p = P([{ id: 9, name: '入居者A', active: true }], [q(21, '入居者A')], [], { [c._normNameX('入居者A')]: 2 });
    eq(p.notMade.map(x => [x.q.c.masterId, x.why]), [[21, 'multi']]);
  });
  t('手元の同じ氏名の行が名簿の別の方と結ばれている → 作らずに点検（other）', () => {
    const p = P([], [q(2, '入居者B')], [res({ id: 30, name: '入居者B', masterId: 99 })]);
    eq(p.notMade.map(x => [x.q.c.masterId, x.why]), [[2, 'other']]);
  });
}
{
  /* この方の番号で結ぶ（よその端末が作った行） */
  const c = makeCtx();
  const h = c.hbResHashId(1);
  c.D.residents = [res({ id: h, name: '入居者 A', room: '101' })];
  t('手元にこの方の番号で同じ氏名のまだ結ばれていない行があれば結ぶ', () => { eq(c.hbResLinkByHash({ masterId: 1, name: '入居者A' }), true); eq(c.D.residents[0].masterId, 1); });
  const d = makeCtx(); d.D.residents = [res({ id: h, name: '入居者Q' }), res({ id: d.hbResHashId(2), name: '入居者B', masterId: 7 })];
  t('氏名が違う・もう別の方と結ばれている行は結ばない', () => {
    eq(d.hbResLinkByHash({ masterId: 1, name: '入居者A' }), false); eq(d.hbResLinkByHash({ masterId: 2, name: '入居者B' }), false);
    eq(d.D.residents.map(r => r.masterId), [undefined, 7]);
  });
}
{
  /* この端末にだけある入居者（点検に数と番号を出すだけ） */
  const c = makeCtx();
  c.D.residents = [res({ id: 1, name: 'A' }), res({ id: 2, name: 'B' }), res({ id: 3, name: 'C', _seed: true }), res({ id: 4, name: 'D', room: '_staff_' })];
  t('まだ同期していなければ出さない', () => eq(c.hbResLocalOnly(), []));
  c.hbResNoteSrv([{ id: '1' }]);
  t('前回の同期でサーバーに無かった行を出す（見本・職員の行は除く）', () => eq(c.hbResLocalOnly().map(r => r.id), [2]));
  c._resSrvIds = c._resSrvIds; c.apiPush = () => {};
  c.hbResMake({ c: { masterId: 3, name: 'E', room: '1' } }, {});
  t('この画面で作って送った行は、この端末にだけある入居者に数えない', () => eq(c.hbResLocalOnly().map(r => r.id), [2]));
}
{
  /* 名簿の人数・デイの〔加える〕との重なり・入居者マスタから開いた方の開き直し */
  const c = makeCtx();
  setRoster(c, [{ masterId: 1, name: '入居者A', active: true }, { masterId: 2, name: '入居者 A', active: true }, { masterId: 3, name: '入居者A', active: false }, { masterId: 4, name: '入居者B', active: true }]);
  const ri = c.hbResRosterInfo();
  t('同じ氏名の人数は共有名簿の在籍の方で数える（mergeCommonResidents と同じ数え方）', () => { eq(ri.nameCount[c._normNameX('入居者A')], 2); eq(Object.keys(ri.byMid).sort(), ['1', '2', '3', '4']); });
  const d = makeCtx(); setRoster(d, ROSTER);
  d._resImportQ['m9'] = { c: { masterId: 'm9', name: '入居者N', room: '909' } };
  const idx = { byMid: { m9: { masterId: 'm9', name: '入居者N', kana: 'エヌ', room: '909', active: true } }, nameCount: {} };
  const m = d.hbDcMissing([], { mids: ['m9'] }, idx, () => true);
  t('デイの〔加える〕: 名簿から取り込んでいる最中の方は加えさせない（二重に足さない）', () => { eq(m.rows[0].act, null); ok(m.rows[0].why.includes('取り込んでいる')); });
  delete d._resImportQ['m9'];
  t('取り込みが済めば今までどおり加えられる', () => eq(d.hbDcMissing([], { mids: ['m9'] }, idx, () => true).rows[0].act, 'add'));
  const e = makeCtx(); let reopened = 0; e.hbMasterPending = 'm1'; e.hbApplyMasterIdParam = (r) => { if (r === true) reopened++; };
  e._resHealRedraw();
  t('入居者マスタから開いて「登録されていません」だった方は、加わった・結ばれた後に開き直す', () => eq(reopened, 1));
}
async function tAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' — ' + e.message); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const asyncK = (async () => {
  function healCtx(srvRes) {
    const c = makeCtx(); setRoster(c, ROSTER_T);
    c.apiUrl = 'https://example.invalid/exec';
    c.gets = 0;
    c.apiGet = async () => { c.gets++; return (srvRes === null ? null : { residents: srvRes }); };
    return c;
  }
  let c = healCtx([{ id: 1, name: '入居者B', room: '202', active: true }]);
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true, hosp: false };
  c._resImportQ['2'] = { c: ROSTER_T[1], tExc: true, hosp: true };
  await c.hbResHeal();
  const made = c.D.residents.filter(r => r.masterId === 1);
  await tAsync('候補: サーバーを読み直し、いなければこの方の番号（専用の幅）で作ってすぐ saveRes で送る', async () => {
    eq(made.length, 1); eq(made[0].id, c.hbResHashId(1)); eq(made[0]._fromMaster, true); eq(made[0].masterHosp, false); eq(made[0].targetExcretion, true);
    eq(c.pushes.map(x => [x.action, x.data.resident.masterId]), [['saveRes', 1]]);
  });
  await tAsync('候補: サーバーに同じ氏名の在籍の方がいれば作らない', async () => eq(c.D.residents.filter(r => r.masterId === 2).length, 0));
  await tAsync('候補は今回で外す（まだ要る方は次の同期で置き直される）', async () => eq(Object.keys(c._resImportQ).length, 0));
  c = healCtx(null);
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  await c.hbResHeal();
  await tAsync('サーバーを読めなければ何もしない（候補は残す）', async () => { eq(c.D.residents.length, 0); eq(c.pushes.length, 0); eq(Object.keys(c._resImportQ), ['1']); });
  c = healCtx([]); c.apiUrl = '';
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  await c.hbResHeal();
  await tAsync('接続先の無い端末では動かない', async () => { eq(c.D.residents.length, 0); eq(c.gets, 0); });
  c = healCtx([]); c._locked = false;
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  c.apiGet = async () => { c._locked = true; return { residents: [] }; };
  await c.hbResHeal();
  await tAsync('待っている間に自動ロックが掛かったら何もしない', async () => { eq(c.D.residents.length, 0); eq(c.pushes.length, 0); });
  c = healCtx([]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  await c.hbResHeal();
  await tAsync('端末の中だけにある既存の行は送らない（サーバーも読まない）', async () => { eq(c.pushes.length, 0); eq(c.gets, 0); });
  c = healCtx([{ id: 8, name: '入居者A', room: '101', active: true }]);
  setRoster(c, [{ masterId: 1, name: '入居者A', room: '101', active: true, targetApps: ['excretion'] }, { masterId: 21, name: '入居者A', room: '121', active: true, targetApps: ['excretion'] }]);
  c._resImportQ['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, tExc: true };
  await c.hbResHeal();
  await tAsync('名簿に同じ氏名が2人いて作らなかった方は、点検（作らなかった方）に置く', async () => { eq(c.D.residents.length, 0); eq(Object.keys(c._resNotMade), ['21']); eq(c._resNotMade['21'].why, 'multi'); });
  c._resImportQ['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, tExc: true };
  await c.hbResHeal();
  await tAsync('作らなかった方は、この画面では照らし合わせ直さない（同期ごとにサーバーを読まない）', async () => { eq(c.gets, 1); eq(Object.keys(c._resImportQ).length, 0); });
  /* 作らなかった方の行が、ほかの端末で作られて同期で届いた → 次の照らし合わせで番号で結び、点検から外す（確認の反証 1） */
  {
    const e = healCtx([]); setRoster(e, [{ masterId: 1, name: '入居者A', room: '101', active: true, targetApps: ['excretion'] }, { masterId: 21, name: '入居者A', room: '121', active: true, targetApps: ['excretion'] }]);
    e._resNotMade['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, why: 'multi' };
    e.D.residents = [res({ id: e.hbResHashId(21), name: '入居者A', room: '121' })];
    e._resImportQ['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, tExc: true };
    await e.hbResHeal();
    await tAsync('作らなかった方の番号の行が届けば、次の照らし合わせで結び、点検から外す（サーバーは読まない）', async () => {
      eq(e.D.residents[0].masterId, 21); eq(Object.keys(e._resNotMade).length, 0); eq(e.gets, 0); eq(e.pushes.length, 0);
    });
  }
  {
    const f = makeCtx(); setRoster(f, ROSTER_T); f.apiUrl = 'https://example.invalid/exec';
    f._resNotMade['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, why: 'multi' };
    f.apiGet = async () => ({ residents: [{ id: f.hbResHashId(21), name: '入居者A', room: '121', active: true }] });
    await f.hbResAddNotMade('21');
    await tAsync('〔加える〕: サーバーにこの方の番号の行があれば、2行目を作らない（次の同期で結ぶ）', async () => { eq(f.D.residents.length, 0); eq(f.pushes.length, 0); ok(f.toasts.some(m => m.includes('ほかの端末で作られています'))); });
    f.D.residents = [res({ id: f.hbResHashId(21), name: '入居者A', room: '121' })];
    await f.hbResAddNotMade('21');
    await tAsync('〔加える〕: 手元にこの方の番号の行が届いていれば、作らずに結ぶ', async () => { eq(f.D.residents.map(r => r.masterId), [21]); eq(f.pushes.length, 0); eq(Object.keys(f._resNotMade).length, 0); });
  }
  {
    /* 出口: 〔…と結ぶ〕 */
    const g = makeCtx(); setRoster(g, ROSTER_T); g.apiUrl = 'https://example.invalid/exec';
    g._resNotMade['1'] = { c: { masterId: 1, name: '入居者A', room: '101', kana: 'ニュウキョシャエー' }, why: 'similar' };
    g.D.residents = [res({ id: 5, name: '入居者亜', room: '101' }), res({ id: 6, name: '入居者Q', room: '606' }), res({ id: 7, name: '入居者W', room: '101', masterId: 3 })];
    await tAsync('〔…と結ぶ〕に出す行: 結ばれていない在籍の行で、同じ氏名・この方の番号・居室かふりがなが同じもの', async () => eq(g.hbResLinkCands(g._resNotMade['1'].c).map(r => r.id), [5]));
    g.customConfirm = async () => false;
    await g.hbResLinkNotMade('1', '5');
    await tAsync('〔…と結ぶ〕を確かめの小窓で取り消すと結ばない', async () => { eq(g.D.residents[0].masterId, undefined); eq(Object.keys(g._resNotMade), ['1']); });
    let gm = ''; g.customConfirm = async (m) => { gm = m; return true; };
    await g.hbResLinkNotMade('1', '5');
    await tAsync('〔…と結ぶ〕: 確かめてから結び、氏名の表記が違えば表記ゆれの印を付ける・点検から外す・記録は送らない', async () => {
      ok(gm.includes('同じ方であることを確かめてください')); eq([g.D.residents[0].masterId, g.D.residents[0].midAck], [1, true]);
      eq(Object.keys(g._resNotMade).length, 0); eq(g.pushes.filter(x => x.action !== 'saveRes').length, 0);
    });
    const h = makeCtx(); h._resNotMade['1'] = { c: { masterId: 1, name: '入居者A', room: '101' }, why: 'similar' };
    h.D.residents = [res({ id: 5, name: '入居者亜', room: '101', masterId: 9 })]; let asked2 = 0; h.customConfirm = async () => { asked2++; return true; };
    await h.hbResLinkNotMade('1', '5');
    await tAsync('〔…と結ぶ〕: その行がもう別の方と結ばれていれば結ばない（小窓も出さない）', async () => { eq(asked2, 0); eq(h.D.residents[0].masterId, 9); });
  }
  /* 出口: 〔排泄ケア記録に加える〕 */
  c.customConfirm = async () => false;
  await c.hbResAddNotMade('21');
  await tAsync('〔加える〕を確かめの小窓で取り消すと何もしない', async () => { eq(c.D.residents.length, 0); eq(Object.keys(c._resNotMade), ['21']); });
  let msg = ''; c.customConfirm = async (m) => { msg = m; return true; };
  await c.hbResAddNotMade('21');
  await tAsync('〔加える〕: 確かめてからサーバーを読み直し、専用の幅の番号で作ってすぐ送る・一覧から外す', async () => {
    ok(msg.includes('別の方であることを確かめてから')); eq(c.D.residents.map(r => r.masterId), [21]); ok(c.D.residents[0].id >= 1e9);
    eq(c.pushes.map(x => x.action), ['saveRes']); eq(Object.keys(c._resNotMade).length, 0);
  });
  c = healCtx(null); c._resNotMade['5'] = { c: { masterId: 5, name: '入居者E', room: '505' }, why: 'multi' }; c.customConfirm = async () => true;
  await c.hbResAddNotMade('5');
  await tAsync('〔加える〕: サーバーを読めなければ加えない（知らせる・一覧に残す）', async () => { eq(c.D.residents.length, 0); ok(c.toasts.some(m => m.includes('サーバーを読めない'))); eq(Object.keys(c._resNotMade), ['5']); });
  c = healCtx([]); c._resNotMade['5'] = { c: { masterId: 5, name: '入居者E', room: '505' }, why: 'multi' }; c.D.residents = [res({ id: 9, name: '入居者E', masterId: 5 })];
  let asked = 0; c.customConfirm = async () => { asked++; return true; };
  await c.hbResAddNotMade('5');
  await tAsync('〔加える〕: もう結ばれていれば、小窓も出さず作らずに一覧から外す', async () => { eq(asked, 0); eq(c.gets, 0); eq(c.D.residents.length, 1); eq(c.pushes.length, 0); eq(Object.keys(c._resNotMade).length, 0); });
  c = healCtx([]); c._resNotMade['5'] = { c: { masterId: 5, name: '入居者E', room: '505' }, why: 'multi' };
  c.customConfirm = async () => { c.D.residents.push(res({ id: 9, name: '入居者E', masterId: 5 })); return true; };
  await c.hbResAddNotMade('5');
  await tAsync('〔加える〕: 小窓を出している間に結ばれれば作らない', async () => { eq(c.D.residents.length, 1); eq(c.pushes.length, 0); eq(Object.keys(c._resNotMade).length, 0); });
  c = healCtx([]);
  c.D.residents = [res({ id: c.hbResHashId(1), name: '入居者A', room: '101' })];
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  await c.hbResHeal();
  await tAsync('手元にこの方の番号の行があれば、サーバーを読まずに結ぶ（作らない）', async () => { eq(c.D.residents.map(r => r.masterId), [1]); eq(c.gets, 0); eq(c.pushes.length, 0); });
  /* 削除の確かめ: 入居者マスタで対象のままの方には注意を足す（削除は今までどおり送る） */
  const d = makeCtx(); setRoster(d, ROSTER_T); d.apiUrl = 'https://example.invalid/exec';
  d.msgs = []; d.customConfirm = async (m) => { d.msgs.push(m); return true; };
  d.D.residents = [res({ id: 9, name: '入居者A', masterId: 1 }), res({ id: 10, name: '入居者Z', masterId: 77 })];
  await d.delRes(9); await d.delRes(10);
  await tAsync('入居者マスタで排泄の対象のままの方を消す時だけ、先に対象から外すよう小窓に書く', async () => {
    ok(d.msgs[0].includes('先に入居者マスタで対象から外してください')); ok(!d.msgs[1].includes('入居者マスタ'));
  });
  await tAsync('削除は今までどおりサーバーへ送る', async () => eq(d.pushes.map(x => x.action + ':' + x.data.id), ['delRes:9', 'delRes:10']));
})();

asyncK.then(() => {
  console.log('\n────────────────────────────────────────');
  console.log(fail === 0 ? `✅ 全 ${pass} 件 PASS` : `❌ ${fail} 件 FAIL / ${pass} 件 PASS`);
  if (fail) { failures.forEach(f => console.log('   - ' + f)); process.exit(1); }
}, (e) => { console.log('✗ 例外: ' + (e && e.stack || e)); process.exit(1); });
