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
  /* 送信の列・未送信の控え（待たせ・捨ての試験用の最小の写し） */
  sandbox._writeQ = []; sandbox._pqFlushing = false; sandbox._pq = [];
  sandbox._wqPersist = function () {};
  sandbox.loadPendingQueue = function () { return sandbox._pq.slice(); };
  sandbox.savePendingQueue = function (q) { sandbox._pq = q.slice(); };
  sandbox.hbFieldDeny = function () { return false; };
  sandbox.renderLinkAudit = function () {};
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
    '  var _locSched=globalThis.__locSched||{},_psHealList=globalThis.__psHeal=[];\n' +
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
    /* 取り込んだ入居者をサーバーへ送る（2026-10-25・入居者番号の混線の直し）。接続先（apiUrl）を置かない区画では今までどおりの動き */
    extractVar('DC_ID_MIN'), extractFn('_isDcId'), extractFn('hbDcNewId'),
    extractVar('_resImportQ'), extractVar('_resHealChecked'), extractVar('_resHealFirst'), extractVar('RES_HEAL_EXISTING'),
    extractFn('hbMasterTargetSet'), extractFn('hbResNeedsSend'), extractFn('hbResCollides'), extractFn('hbResPlan'),
    extractFn('hbResHeal'), extractFn('hbResIssueAdd'), extractFn('hbResIdFor'),
    extractVar('RES_ISSUE_KEY'), extractFn('hbResIssueLoad'), extractFn('hbResIssueSave'), extractFn('hbResIssueKey'),
    extractFn('hbResIssueHasId'), extractFn('hbResIssueHasMid'), extractFn('hbResIssueDismiss'),
    extractFn('hbResTombLoad'), extractFn('hbResTombAdd'), extractFn('hbResTombHas'),
    extractVar('RES_PURGED_KEY'), extractVar('_resPurged'), extractFn('_resItemTarget'),
    extractFn('hbResHoldItem'), extractFn('hbResKeepOrder'), extractFn('hbResDropItem'), extractFn('hbResPurgeQueued'),
    /* const 宣言は vm の globalThis に載らないため、テストから使うキー名を明示的に公開する */
    'globalThis.K={SU_COMMON_KEY:SU_COMMON_KEY,MASTER_ROSTER_KEY:MASTER_ROSTER_KEY,' +
    'MASTER_ROSTER_TS_KEY:MASTER_ROSTER_TS_KEY,RES_ID_HW_KEY:RES_ID_HW_KEY,RES_ISSUE_KEY:RES_ISSUE_KEY,RES_PURGED_KEY:RES_PURGED_KEY};',
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

console.log('\n=== K. 取り込んだ入居者をサーバーへ送る（2026-10-25・入居者番号の混線の直し・案A） ===');
async function tAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' — ' + e.message); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const ROSTER_T = ROSTER.map(r => Object.assign({ targetApps: ['excretion'] }, r));
{
  /* 取り込み: 接続先のある端末は作らずに候補に置く・接続先の無い端末は今までどおり */
  const c = makeCtx(); setRoster(c, ROSTER_T);
  c.apiUrl = 'https://example.invalid/exec'; let soon = 0; c.hbResHealSoon = () => { soon++; };
  c.mergeCommonResidents();
  t('接続先のある端末: 名簿の新しい方をその場では作らない', () => eq(c.D.residents.length, 0));
  t('候補に置き、照らし合わせを呼ぶ（masterId ごと）', () => { eq(Object.keys(c._resImportQ).sort(), ['1', '2', '3']); eq(soon, 1); });
  t('候補にも入院の写しを持つ（新しい名簿の時だけ）', () => eq(c._resImportQ['2'].hosp, true));
  t('サーバーへは何も送らない（作る時に送る）', () => eq(c.pushes.length, 0));
  const o = makeCtx(); setRoster(o, ROSTER_T); o.mergeCommonResidents();
  t('接続先の無い端末は今までどおりその場で作る（nextResId）', () => { eq(o.D.residents.map(r => r.id), [1, 2, 3]); eq(Object.keys(o._resImportQ).length, 0); });
}
{
  /* 送るべき既存の行の条件（確認の反証 1: 待たせる行と送る行を揃える＝在籍・非表示・居室・名簿の対象かは問わない） */
  const c = makeCtx();
  const base = { id: 7, name: '入居者A', room: '101', masterId: 1, _fromMaster: true, active: true };
  t('取り込んだだけ・一度もサーバーに無い → 送る', () => eq(c.hbResNeedsSend(res(base)), true));
  t('一度サーバーにあった行（その後消された）は送らない（削除を生き返らせない）', () => eq(c.hbResNeedsSend(res(Object.assign({}, base, { _srvSeen: true }))), false));
  t('取り込みの印の無い行（手で足した行・サーバーの行）は送らない', () => eq(c.hbResNeedsSend(res(Object.assign({}, base, { _fromMaster: undefined }))), false));
  t('退去・非表示・居室なし・連携を外した・名簿が無い行も送る（待たせた送信が解けずに残らないよう）', () => {
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { active: false }))), true);
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { hidden: true }))), true);
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { room: '' }))), true);
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { masterId: undefined }))), true);
  });
  t('氏名の無い行・デイだけの方は送らない', () => {
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { name: '' }))), false);
    c.hbIsDayOnly = (r) => !!(r.cfg && r.cfg.dayOnly === true);
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { cfg: { dayOnly: true } }))), false);
  });
  t('この画面で送った行は二度送らない', () => { c._resHealSent['7'] = 1; eq(c.hbResNeedsSend(res(base)), false); delete c._resHealSent['7']; });
  t('同じ氏名の方がサーバーにいて送らなかった行は、氏名が同じ間はこの画面で照らし合わせ直さない（氏名を直せば直す）', () => {
    c._resHealChecked['7'] = c._normNameX('入居者A');
    eq(c.hbResNeedsSend(res(base)), false);
    eq(c.hbResNeedsSend(res(Object.assign({}, base, { name: '入居者A（2）' }))), true);
  });
  const c2 = makeCtx(); setRoster(c2, [{ masterId: 1, name: 'A', active: true, targetApps: ['excretion'] }, { masterId: 2, name: 'B', active: true, targetApps: ['weight'] }, { masterId: 3, name: 'C', active: false }, { masterId: 4, name: 'D', active: true }]);
  t('名簿の対象（削除の確かめの注意に使う）: 在籍で excretion を含む方（targetApps の無い名簿は対象とみなす）', () => eq(Object.keys(c2.hbMasterTargetSet()).sort(), ['1', '4']));
}
{
  /* 照らし合わせの段取り（純関数） */
  const c = makeCtx();
  const L = (o) => res(Object.assign({ room: '101', _fromMaster: true }, o));
  const srv = [{ id: 7, name: '入居者Q', active: true }, { id: '9', name: '入居者A', active: 'TRUE' }, { id: 11, name: '入居者X', active: 'FALSE' }];
  const p = c.hbResPlan(srv, [L({ id: 7, name: '入居者P', masterId: 1 }), L({ id: 8, name: '入居者 A', masterId: 2 }), L({ id: 12, name: '入居者X', masterId: 3 }), L({ id: 13, name: '入居者Y', masterId: 4 })], [], []);
  t('同じ番号の別の方がサーバーにいる → 送らず点検（idTaken）', () => ok(p.issues.some(x => x.kind === 'idTaken' && x.r.id === 7)));
  t('同じ氏名（空白違い）の在籍の方がサーバーに別の番号でいる → 送らず点検（dupName）', () => ok(p.issues.some(x => x.kind === 'dupName' && x.r.id === 8)));
  t('サーバーの同じ氏名の方が退去（"FALSE"）なら妨げない・どこにもいなければ送る', () => eq(p.send.map(r => r.id), [12, 13]));
  const same = c.hbResPlan([{ id: 7, name: '入居者P', active: true }], [L({ id: 7, name: '入居者P', masterId: 1 })], [], []);
  t('同じ番号で同じ方ならもう載っている（送らない・点検にも出さない）', () => { eq(same.send.length, 0); eq(same.issues.length, 0); });
  const q = (mid, name) => ({ c: { masterId: mid, name, room: '1' + mid }, tExc: true });
  const pc = c.hbResPlan([{ id: 5, name: '入居者B', active: true }], [], [q(1, '入居者A'), q(2, '入居者B'), q(3, '入居者C'), q(4, '入居者D')],
    [res({ id: 1, name: '別人', masterId: 3 }), res({ id: 2, name: '入居者D' })]);
  t('候補: サーバーに同じ氏名の在籍の方 → 作らない／もう結ばれている → 作らない／手元に同じ氏名 → 作らない', () => eq(pc.create.map(x => x.c.masterId), [1]));
}
{
  /* 同期のマージ: サーバーにある行に印・番号のぶつかりを点検に出す */
  const c = makeCtx(); setRoster(c, ROSTER);
  c.save = () => {};
  c._pq = [{ action: 'saveSched', data: { id: 5 }, at: 1 }, { action: 'savePadSet', data: { id: 5 }, at: 2 }, { action: 'addRecord', data: { resId: 5 }, at: 3 }];
  c._writeQ.push({ action: 'saveRes', data: { resident: { id: 5 } } });
  const merged = c.__syncTransplant([res({ id: 5, name: '入居者B', room: '202' }), res({ id: 6, name: '入居者C', room: '303' })],
    [res({ id: 5, name: '入居者A', room: '101', masterId: 1, _fromMaster: true }), res({ id: 6, name: '入居者C改', room: '303', masterId: 3, _fromMaster: true, _srvSeen: true }), res({ id: 9, name: '入居者Z', room: '909' })]);
  const iss = () => c.hbResIssueLoad().list;
  t('サーバーの行には _srvSeen の印が付く（手元だけの行には付かない）', () => eq(merged.map(r => [r.id, !!r._srvSeen]), [[5, true], [6, true]]));
  t('取り込んだだけの行と同じ番号の別の方がサーバーにいる → 点検に idTaken', () => eq(iss().map(x => [x.kind, x.id, x.masterId]), [['idTaken', 5, 1]]));
  t('その番号の予定・おむつ・登録内容の送信待ちを外す（記録は外さない）・外した数を点検に残す', () => {
    eq(c._pq.map(x => x.action), ['addRecord']); eq(c._writeQ.length, 0); eq(iss()[0].dropped, 3);
  });
  t('点検の控えに氏名を残さない（番号と時刻だけ）・知らせを出す', () => {
    const raw = c._store.get(c.K.RES_ISSUE_KEY); ok(raw && !raw.includes('入居者')); ok(c.toasts.some(m => m.includes('確かめが要る')));
  });
  t('一度サーバーにあった行の名前の直し（_srvSeen あり）は点検に出さない', () => ok(!iss().some(x => x.id === 6)));
  const c3 = makeCtx(); setRoster(c3, ROSTER); c3.save = () => {};
  c3.__syncTransplant([res({ id: 5, name: '入居者A', room: '101' })], [res({ id: 5, name: '入居者 A', room: '101', masterId: 9, _fromMaster: true })]);
  t('同じ番号のサーバーの行が同じ氏名（空白違いを含む）なら、この端末の送信が届いた同じ方＝点検に出さない', () => eq(c3.hbResIssueLoad().list.length, 0));
  /* ぶつかった時は、手元の方の予定・入院歴・cfg・申し送り・おむつ・紐づけを、サーバーの別の方の行へ写さない（確認の反証 2） */
  const c5 = makeCtx(); c5.save = () => {};
  c5.padSetMerge = (srv, loc) => srv || loc; c5.padSetPending = () => false;
  c5.__locSched = { 5: ['08:00'] };
  const m5 = c5.__syncTransplant([res({ id: 5, name: '入居者Q', room: '505' })],
    [res({ id: 5, name: '入居者A', room: '101', masterId: 9, _fromMaster: true, schedule: ['08:00'], hospitalizations: [{ from: '2026-10-01' }], cfg: { urineWarnH: 5 }, laxNote: 'x', padSet: { day: 'p1' }, masterHosp: true })]);
  t('ぶつかったサーバーの行には、手元の方の予定・入院歴・cfg・申し送り・おむつ・紐づけを写さない', () => {
    const r = m5[0];
    eq([r.name, r.schedule, r.hospitalizations, r.cfg, r.laxNote, r.padSet, r.masterId, r.masterHosp], ['入居者Q', undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
  t('ぶつかった番号は、予定の移行の手元の値から外し、おむつの送り直しにも入れない', () => { eq(c5.__locSched[5], undefined); eq(c5.__psHeal.length, 0); });
  const c6 = makeCtx(); c6.save = () => {};
  c6.padSetMerge = (srv, loc) => srv || loc; c6.padSetPending = () => false;
  const m6 = c6.__syncTransplant([res({ id: 6, name: '入居者B', room: '202' })], [res({ id: 6, name: '入居者B', room: '202', schedule: ['09:00'], padSet: { day: 'p2' } })]);
  t('ぶつからない行（施設の既存の方）の引き継ぎは今までどおり', () => { eq(m6[0].schedule, ['09:00']); eq(m6[0].padSet, { day: 'p2' }); eq(c6.__psHeal.length, 1); });
  const c4 = makeCtx(); c4.save = () => {};
  c4.__syncTransplant([res({ id: 5, name: '入居者Q', room: '101' })], [res({ id: 5, name: '入居者A', room: '101', masterId: 9, _fromMaster: true })]);
  t('名簿に無い方でも、氏名も masterId も違えば点検に出す（別の方の行へ書かないため）', () => eq(c4.hbResIssueLoad().list.map(x => x.kind), ['idTaken']));
  c3.hbResIssueAdd('idTaken', { id: 5, masterId: 9 }); c3.hbResIssueAdd('idTaken', { id: 5, masterId: 9 }, { dropped: 2 });
  t('同じ点検は二重に積まない（外した数だけ足す）', () => { eq(c3.hbResIssueLoad().list.length, 1); eq(c3.hbResIssueLoad().list[0].dropped, 2); });
  c3.hbResIssueDismiss(c3.hbResIssueLoad().list[0].key);
  t('確認した点検は一覧から消え、同じ点検は出し直さない（反証 M1）', () => {
    eq(c3.hbResIssueLoad().list.length, 0); eq(c3.hbResIssueAdd('idTaken', { id: 5, masterId: 9 }), false); eq(c3.hbResIssueLoad().list.length, 0);
  });
  t('番号のぶつかりの点検（確認済みも含む）に出した番号は既存の行として送り直さない', () => {
    eq(c3.hbResNeedsSend(res({ id: 5, name: 'A', room: '1', masterId: 9, _fromMaster: true })), false);
    eq(c3.hbResNeedsSend(res({ id: 7, name: 'A', room: '1', masterId: 9, _fromMaster: true })), true);
  });
}
{
  /* 送信の待たせ・捨て（反証 H1） */
  const c = makeCtx();
  c.D.residents = [res({ id: 5, name: 'A', _fromMaster: true }), res({ id: 6, name: 'B', _fromMaster: true, _srvSeen: true }), res({ id: 7, name: 'C' }),
    res({ id: 8, name: 'D', _fromMaster: true, cfg: { dayOnly: true } })];
  c.hbIsDayOnly = (r) => !!(r.cfg && r.cfg.dayOnly === true);
  const it = (a, id) => (a === 'saveRes' ? { action: a, data: { resident: { id } } } : { action: a, data: { id } });
  t('取り込んだだけで一度もサーバーで確かめていない方への予定・おむつ・登録内容の送信は待たせる', () => {
    eq(c.hbResHoldItem(it('saveSched', 5)), true); eq(c.hbResHoldItem(it('savePadSet', '5')), true); eq(c.hbResHoldItem(it('saveRes', 5)), true);
  });
  t('記録の送信は待たせない', () => eq(c.hbResHoldItem({ action: 'addRecord', data: { id: 'r1', resId: 5 } }), false));
  t('サーバーにある方・手で足した方・デイだけの方・いない番号は待たせない', () => {
    eq(c.hbResHoldItem(it('saveSched', 6)), false); eq(c.hbResHoldItem(it('saveSched', 7)), false);
    eq(c.hbResHoldItem(it('saveSched', 8)), false); eq(c.hbResHoldItem(it('saveSched', 99)), false);
  });
  t('照らし合わせで送った方は待たせない', () => { c._resHealSent['5'] = 1; eq(c.hbResHoldItem(it('saveSched', 5)), false); delete c._resHealSent['5']; });
  c._pq = [Object.assign(it('saveSched', 5), { at: 10 }), Object.assign(it('saveSched', 6), { at: 10 })];
  c._writeQ.push(it('savePadSet', 5), it('saveSched', 6));
  vm.runInContext('Date.now=function(){return 100}', c);
  const n = c.hbResPurgeQueued(5);
  t('ぶつかった番号の送信待ちを、送信の列と未送信の控えから外して数を返す', () => { eq(n, 2); eq(c._pq.map(x => x.data.id), [6]); eq(c._writeQ.map(x => x.data.id), [6]); });
  t('外した番号と時刻は端末に残る（再読み込みしても捨て続ける）', () => eq(JSON.parse(c._store.get(c.K.RES_PURGED_KEY)), { 5: 100 }));
  t('外す前に控えへ積まれた分は捨て、後の分（サーバーの方への正しい送信）は捨てない', () => {
    eq(c.hbResDropItem(Object.assign(it('saveSched', 5), { at: 50 })), true);
    eq(c.hbResDropItem(Object.assign(it('saveSched', 5), { at: 150 })), false);
    eq(c.hbResDropItem(it('saveSched', 5)), false);
    eq(c.hbResDropItem(Object.assign(it('saveSched', 6), { at: 50 })), false);
  });
  const f = makeCtx(); f.D.residents = c.D.residents; f._pqFlushing = true; f._pq = [Object.assign(it('saveSched', 5), { at: 10 })];
  t('再送の途中は控えを書き換えない（数だけ返す・後で再送の中で捨てる）', () => { eq(f.hbResPurgeQueued(5), 1); eq(f._pq.length, 1); });
  t('再読み込みの後も、外した番号の古い控えを捨てる', () => {
    const h = makeCtx(); h._store.set(h.K.RES_PURGED_KEY, '{"5":100}');
    vm.runInContext('_resPurged=' + h._store.get(h.K.RES_PURGED_KEY), h);
    eq(h.hbResDropItem(Object.assign(it('saveSched', 5), { at: 50 })), true);
  });
}
{
  /* 高水位（反証 H2）・番号の決め方（反証 M5）・削除の印（反証 M4） */
  const c = makeCtx();
  c._store.set(c.K.RES_ID_HW_KEY, '1500000000');
  t('高水位が専用の幅の値なら数えない（nextResId が同じ番号を返し続けない）', () => { eq(c._resIdHw(), 0); c.D.residents = [res({ id: 3, name: 'A' })]; eq(c.nextResId(), 4); });
  const a = c.hbResIdFor(42, [], {}), b = makeCtx().hbResIdFor('42', [], {});
  t('取り込む方の番号は masterId から決まる（2台が同時に取り込んでも同じ番号＝1行にまとまる）', () => { eq(a, b); ok(a >= 1e9 && a < 2e9); });
  t('その番号が手元かサーバーで使われていれば別の番号にする', () => {
    const x = c.hbResIdFor(42, [res({ id: a, name: 'Z' })], {}); ok(x !== a && x >= 1e9 && x < 2e9);
    const y = c.hbResIdFor(42, [], { [a]: 1 }); ok(y !== a);
  });
  c.hbResTombAdd(3);
  t('削除の印のある masterId は既存の行として送らない', () => eq(c.hbResNeedsSend(res({ id: 9, name: 'A', room: '1', masterId: 3, _fromMaster: true })), false));
  const m = makeCtx(); setRoster(m, ROSTER_T); m.apiUrl = 'https://example.invalid/exec'; m.hbResHealSoon = () => {};
  m.hbResTombAdd(2); m.mergeCommonResidents();
  t('削除の印のある方は名簿から取り込み直さない', () => eq(Object.keys(m._resImportQ).sort(), ['1', '3']));
}
const asyncK = (async () => {
  function healCtx(srvRes) {
    const c = makeCtx(); setRoster(c, ROSTER_T);
    c.apiUrl = 'https://example.invalid/exec';
    c.apiGet = async () => (srvRes === null ? null : { residents: srvRes });
    c.document = { querySelector: () => null };
    c.buildResSel = () => {}; c.renderBoard = () => {}; c.tlRenderKeepScroll = () => {};
    vm.runInContext('Math.random=(function(){var a=[0.25,0.5,0.75],i=0;return function(){return a[(i++)%3]}})()', c);
    return c;
  }
  let c = healCtx([{ id: 1, name: '入居者B', room: '202', active: true }]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true, hosp: false };
  c._resImportQ['2'] = { c: ROSTER_T[1], tExc: true, hosp: true };
  await c.hbResHeal();
  const made = c.D.residents.filter(r => r.masterId === 1);
  await tAsync('候補: サーバーを読み直し、いなければ専用の幅（10億〜20億）の番号で作ってすぐ送る', async () => {
    eq(made.length, 1); ok(made[0].id >= 1e9 && made[0].id < 2e9 && made[0].id !== 1); eq(made[0]._fromMaster, true); eq(made[0].masterHosp, false);
    ok(c.pushes.some(x => x.action === 'saveRes' && x.data.resident.masterId === 1));
  });
  await tAsync('候補: サーバーに同じ氏名の在籍の方がいれば作らない（次の同期で届いて結ばれる）', async () => eq(c.D.residents.filter(r => r.masterId === 2).length, 0));
  await tAsync('候補は今回で外す（まだ要る方は次の同期で置き直される）', async () => eq(Object.keys(c._resImportQ).length, 0));
  await tAsync('端末の中だけの既存の行（取り込んだ印・対象）は番号のまま送る', async () => ok(c.pushes.some(x => x.action === 'saveRes' && x.data.resident.id === 4)));
  const n = c.pushes.length; await c.hbResHeal();
  await tAsync('もう一度動いても、この画面で送った行は二度送らない', async () => eq(c.pushes.length, n));
  c = healCtx(null);
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  await c.hbResHeal();
  await tAsync('サーバーを読めなければ何もしない（候補は残す）', async () => { eq(c.D.residents.length, 0); eq(c.pushes.length, 0); eq(Object.keys(c._resImportQ), ['1']); });
  c = healCtx([{ id: 4, name: '入居者Q', room: '999', active: true }]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  await c.hbResHeal();
  await tAsync('既存の行と同じ番号の別の方がサーバーにいる → 送らず点検に出す', async () => { eq(c.pushes.length, 0); eq(c.hbResIssueLoad().list.map(x => x.kind), ['idTaken']); });
  c = healCtx([{ id: 4, name: '入居者C改', room: '303', masterId: 3, active: true }]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  await c.hbResHeal();
  await tAsync('（サーバーに masterId の列ができた時のため）同じ番号で同じ masterId なら送らず点検にも出さない', async () => { eq(c.pushes.length, 0); eq(c.hbResIssueLoad().list.length, 0); });
  c = healCtx([]); c._locked = false;
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  c.apiGet = async () => { c._locked = true; return { residents: [] }; };
  await c.hbResHeal();
  await tAsync('待っている間に自動ロックが掛かったら何もしない（反証 L1）', async () => eq(c.pushes.length, 0));
  c = healCtx([]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  c.apiGet = async () => { c.D.residents = []; return { residents: [] }; };
  await c.hbResHeal();
  await tAsync('待っている間に消された行は送らない（反証 L1）', async () => eq(c.pushes.length, 0));
  c = healCtx([{ id: 8, name: '入居者A', room: '101', active: true }]);
  setRoster(c, [{ masterId: 1, name: '入居者A', room: '101', active: true, targetApps: ['excretion'] }, { masterId: 21, name: '入居者A', room: '121', active: true, targetApps: ['excretion'] }]);
  c._resImportQ['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, tExc: true };
  await c.hbResHeal();
  await tAsync('名簿に同じ氏名が2人いて作らなかった方は点検に出す（反証 M3）', async () => { eq(c.D.residents.length, 0); eq(c.hbResIssueLoad().list.map(x => [x.kind, x.masterId]), [['notMade', 21]]); });
  c._resImportQ['21'] = { c: { masterId: 21, name: '入居者A', room: '121' }, tExc: true };
  const n2 = c.pushes.length; await c.hbResHeal();
  await tAsync('点検に出した方は、次の照らし合わせで候補から外す（同じ点検を繰り返さない）', async () => { eq(c.pushes.length, n2); eq(c.hbResIssueLoad().list.length, 1); });
  c = healCtx([]);
  c.D.residents = [res({ id: 30, name: '入居者B', room: '202', masterId: 99 })];
  c._resImportQ['2'] = { c: ROSTER_T[1], tExc: true };
  await c.hbResHeal();
  await tAsync('手元の同じ氏名の行が別の方と結ばれていれば作らず点検に出す（反証 M3）', async () => eq(c.hbResIssueLoad().list.map(x => x.kind), ['notMade']));
  c = healCtx([{ id: 4, name: '入居者Q', room: '999', active: true }]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  c._pq = [{ action: 'saveSched', data: { id: 4 }, at: 1 }];
  await c.hbResHeal();
  await tAsync('照らし合わせで番号のぶつかりが分かった方の送信待ちも外す（反証 H1）', async () => { eq(c._pq.length, 0); eq(c.hbResIssueLoad().list[0].dropped, 1); });
  c = healCtx([]); c.apiUrl = '';
  c._resImportQ['1'] = { c: ROSTER_T[0], tExc: true };
  await c.hbResHeal();
  await tAsync('接続先の無い端末では動かない', async () => eq(c.D.residents.length, 0));
  c = healCtx([{ id: 9, name: '入居者C', room: '303', active: true }]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  let gets = 0; const g0 = c.apiGet; c.apiGet = async (o) => { gets++; return g0(o); };
  await c.hbResHeal(); await c.hbResHeal();
  await tAsync('同じ氏名の方がサーバーに別の番号でいる行（dupName）は送らず、この画面では照らし合わせ直さない（同期ごとにサーバーを読まない）', async () => {
    eq(c.pushes.length, 0); eq(c.hbResIssueLoad().list.map(x => x.kind), ['dupName']); eq(gets, 1);
  });
  c = healCtx([]);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true, active: false, hidden: true })];
  await c.hbResHeal();
  await tAsync('退去・非表示の取り込みの行も、ぶつかりが無ければ送る（待たせた送信を解く）', async () => ok(c.pushes.some(x => x.action === 'saveRes' && x.data.resident.id === 4)));
  await tAsync('照らし合わせが送る saveRes は、待たせた送信より先に出す印を付ける', async () => eq(c._resHealFirst['4'], 1));
  c = healCtx([]); vm.runInContext('RES_HEAL_EXISTING=false', c);
  c.D.residents = [res({ id: 4, name: '入居者C', room: '303', masterId: 3, _fromMaster: true })];
  await c.hbResHeal();
  await tAsync('既存の行を送るのは切り替えで止められる（新しい取り込みとは別）', async () => eq(c.pushes.length, 0));
})();


/* ── L. 本物の送信の列と未送信の控えで、待たせ・順・合流・捨て・削除を確かめる（2026-10-25・確認の反証 6） ── */
function qCtx() {
  const c = makeCtx();
  c._storageGet = k => (c._store.has(k) ? c._store.get(k) : null);
  c._storageSet = (k, v) => { c._store.set(k, String(v)); };
  c.apiSetStatus = () => {}; c._recentDelAdd = () => {}; c._delRecAdd = () => {}; c.isDroppableOnOldGas = () => false;
  c.apiUrl = 'https://example.invalid/exec';
  c.posts = []; c.gate = null;   // gate: 次の送信の返事を止める（手で開ける）
  c.apiPost = (a, d) => {
    const id = a === 'saveRes' ? d.resident.id : d.id;
    c.posts.push(a + ':' + id + (d.v ? ':' + d.v : ''));
    if (c.gate) { const g = c.gate; c.gate = null; return new Promise(r => { g.open = () => r({ ok: true }); }); }
    return Promise.resolve({ ok: true });
  };
  vm.runInContext([extractVar('PQ_KEY'), extractVar('_pqCount'), extractFn('loadPendingQueue'), extractFn('savePendingQueue'), extractFn('enqueuePending'),
    extractVar('_pqFlushing'), extractFn('flushPendingQueue'), extractVar('_wqCurrent'), extractVar('_writeQ'), extractFn('_writeDrain'), extractFn('apiPush')].join('\n'), c);
  c.D.residents = [res({ id: 5, name: '入居者A', _fromMaster: true }), res({ id: 6, name: '入居者B' })];
  return c;
}
const tick = () => new Promise(r => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 20); i++) await tick(); }
const pqOf = c => c.loadPendingQueue().map(x => x.action + ':' + (x.action === 'saveRes' ? x.data.resident.id : x.data.id) + (x.data.v ? ':' + x.data.v : ''));
const asyncL = (async () => {
  await asyncK;
  console.log('\n=== L. 送信の列と未送信の控え（_writeDrain・flushPendingQueue・delRes） ===');
  let c = qCtx();
  c.apiPush('saveSched', { id: 5, v: 'S1' }); c.apiPush('saveSched', { id: 6 });
  await settle();
  await tAsync('取り込んだだけの方への予定は送らず控えで待たせ、施設の方の予定はそのまま送る', async () => { eq(c.posts, ['saveSched:6']); eq(pqOf(c), ['saveSched:5:S1']); });
  await new Promise(r => c.flushPendingQueue(r)); await settle();
  await tAsync('再送でも待たせたまま（控えは減らない）', async () => { eq(c.posts, ['saveSched:6']); eq(pqOf(c), ['saveSched:5:S1']); });
  /* 照らし合わせが送った: saveRes を先に・待たせた S1・新しい S2 の順で届く */
  c._resHealSent['5'] = 1; c._resHealFirst['5'] = 1;
  c.gate = {}; const g = c.gate;
  c.apiPush('saveRes', { resident: { id: 5 } });
  c.apiPush('saveSched', { id: 5, v: 'S2' });
  await settle(); g.open(); await settle(40);
  await tAsync('照らし合わせの saveRes → 待たせた古い予定 → 新しい予定の順に届く（古い予定が新しい予定を巻き戻さない）', async () => {
    eq(c.posts, ['saveSched:6', 'saveRes:5', 'saveSched:5:S1', 'saveSched:5:S2']); eq(pqOf(c), []);
  });
  c = qCtx();
  c.enqueuePending('saveSched', { id: 6, v: 'old' });
  c.apiPush('saveSched', { id: 6, v: 'new' }); await settle();
  await tAsync('施設の既存の方（取り込みの印なし）は、控えに古い分があっても今までどおり新しい分をすぐ送る', async () => eq(c.posts[0], 'saveSched:6:new'));
  /* 合流: 再送の途中に足された分を失わない */
  c = qCtx();
  c.enqueuePending('saveSched', { id: 6 }); c.enqueuePending('saveSched', { id: 5, v: 'H' });
  c.gate = {}; const g2 = c.gate; let done2 = null;
  c.flushPendingQueue(x => { done2 = x; }); await settle();
  c.enqueuePending('saveSched', { id: 7, v: 'mid' });
  g2.open(); await settle(40);
  await tAsync('再送の途中に控えへ足された分は、待たせた分の後ろに残る（無言で失わない）', async () => { eq(pqOf(c), ['saveSched:5:H', 'saveSched:7:mid']); eq(done2, false); });
  /* 再送の途中に番号のぶつかりが分かった: 控えは書き換えず、その再送の中で捨てる */
  c = qCtx(); c.D.residents[0]._srvSeen = true; c.D.residents[0]._fromMaster = undefined;
  c._store.set(c.PQ_KEY, JSON.stringify([{ action: 'saveSched', data: { id: 6 }, at: 1 }, { action: 'saveSched', data: { id: 5, v: 'X' }, at: 1 }]));
  c.gate = {}; const g3 = c.gate; let done3 = null;
  c.flushPendingQueue(x => { done3 = x; }); await settle();
  const n3 = c.hbResPurgeQueued(5);
  await tAsync('再送の途中は控えを書き換えない（数だけ返す）', async () => { eq(n3, 1); eq(pqOf(c).length, 2); });
  g3.open(); await settle(40);
  await tAsync('その再送の中で、ぶつかりが分かる前に積まれた分を捨てる（サーバーの別の方へ送らない）', async () => { eq(c.posts, ['saveSched:6']); eq(pqOf(c), []); eq(done3, true); });
  /* 削除: 一度もサーバーで確かめていない取り込みの行はサーバーへ削除を送らない */
  const delCtx = () => {
    const d = makeCtx(); d.renderCfg = () => {}; d.buildResSel = () => {}; d.msgs = [];
    d.customConfirm = async (m) => { d.msgs.push(m); return true; };
    d.apiUrl = 'https://example.invalid/exec';
    vm.runInContext(extractFn('delRes'), d);
    return d;
  };
  let d = delCtx();
  d.D.residents = [res({ id: 5, name: '入居者A', masterId: 1, _fromMaster: true })];
  d._pq = [{ action: 'saveSched', data: { id: 5 }, at: 1 }];
  await d.delRes(5);
  await tAsync('一度もサーバーで確かめていない取り込みの行の削除: サーバーへ送らず、待たせた送信を外し、取り込み直さない印を残す', async () => {
    eq(d.pushes.length, 0); eq(d._pq.length, 0); eq(d.hbResTombHas(1), true); eq(d.D.residents.length, 0);
  });
  d = delCtx(); d.D.residents = [res({ id: 6, name: '入居者B', masterId: 2, _srvSeen: true })];
  await d.delRes(6);
  await tAsync('サーバーで見た行の削除は今までどおり送る', async () => eq(d.pushes.map(x => x.action + ':' + x.data.id), ['delRes:6']));
  d = delCtx(); d.hbIsDayOnly = (r) => !!(r.cfg && r.cfg.dayOnly); d.D.residents = [res({ id: 8, name: '入居者D', masterId: 4, _fromMaster: true, cfg: { dayOnly: true } })];
  await d.delRes(8);
  await tAsync('デイだけの方の削除は送る', async () => eq(d.pushes.map(x => x.action), ['delRes']));
  d = delCtx(); setRoster(d, ROSTER_T); d.D.residents = [res({ id: 9, name: '入居者A', masterId: 1, _srvSeen: true }), res({ id: 10, name: '入居者Z', masterId: 77, _srvSeen: true })];
  await d.delRes(9); await d.delRes(10);
  await tAsync('入居者マスタで排泄の対象のままの方を消す時だけ、先に対象から外すよう確かめの小窓に書く', async () => {
    ok(d.msgs[0].includes('先に入居者マスタで対象から外してください')); ok(!d.msgs[1].includes('入居者マスタ'));
  });
})();

asyncK.then(() => asyncL).then(() => {
  console.log('\n────────────────────────────────────────');
  console.log(fail === 0 ? `✅ 全 ${pass} 件 PASS` : `❌ ${fail} 件 FAIL / ${pass} 件 PASS`);
  if (fail) { failures.forEach(f => console.log('   - ' + f)); process.exit(1); }
}, (e) => { console.log('✗ 例外: ' + (e && e.stack || e)); process.exit(1); });
