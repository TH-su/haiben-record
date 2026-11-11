/* ══════════════════════════════════════════════════════════════════════
   同じ方の重複のまとめ（2026-11-11）の試験
   実行:  node tests/res-dup-merge.test.js
   ──────────────────────────────────────────────────────────────────────
   守る約束:
     1 同じ氏名（比較用の正規化）＋同じ居室の在籍の行だけを組にする（別の居室・退去・職員は組にしない）
     2 残す行は記録の付いている行（記録の無い表示中の行より、記録のある非表示の行を残す）
     3 まとめる時、記録は消さない（付け替えるだけ）・予定・おむつ・紐づけ（masterId）は残す行へ移す
     4 3台の端末（A: 片方と結ばれている／B: もう一方と結ばれている／C: 外す行に未送信の記録がある）が
       サーバーを経由して全部1行に収まり、記録が全部残す行に付く
     5 記録が2つの行に分かれている組は、〔1つにまとめる〕を出さない
   ★入居者の氏名は架空（入居者甲・乙）。実在の氏名は使わない。★haiben-record.html の実物の関数を切り出して評価する
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeExtractor } = require('./_extract.js');

const FILE = process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html');
const HTML = fs.readFileSync(FILE, 'utf8');
const SRC = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const X = makeExtractor(SRC);

let pass = 0, fail = 0;
function t(name, ok, info) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info !== undefined ? '（' + JSON.stringify(info) + '）' : '')); } }

const FNS = ['toNum', '_normName', '_normNameX', '_hbDcRoomKey', '_hbDupKey', '_hbMergedFrom', 'hbDupGroups', 'hbDupFold', 'hbDupMoveRecs', 'hbDupFollow', 'hbDupLogLoad', 'hbDupLogAdd', 'hbDupPanelHtml', 'escapeHtmlText'];
function device(residents, records) {
  const ctx = {
    console, JSON, Object, Array, String, Number, Date, Math,
    D: { residents: JSON.parse(JSON.stringify(residents)), records: JSON.parse(JSON.stringify(records || [])) },
    pushed: [], _recIdx: 1,
    isUserRes: (r) => !!r && r.room !== '_staff_',
    isUserRec: (r) => !!r && r.type !== '_sys_',
    hbIsField: () => false,
    _invalidateLinkIdx: () => {},
    pushStaffsSnapshot: () => { ctx.pushed.push({ action: 'snapshot' }); },
    _ls: {}, delIds: {},
    _delRecHas: (id) => !!ctx.delIds[String(id)],
  };
  ctx.localStorage = { getItem: (k) => (k in ctx._ls ? ctx._ls[k] : null), setItem: (k, v) => { ctx._ls[k] = String(v); } };
  ctx.apiPush = (action, data) => ctx.pushed.push({ action, data: JSON.parse(JSON.stringify(data)) });
  vm.createContext(ctx);
  vm.runInContext([/var _NAMEX_MAP=\{[\s\S]*?\};/.exec(SRC)[0], X.varDecl('HB_DUP_MAX_MERGED'), X.varDecl('HB_DUP_LOG_KEY')].concat(FNS.map((n) => X.fn(n))).join('\n'), ctx);
  return ctx;
}
/* 偽のサーバー（入居者は id で上書き・delRes で消す・記録は id で上書き） */
function server(residents, records) {
  const S = { res: new Map(), rec: new Map() };
  residents.forEach((r) => S.res.set(r.id, JSON.parse(JSON.stringify(r))));
  (records || []).forEach((x) => S.rec.set(x.id, JSON.parse(JSON.stringify(x))));
  S.apply = (pushed) => pushed.forEach((p) => {
    if (p.action === 'saveRes') { const r = JSON.parse(JSON.stringify(p.data.resident)); delete r.masterId; delete r.masterHosp; delete r.midAck; delete r.hospitalizations; S.res.set(r.id, r); }
    if (p.action === 'delRes') S.res.delete(p.data.id);
    if (p.action === 'saveRecord') S.rec.set(p.data.record.id, JSON.parse(JSON.stringify(p.data.record)));
    if (p.action === 'saveSched') { const r = S.res.get(p.data.id); if (r) r.schedule = p.data.schedule; }
  });
  S.list = () => [...S.res.values()].map((r) => JSON.parse(JSON.stringify(r)));
  return S;
}
/* 同期の写し（本体の同期の入居者の合わせ方の要点: サーバーの行が勝ち・masterId は氏名が同じ時だけ手元から引き継ぐ・手元だけの行は残す）。
   記録はサーバーの分を足す。その後に本体の hbDupFollow を呼ぶ */
function sync(dev, S) {
  const api = S.list();
  const loc = {}; dev.D.residents.forEach((r) => { loc[r.id] = r; });
  const seen = {}; const merged = [];
  api.forEach((r) => { const lr = loc[r.id]; if (lr) { ['masterId', 'masterHosp', 'midAck', 'hospitalizations'].forEach((f) => { if (r[f] == null && lr[f] != null) r[f] = lr[f]; }); } merged.push(r); seen[r.id] = 1; });
  dev.D.residents.forEach((r) => { if (!seen[r.id]) merged.push(r); });
  dev.D.residents = merged;
  const recs = {}; dev.D.records.forEach((x) => { recs[x.id] = x; });
  [...S.rec.values()].forEach((x) => { if (!recs[x.id]) { recs[x.id] = JSON.parse(JSON.stringify(x)); dev.D.records.push(recs[x.id]); } });
  dev.pushed = [];
  dev.hbDupFollow(api);
  return dev.pushed;
}

const KO = '入居者甲', OTSU = '入居者乙';
const rec = (id, rid, d) => ({ id, residentId: rid, type: 'urine', date: d, time: '10:00' });

console.log('1 組にする条件');
{
  const dv = device([
    { id: 36, name: KO, room: '210', active: true, hidden: false },
    { id: 80, name: '入居者 甲', room: '210号室', active: true, hidden: true },
    { id: 40, name: KO, room: '211', active: true },                 // 別の居室は組にしない
    { id: 41, name: OTSU, room: '212', active: false },               // 退去は組にしない
    { id: 42, name: OTSU, room: '212', active: true },
    { id: 90, name: '職員', room: '_staff_', active: true },
    { id: 91, name: '職員', room: '_staff_', active: true },
  ], [rec('a', 80, '2026-09-28'), rec('b', 80, '2026-11-10')]);
  const g = dv.hbDupGroups(dv.D.residents, dv.D.records, null);
  t('組は1つだけ（同じ氏名＋同じ居室・空白と「号室」の違いは同じとみなす）', g.length === 1 && g[0].rows.length === 2, g.map((x) => x.rows.map((r) => r.id)));
  t('残す行は記録の付いている非表示の行（80）', g[0].keepId === 80, g[0].keepId);
  t('記録の数と最初・最後の日を出す', g[0].rows.find((x) => x.id === 80).recN === 2 && g[0].rows.find((x) => x.id === 80).last === '2026-11-10');
  const html = dv.hbDupPanelHtml(g);
  t('枠に〔1つにまとめる〕と「残す行」が出る', /1つにまとめる/.test(html) && /残す行：番号80/.test(html));
}
{
  const dv = device([{ id: 34, name: KO, room: '208', hidden: true }, { id: 76, name: KO, room: '208', hidden: true }], []);
  t('どちらにも記録が無い時は番号の小さい行を残す', dv.hbDupGroups(dv.D.residents, [], null)[0].keepId === 34);
}

console.log('2 記録が2つの行に分かれている時');
{
  const dv = device([{ id: 1, name: KO, room: '101' }, { id: 2, name: KO, room: '101' }], [rec('a', 1, '2026-10-01'), rec('b', 2, '2026-10-02')]);
  const g = dv.hbDupGroups(dv.D.residents, dv.D.records, null);
  t('withRecs が 2', g[0].withRecs === 2);
  t('〔1つにまとめる〕を出さない', !/hb-dup-btn/.test(dv.hbDupPanelHtml(g)));
}

console.log('3 まとめる中身（残す行へ移す・記録は消さない）');
{
  const dv = device([
    { id: 36, name: KO, room: '210', hidden: false, masterId: 'M1', schedule: ['08:00'], padSet: { at: 1, day: ['x'], night: [] }, laxNote: '夜は2錠', yomi: '' },
    { id: 80, name: KO, room: '210', hidden: true, yomi: 'こう', cfg: { stoolWarnD: 2 } },
  ], [rec('a', 80, '2026-09-28'), rec('u1', 36, '2026-11-11')]);
  const keep = dv.D.residents[1], drop = dv.D.residents[0];
  const mv = dv.hbDupFold(keep, drop, { mark: true, unhide: true });
  t('残す行を表示に戻す（どちらかが表示中だった）', keep.hidden === false);
  t('予定・おむつ・下剤のメモ・紐づけを移す', JSON.stringify(keep.schedule) === '["08:00"]' && keep.padSet && keep.laxNote === '夜は2錠' && keep.masterId === 'M1' && mv.sched && mv.pad);
  t('残す行にある値（ふりがな・閾値）はそのまま', keep.yomi === 'こう' && keep.cfg.stoolWarnD === 2);
  t('印 mergedFrom に外す行の番号', JSON.stringify(keep.cfg.mergedFrom) === '[36]');
  const moved = dv.hbDupMoveRecs(dv.D.records, [36], 80);
  t('外す行の記録を残す行へ付け替える（消さない）', moved.length === 1 && dv.D.records.length === 2 && dv.D.records.every((x) => x.residentId === 80));
  dv.hbDupFold(keep, { id: 77, name: KO, room: '210', cfg: { mergedFrom: [5] } }, { mark: true });
  t('印は合わせる（重ねない・自分の番号は入れない）', JSON.stringify(keep.cfg.mergedFrom) === '[36,5,77]');
}

console.log('4 3台の端末がサーバーを経由して1行に収まる');
{
  const srvRes = [{ id: 36, name: KO, room: '210', active: true, hidden: false }, { id: 80, name: KO, room: '210', active: true, hidden: true }];
  const srvRec = [rec('r1', 80, '2026-09-28'), rec('r2', 80, '2026-11-10')];
  const S = server(srvRes, srvRec);
  // A: 80 と結ばれている（まとめる端末）／B: 36 と結ばれている／C: 36 に未送信の記録がある・80 を持っていない（端末だけの行 99 も 36 と同じ方）
  const A = device(srvRes.map((r) => Object.assign({}, r, r.id === 80 ? { masterId: 'M1' } : {})), srvRec);
  const B = device(srvRes.map((r) => Object.assign({}, r, r.id === 36 ? { masterId: 'M1' } : {})), srvRec);
  const C = device([srvRes[0]], [rec('u-c', 36, '2026-11-11')]);
  // A で〔1つにまとめる〕と同じ手順（hbDupMerge の中の送る順をそのまま行う）
  const g = A.hbDupGroups(A.D.residents, A.D.records, { 36: 1, 80: 1 })[0];
  t('A の残す行は 80', g.keepId === 80);
  const keep = A.D.residents.find((r) => r.id === 80);
  A.pushed = [];
  A.hbDupFold(keep, A.D.residents.find((r) => r.id === 36), { mark: true, unhide: true });
  A.hbDupMoveRecs(A.D.records, [36], 80);
  A.D.residents = A.D.residents.filter((r) => r.id !== 36);
  A.apiPush('saveRes', { resident: keep }); A.apiPush('delRes', { id: 36 });
  S.apply(A.pushed);
  t('サーバーは1行（80・表示中・印つき）', S.list().length === 1 && S.list()[0].id === 80 && S.list()[0].hidden === false && JSON.stringify(S.list()[0].cfg.mergedFrom) === '[36]');
  // C の未送信の記録は、まとめた後にサーバーへ届く（36 宛て）
  S.apply([{ action: 'saveRecord', data: { record: rec('u-c', 36, '2026-11-11') } }]);
  const pb = sync(B, S); S.apply(pb);
  const pc = sync(C, S); S.apply(pc);
  const pa = sync(A, S); S.apply(pa);
  const pb2 = sync(B, S); S.apply(pb2);
  t('B は1行になり、紐づけ（masterId）が残す行へ移る', B.D.residents.length === 1 && B.D.residents[0].id === 80 && B.D.residents[0].masterId === 'M1', B.D.residents);
  t('C は1行になる（サーバーで外れた行が手元からも外れる）', C.D.residents.length === 1 && C.D.residents[0].id === 80, C.D.residents.map((r) => r.id));
  t('C の記録は残す行に付く', C.D.records.every((x) => x.residentId === 80));
  t('サーバーの記録は3件とも残す行に付く（消えていない）', S.rec.size === 3 && [...S.rec.values()].every((x) => x.residentId === 80), [...S.rec.values()]);
  t('A も1行・組は0', A.D.residents.length === 1 && A.hbDupGroups(A.D.residents, A.D.records, null).length === 0);
  const pa2 = sync(A, S);
  t('収まった後の同期では何も送らない（送り続けない）', pa2.length === 0, pa2);
}

console.log('5 印があっても外す行がまだサーバーにある間は外さない');
{
  const api = [{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }, { id: 36, name: KO, room: '210' }];
  const dv = device(api, [rec('x', 36, '2026-11-11')]);
  dv.hbDupFollow(api);
  t('36 を外さない・記録も動かさない', dv.D.residents.length === 2 && dv.D.records[0].residentId === 36 && dv.pushed.length === 0);
  dv.hbDupFollow([]);
  t('サーバーの入居者が返らない同期では何もしない', dv.D.residents.length === 2);
}


console.log('6 反証の直し');
{
  // 印が消された（まだ印を受け取っていない端末が残す行を保存した）→ まとめた端末が付け直して送る
  const A = device([{ id: 80, name: KO, room: '210', cfg: {} }], []);
  A.hbDupLogAdd([36], 80);
  A.hbDupFollow([{ id: 80, name: KO, room: '210', cfg: {} }]);
  t('まとめた端末は、消えた印を付け直して送る', A.pushed.length === 1 && A.pushed[0].action === 'saveRes' && JSON.stringify(A.pushed[0].data.resident.cfg.mergedFrom) === '[36]', A.pushed);
  A.pushed = [];
  A.hbDupFollow([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }]);
  t('印が残っていれば送らない', A.pushed.length === 0);
  // 番号が別の方に使い直されていた（氏名・居室が違う）→ 外さない・記録も動かさない
  const B = device([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }, { id: 36, name: OTSU, room: '305' }], [rec('x', 36, '2026-11-11')]);
  B.hbDupFollow([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }]);
  t('別の方の行は外さない・記録を動かさない', B.D.residents.length === 2 && B.D.records[0].residentId === 36 && B.pushed.length === 0);
  // サーバーで消された記録は送り直さない・入院の控えは同期の途中で送らない
  const C = device([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }, { id: 36, name: KO, room: '210', hospitalizations: [{ id: 'h', admissionAt: '2026-10-01' }] }], [rec('del', 36, '2026-10-01'), rec('ok', 36, '2026-10-02')]);
  C.delIds.del = 1;
  C.hbDupFollow([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }]);
  t('消された記録は送らず、消されていない記録だけ送る', C.pushed.filter((p) => p.action === 'saveRecord').map((p) => p.data.record.id).join() === 'ok', C.pushed);
  t('同期の途中で入院の控え（snapshot）を送らない', !C.pushed.some((p) => p.action === 'snapshot'));
  // 手元にもサーバーにも行 36 が無い端末でも、後から 36 で届いた記録は残す行へ寄せる
  const E = device([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }], [rec('late', 36, '2026-11-12')]);
  E.hbDupFollow([{ id: 80, name: KO, room: '210', cfg: { mergedFrom: [36] } }]);
  t('行の無い番号に戻った記録も残す行へ寄せる', E.D.records[0].residentId === 80 && E.pushed.length === 1);
  // デイだけの印は残す行へ写さない
  const k = { id: 80, name: KO, room: '210' };
  device([], []).hbDupFold(k, { id: 36, name: KO, room: '210', cfg: { dayOnly: true, urineWarnH: 5 } }, { mark: true });
  t('dayOnly は写さず、ほかの設定は写す', !k.cfg.dayOnly && k.cfg.urineWarnH === 5);
  // 〔1つにまとめる〕が控えのシートの記録も数え、確認の窓の後に行を取り直す
  const m = X.fn('hbDupMerge');
  t('控えのシートの記録も数える', /hbDupArchiveRecs\(\)/.test(m) && /sv\.records\.concat\(arc,/.test(m));
  t('確認の窓の後に、いまの行を取り直す', /keepRow=cur\.rows\.find/.test(m) && m.indexOf('keepRow=cur.rows.find') > m.indexOf('customConfirm'));
}

console.log('7 本体の同期が印を見る');
{
  const sy = X.fn('syncFromAPI');
  const i = sy.indexOf('D.records=mergedRec;'), j = sy.indexOf('hbDupFollow(apiRes)');
  t('同期の中で、記録を合わせた直後に hbDupFollow(apiRes) を呼ぶ', i > 0 && j > i && j - i < 400, { i, j });
  t('入居者の管理の一覧に枠を出す', /hbDupPanelHtml\(_dupG\)/.test(X.fn('renderCfg')));
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 件合格・' + fail + ' 件不合格');
process.exit(fail ? 1 : 0);
