/* ══════════════════════════════════════════════════════════════════════
   時系列「今日」の排泄予定の超過表示・現在時刻線・定期更新／設定保存ほか2件の修正の検証ハーネス（2026-09-26）
   実行:  node tests/overdue.test.js
          （worktree 等の写しを対象にする時は HAIBEN_HTML=<haiben-record.html のパス> を付ける）
   ──────────────────────────────────────────────────────────────────────
   ★実物のソース（haiben-record.html）をそのまま評価する。
     判定ロジックをテスト側に写経しない（写経すると本体を直してもテストが緑のままになる）。
   ★入居者・記録はすべて合成データ。実在の氏名・記録は一切使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeExtractor,matchBrace}=require('./_extract');

const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();
const X=makeExtractor(SRC);

let fail=0,pass=0;
function ok(c,m,e){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(e!==undefined?'  → '+JSON.stringify(e):''))}}
function head(t){console.log('\n─── '+t+' ───')}

/* ════════ 本体の純関数を砂場で動かす ════════ */
const sbPure={};
vm.createContext(sbPure);
vm.runInContext(X.fn('tlOverdueList'),sbPure);
const L=sbPure.tlOverdueList;
const OPT={grace:30,before:30};
const M=hm=>{const p=hm.split(':');return(+p[0])*60+(+p[1])};
const rec=(time,type)=>({id:'x'+time+type,residentId:1,date:'2026-09-20',time:time,type:type});
const hms=list=>list.map(o=>o.hm).join(',');

/* ════════════════════════════════════════════════════════════════
   1. 予定前・猶予内は超過にならない
   ════════════════════════════════════════════════════════════════ */
head('1. 予定前・猶予内');
(function(){
  ok(L(['10:00'],[],M('09:50'),OPT).length===0,'予定前（09:50）は超過にならない');
  ok(L(['10:00'],[],M('10:00'),OPT).length===0,'予定ちょうど（10:00）は超過にならない');
  ok(L(['10:00'],[],M('10:29'),OPT).length===0,'猶予未満（10:29＝t+29分）は超過にならない');
  const r=L(['10:00'],[],M('10:30'),OPT);
  ok(r.length===1&&r[0].hm==='10:00'&&r[0].min===600,'猶予ちょうど（10:30＝t+30分）で超過になる',r);
  const g=L(['10:00'],[],M('10:45'),{grace:60,before:30});
  ok(g.length===0,'grace を 60 にすると 10:45 はまだ超過にならない（opt が効く）');
})();

/* ════════════════════════════════════════════════════════════════
   2. 実施とみなす種別
   ════════════════════════════════════════════════════════════════ */
head('2. 実施とみなす種別');
(function(){
  ['urine','stool','both','none'].forEach(function(t){
    ok(L(['10:00'],[rec('09:45',t)],M('11:00'),OPT).length===0,'範囲内（09:45）の '+t+' で実施扱い');
  });
  ok(L(['10:00'],[rec('09:30','urine')],M('11:00'),OPT).length===0,'範囲の始点ちょうど（t−30＝09:30）も実施扱い');
  ok(L(['10:00'],[rec('09:29','urine')],M('11:00'),OPT).length===1,'範囲の外（09:29）の記録は実施にならない');
  ok(L(['10:00'],[rec('09:45','water')],M('11:00'),OPT).length===1,'water だけでは超過のまま');
  ok(L(['10:00'],[rec('09:45','laxative')],M('11:00'),OPT).length===1,'laxative だけでは超過のまま');
  ok(L(['10:00'],[rec('09:45','water'),rec('10:05','laxative')],M('11:00'),OPT).length===1,'water＋laxative の組み合わせでも超過のまま');
  ok(L(['10:00'],[{type:'urine',time:''},{type:'urine'},null],M('11:00'),OPT).length===1,'時刻の無い・壊れた記録は数えない');
})();

/* ════════════════════════════════════════════════════════════════
   3. 遅れて記録した場合
   ════════════════════════════════════════════════════════════════ */
head('3. 遅れて記録');
(function(){
  ok(L(['10:00'],[],M('10:40'),OPT).length===1,'10:40 時点で記録なし → 超過');
  ok(L(['10:00'],[rec('10:45','urine')],M('10:50'),OPT).length===0,'t+45（10:45）に記録すると実施扱い＝赤枠が消える');
  ok(L(['10:00'],[rec('14:00','urine')],M('11:00'),OPT).length===1,'現在より後の時刻の記録（nowMin 超え）は数えない');
})();

/* ════════════════════════════════════════════════════════════════
   4. 次の予定の範囲との境
   ════════════════════════════════════════════════════════════════ */
head('4. 次の予定の範囲');
(function(){
  const r=L(['10:00','13:00'],[rec('12:45','urine')],M('13:10'),OPT);
  ok(hms(r)==='10:00','次の予定（13:00）の範囲に入った 12:45 の記録は 10:00 を満たさない（13:00 は猶予内）',r);
  const r2=L(['10:00','13:00'],[rec('12:30','urine')],M('13:10'),OPT);
  ok(hms(r2)==='10:00','境目ちょうど（次の予定−30＝12:30）も次の予定の側に入る',r2);
  const r3=L(['10:00','13:00'],[rec('12:29','urine')],M('13:40'),OPT);
  ok(hms(r3)==='13:00','12:29 は 10:00 側で実施／13:00 は猶予を過ぎて記録なし → 13:00 だけ超過',r3);
  const r4=L(['10:00','13:00'],[rec('12:45','both')],M('13:40'),OPT);
  ok(hms(r4)==='10:00','12:45 の記録は 13:00 を満たし、10:00 は超過のまま',r4);
})();

/* ════════════════════════════════════════════════════════════════
   5. isSkipped・空の予定・不正な時刻・並び順・重複
   ════════════════════════════════════════════════════════════════ */
head('5. 除外・入力の揺れ');
(function(){
  const r=L(['08:00','10:00','12:00'],[],M('15:00'),{grace:30,before:30,isSkipped:function(min){return min>=M('10:00')}});
  ok(hms(r)==='08:00','isSkipped が真のコマ（10:00・12:00）は除外される',r);
  ok(L([],[],M('23:00'),OPT).length===0,'予定が空 → 超過なし');
  ok(L(null,[],M('23:00'),OPT).length===0,'予定が null → 超過なし（落ちない）');
  ok(L(undefined,undefined,M('23:00'),undefined).length===0,'引数が欠けても落ちない');
  const bad=L(['25:00','ab','','10:60',null,'1000','10:00'],[],M('23:00'),OPT);
  ok(hms(bad)==='10:00','不正な時刻（25:00・ab・空・10:60・null・1000）は無視される',bad);
  const uns=L(['13:00','10:00'],[rec('12:45','urine')],M('13:10'),OPT);
  ok(hms(uns)==='10:00','並びが昇順でなくても並べ直してから判定する（12:45 は 13:00 側）',uns);
  const ord=L(['15:00','08:00','11:00'],[],M('23:00'),OPT);
  ok(hms(ord)==='08:00,11:00,15:00','結果は時刻の昇順',ord);
  const pad=L(['8:00'],[],M('09:00'),OPT);
  ok(pad.length===1&&pad[0].hm==='08:00'&&pad[0].min===480,'「8:00」は 08:00 として扱い HH:MM で返す',pad);
  const dup=L(['10:00','10:00'],[rec('10:05','urine')],M('11:00'),OPT);
  ok(dup.length===0,'同じ時刻の重複予定は1つにまとめる（重複で範囲が空にならない）',dup);
  const dup2=L(['10:00','10:00'],[],M('11:00'),OPT);
  ok(dup2.length===1,'同じ時刻の重複予定は超過も1件として数える',dup2);
  ok(L(['10:00'],[],NaN,OPT).length===0,'nowMin が数でなければ何も返さない');
})();

/* ════════════════════════════════════════════════════════════════
   5b. 0時まわり・間隔30分以下の予定（2026-09-26 差し戻し対応）
   ════════════════════════════════════════════════════════════════ */
head('5b. 0時まわり・近い予定');
(function(){
  const P=(time,type)=>({time:time,type:type});   // 前日の記録（opt.prevRecs）
  const o=x=>Object.assign({},OPT,x);
  // (a) 0時台の予定の範囲は前日にかかる
  ok(L(['00:00'],[],M('00:40'),o({prevRecs:[P('23:50','urine')]})).length===0,'00:00 の予定に前日 23:50 の記録 → 実施扱い');
  ok(L(['00:00'],[],M('00:40'),OPT).length===1,'前日の記録を渡さなければ 00:00 は超過（前日分が効いていることの対照）');
  ok(L(['00:00'],[],M('00:40'),o({prevRecs:[P('23:29','urine')]})).length===1,'前日 23:29（1440−30 より前）は数えない');
  ok(L(['00:00'],[],M('00:40'),o({prevRecs:[P('23:30','none')]})).length===0,'前日 23:30（1440−30 ちょうど）の誘導は数える');
  ok(L(['00:00'],[],M('00:40'),o({prevRecs:[P('23:50','water')]})).length===1,'前日の水分だけでは実施にならない');
  ok(L(['00:20'],[],M('00:55'),o({prevRecs:[P('23:55','stool')]})).length===0,'00:20 の予定に前日 23:55 の排便 → 実施扱い');
  ok(L(['08:00'],[],M('09:00'),o({prevRecs:[P('23:50','urine')]})).length===1,'0時台でない予定には前日の記録は効かない');
  // (c) その日最後の予定の範囲は「翌日の最初の予定−before」で終わる（日付の終わりまで延ばさない）
  const c1=L(['00:10','20:00'],[rec('23:45','urine')],M('23:50'),OPT);
  ok(hms(c1)==='00:10,20:00','最後の予定 20:00 の範囲は 23:40（翌日 00:10−30）まで＝23:45 の記録は 20:00 を満たさない',c1);
  const c2=L(['00:10','20:00'],[rec('23:35','urine')],M('23:50'),OPT);
  ok(hms(c2)==='00:10','23:35 の記録は 20:00 を満たす',c2);
  const c3=L(['20:00'],[rec('23:45','urine')],M('23:50'),OPT);
  ok(c3.length===0,'予定が1つだけなら翌日の同じ予定−30 まで＝現在時刻までの記録で満たす',c3);
  // (b) 23:30 以降の予定は当日中に超過にならない（仕様上の制約）
  ok(L(['23:30'],[],M('23:59'),OPT).length===0,'23:30 の予定は 23:59 でも超過にならない（仕様上の制約）');
  // 先頭の予定の範囲の始まり＝前日最後の予定（末尾−1440）との境界 max(t−30, 中点)。日付をまたいで二重に数えない
  const g1=L(['23:30','00:00'],[],M('00:40'),o({prevRecs:[P('23:40','urine')]}));
  ok(hms(g1)==='00:00','予定 23:30/0:00・前日 23:40 の記録・0:40 → 00:00 は超過（23:40 は前日 23:30 側＝境界は中点 23:45）',g1);
  const g2=L(['23:50','00:10'],[],M('00:45'),o({prevRecs:[P('23:45','urine')]}));
  ok(hms(g2)==='00:10','予定 23:50/0:10・前日 23:45 の記録・0:45 → 00:10 は超過（境界は中点 0:00）',g2);
  const g3=L(['23:30','00:00'],[],M('00:40'),o({prevRecs:[P('23:50','urine')]}));
  ok(g3.length===0,'予定 23:30/0:00・前日 23:50（中点 23:45 以降）の記録なら 00:00 を満たす',g3);
  const g4=L(['20:00','00:10'],[],M('00:45'),o({prevRecs:[P('23:40','urine')]}));
  ok(g4.length===0,'十分離れた予定（20:00/0:10）では従来どおり t−30（前日 23:40）から数える',g4);
  const g5=L(['20:00','00:10'],[],M('00:45'),o({prevRecs:[P('23:39','urine')]}));
  ok(hms(g5)==='00:10','十分離れた予定（20:00/0:10）では前日 23:39（t−30 より前）は数えない',g5);
  // 前日最後の範囲の終わり（翌日側）と先頭の範囲の始まりが一致する＝境目の記録はどちらか一方だけに数える
  const lastEnd=L(['00:10','23:50'],[rec('23:59','urine')],M('23:59'),o({grace:0}));
  ok(hms(lastEnd)==='00:10','同じ予定表で前日側から見ると 23:59 は 23:50 側（0:10 は範囲外）',lastEnd);
  // 4. 間隔30分以下の予定＝境界は max(次−30, 中点)
  const d1=L(['10:00','10:15'],[rec('10:05','urine')],M('10:50'),OPT);
  ok(hms(d1)==='10:15','10:00 と 10:15: 10:05 の記録は 10:00 を満たす（境界は中点 10:07.5）→ 10:15 は超過',d1);
  const d2=L(['10:00','10:15'],[rec('10:10','urine')],M('10:50'),OPT);
  ok(hms(d2)==='10:00','10:00 と 10:15: 10:10 の記録は 10:15 側 → 10:00 は超過',d2);
  const d3=L(['10:00','10:15'],[rec('10:05','urine'),rec('10:12','both')],M('10:50'),OPT);
  ok(d3.length===0,'10:00 と 10:15: 10:05 と 10:12 の記録で両方とも実施',d3);
  const e1=L(['10:00','10:30'],[rec('10:10','urine')],M('11:10'),OPT);
  ok(hms(e1)==='10:30','10:00 と 10:30: 10:10 の記録は 10:00 を満たす（境界は中点 10:15）→ 10:30 は超過',e1);
  const e2=L(['10:00','10:30'],[rec('10:20','urine')],M('11:10'),OPT);
  ok(hms(e2)==='10:00','10:00 と 10:30: 10:20 の記録は 10:30 側 → 10:00 は超過',e2);
  const e3=L(['10:00','10:30'],[rec('10:15','urine')],M('11:10'),OPT);
  ok(hms(e3)==='10:00','10:00 と 10:30: 境界ちょうど 10:15 は次の予定の側',e3);
  const e4=L(['10:00','10:30'],[],M('11:10'),OPT);
  ok(hms(e4)==='10:00,10:30','10:00 と 10:30: 記録なしなら両方超過',e4);
  const f1=L(['10:00','11:00'],[rec('10:30','urine')],M('11:40'),OPT);
  ok(hms(f1)==='10:00','60分離れた予定は従来どおり「次の予定−30」（10:30）が境界＝10:30 の記録は 11:00 側 → 10:00 は超過',f1);
})();

/* ════════════════════════════════════════════════════════════════
   6. 入居者単位の判定（tlOvdForRes）— 入院の扱い
   ════════════════════════════════════════════════════════════════ */
head('6. 入居者単位（入院の扱い）');
(function(){
  const sb={console:{log(){},warn(){},error(){}}};
  vm.createContext(sb);
  vm.runInContext([X.varDecl('TL_OVD_GRACE'),
    X.fn('tlOverdueList'),X.fn('tlOvdForRes'),X.fn('isFullHospDay'),X.fn('isSlotInHospPeriod'),
    X.fn('getHospEventsOnDate'),X.fn('hmToSlot')].join('\n'),sb);
  const DAY='2026-09-20';
  let recs=[];
  sb.recsByResDate=function(rid,d){return recs.filter(r=>r.residentId===rid&&r.date===d)};
  const base={id:1,schedule:['08:00','10:00','12:00']};
  const now=M('15:00');
  ok(hms(sb.tlOvdForRes(base,DAY,now))==='08:00,10:00,12:00','入院なし・記録なし → 3件とも超過');
  recs=[rec('07:50','urine')];
  ok(hms(sb.tlOvdForRes(base,DAY,now))==='10:00,12:00','当日の記録（recsByResDate）を突き合わせる');
  recs=[];
  ok(sb.tlOvdForRes(Object.assign({},base,{masterHosp:true}),DAY,now).length===0,'入居者マスタで入院中の人は判定しない');
  const full=Object.assign({},base,{hospitalizations:[{admissionAt:'2026-09-18T10:00',dischargeAt:''}]});
  ok(sb.tlOvdForRes(full,DAY,now).length===0,'完全入院日（入院の翌日以降・退院前）の人は判定しない');
  const adm=Object.assign({},base,{hospitalizations:[{admissionAt:DAY+'T10:10',dischargeAt:''}]});
  ok(hms(sb.tlOvdForRes(adm,DAY,now))==='08:00','入院当日: 入院前の 08:00 は判定・入院マーカーのコマ（10:00）と入院期間中（12:00）は除く');
  const dis=Object.assign({},base,{hospitalizations:[{admissionAt:'2026-09-15T10:00',dischargeAt:DAY+'T11:00'}]});
  ok(hms(sb.tlOvdForRes(dis,DAY,now))==='12:00','退院当日: 退院前（入院期間中）の 08:00・10:00 は除き、退院後の 12:00 は判定する');
  ok(sb.tlOvdForRes({id:2,schedule:[]},DAY,now).length===0,'予定なし → 超過なし');
  ok(sb.tlOvdForRes({id:3},DAY,now).length===0,'schedule 自体が無い → 超過なし');
  recs=[Object.assign(rec('23:50','urine'),{date:'2026-09-19'})];
  ok(sb.tlOvdForRes({id:1,schedule:['00:00']},DAY,M('01:00')).length===0,'前日（ローカル日付で1日前）の 23:50 の記録で 00:00 の予定を満たす');
  recs=[Object.assign(rec('23:50','urine'),{date:'2026-09-18'})];
  ok(sb.tlOvdForRes({id:1,schedule:['00:00']},DAY,M('01:00')).length===1,'2日前の記録は数えない');
  recs=[Object.assign(rec('23:50','urine'),{date:'2026-02-28'})];
  ok(sb.tlOvdForRes({id:1,schedule:['00:00']},'2026-03-01',M('01:00')).length===0,'月をまたぐ前日（3/1 → 2/28）も取れる');
  recs=[];
})();

/* ════════════════════════════════════════════════════════════════
   7. 上部の要約（tlOvdSummary）
   ════════════════════════════════════════════════════════════════ */
head('7. 上部の要約');
(function(){
  const els={tlOvdSum:{style:{},textContent:''},tlNowBtn:{style:{}}};
  const sb={console:{log(){},warn(){},error(){}},Date:Date};
  vm.createContext(sb);
  vm.runInContext([X.varDecl('SYNC_OVERLAP_MS'),X.fn('tlOvdSummary')].join('\n'),sb);
  sb.$=function(id){return els[id]||null};
  const d=new Date(2026,8,20,14,7,0);              // ローカル 14:07 にサーバーが読み始めた
  sb._getLastSyncTs=function(){return d.getTime()-sb.SYNC_OVERLAP_MS};
  sb.apiUrl='(接続先あり)';
  sb.tlOvdSummary(true,3);
  ok(els.tlOvdSum.textContent==='⚠️ 予定を過ぎて未記録 3件（最終取得 14:07）','今日・3件: 件数と最終取得時刻（のりしろを足し戻す）',els.tlOvdSum.textContent);
  ok(els.tlOvdSum.style.display===''&&els.tlNowBtn.style.display==='','今日の表示中は要約と「今」ボタンを出す');
  sb.tlOvdSummary(true,0);
  ok(els.tlOvdSum.textContent==='予定の未記録なし（最終取得 14:07）','0件は「予定の未記録なし」',els.tlOvdSum.textContent);
  sb.tlOvdSummary(false,5);
  ok(els.tlOvdSum.style.display==='none'&&els.tlNowBtn.style.display==='none'&&els.tlOvdSum.textContent==='','今日以外では要約も「今」ボタンも隠す');
  sb._getLastSyncTs=function(){return 0};
  sb.tlOvdSummary(true,1);
  ok(/（最終取得 —）$/.test(els.tlOvdSum.textContent),'同期の実績が無ければ時刻は「—」',els.tlOvdSum.textContent);
  sb.apiUrl='';
  sb.tlOvdSummary(true,1);
  ok(els.tlOvdSum.textContent==='⚠️ 予定を過ぎて未記録 1件','接続先が無い端末では最終取得を出さない',els.tlOvdSum.textContent);
})();

/* ════════════════════════════════════════════════════════════════
   8. 60秒のタイマー（_tlTick / setupTlTick）。記録の自動取得は 2026-10-06 に _syncPollTick へ移した
      （画面に依存しない追い読み・sync-poll.test.js が受け持つ）。ここでは _tlTick が取得しないことを見る
   ════════════════════════════════════════════════════════════════ */
head('8. 定期更新と自動取得');
function makeTickSandbox(){
  const cls=on=>({contains:c=>c==='on'&&on.v});
  const st={scOn:{v:true},ldOn:{v:false},modal:null,marks:false,sumDisp:'none',date:'D0'};
  const log={refresh:0,sync:[],render:0,resSel:0,intervals:0};
  let resolveSync=null;
  const sb={console:{log(){},warn(){},error(){}},Promise:Promise,
    Date:{now:()=>sb._now},_now:10*60*1000*1000};
  vm.createContext(sb);
  vm.runInContext([X.varDecl('TL_TICK_MS'),X.varDecl('_tlTickBound'),
    X.fn('_tlTick'),X.fn('setupTlTick')].join('\n'),sb);
  sb.document={visibilityState:'visible',querySelector:sel=>sel==='.mo.on'?st.modal:null};
  sb.$=function(id){
    if(id==='sc-tl')return{classList:cls(st.scOn)};
    if(id==='ldOv')return{classList:cls(st.ldOn)};
    if(id==='tlDate')return{value:st.date};
    if(id==='tlBox')return{querySelector:()=>st.marks?{}:null};
    if(id==='tlOvdSum')return{style:{display:st.sumDisp}};
    return null;
  };
  sb.today=()=>'D0';
  sb.apiUrl='(接続先あり)';
  sb._locked=false;sb._autoLockBusy=false;sb._syncInFlight=null;
  sb.tlOvdRefresh=()=>{log.refresh++};
  sb.syncFromAPI=(show,opts)=>{log.sync.push({show:show,opts:opts});return new Promise(r=>{resolveSync=r})};
  sb.buildResSel=()=>{log.resSel++};
  sb.tlRenderKeepScroll=()=>{log.render++};
  sb.setInterval=()=>{log.intervals++;return 1};
  return {sb,st,log,resolve:v=>{const r=resolveSync;resolveSync=null;r&&r(v)}};
}
(async function(){
  // タイマーは1本
  {
    const {sb,log}=makeTickSandbox();
    sb.setupTlTick();sb.setupTlTick();sb.setupTlTick();
    ok(log.intervals===1,'setupTlTick を何度呼んでもタイマーは1本',log.intervals);
    ok(sb.TL_TICK_MS===60000,'間隔は60秒');
  }
  // 時系列の tick は再判定だけ。何分経っても記録は取りに行かない（取得は _syncPollTick の受け持ち）
  {
    const T=makeTickSandbox();const {sb,log}=T;
    sb.setupTlTick();
    sb._tlTick();
    ok(log.refresh===1&&log.sync.length===0,'起動直後の tick は再判定だけ');
    sb._now+=5*60*1000;sb._tlTick();
    sb._now+=10*60*1000;sb._tlTick();
    ok(log.refresh===3&&log.sync.length===0,'5分・15分経っても _tlTick は syncFromAPI を呼ばない（画面依存の取得に戻っていない）',log);
  }
  await new Promise(r=>setImmediate(r));   // 後段（11〜）が使うモジュール末尾の定義が済んでから進む
  // 回さない条件
  const cases=[
    ['時系列を開いていない',T=>{T.st.scOn.v=false}],
    ['画面が見えていない',T=>{T.sb.document.visibilityState='hidden'}],
    ['自動ロック中',T=>{T.sb._locked=true}],
    ['「今日」以外を表示中',T=>{T.st.date='D-1'}],
  ];
  for(const [name,prep] of cases){
    const T=makeTickSandbox();T.sb.setupTlTick();T.sb._now+=6*60*1000;prep(T);T.sb._tlTick();
    ok(T.log.sync.length===0&&T.log.refresh===0,name+' → 再判定も自動取得もしない',T.log);
  }
  const cases2=[
    ['接続先が無い',T=>{T.sb.apiUrl=''}],
    ['自動ロックの判定中',T=>{T.sb._autoLockBusy=true}],
    ['同期が進行中（起動時・手動・自動ロック判定）',T=>{T.sb._syncInFlight={}}],
    ['モーダルを開いている',T=>{T.st.modal={}}],
    ['読み込み表示が出ている',T=>{T.st.ldOn.v=true}],
  ];
  for(const [name,prep] of cases2){
    const T=makeTickSandbox();T.sb.setupTlTick();T.sb._now+=6*60*1000;prep(T);T.sb._tlTick();
    ok(T.log.sync.length===0&&T.log.refresh===1,name+' → 再判定はするが自動取得はしない',T.log);
  }
  {
    const T=makeTickSandbox();T.sb.setupTlTick();T.st.date='D-1';T.st.marks=true;T.sb._tlTick();
    ok(T.log.refresh===1&&T.log.sync.length===0,'日付をまたいで「今日」でなくなった表示に印が残っていれば消しに行く（取得はしない）');
  }
  await asyncMore();
  finish();
})().catch(e=>{fail++;console.log('  ❌ 例外: '+(e&&e.stack||e));finish()});

/* ════════════════════════════════════════════════════════════════
   9. 既存の不具合3件（実物のハンドラを切り出して動かす）
   ════════════════════════════════════════════════════════════════ */
function handlerBody(marker){
  const i=SRC.indexOf(marker);
  if(i<0)throw new Error('ハンドラが見つかりません: '+marker);
  const open=SRC.indexOf('{',i+marker.length-1);
  return SRC.slice(open+1,matchBrace(SRC,open));
}
function part9(){
  head('9-1. 設定の保存で他のキーを消さない');
  (function(){
    const body=handlerBody("$('btnSaveCfg').addEventListener('click',function(){");
    const vals={cfgUW:'5',cfgUD:'9',cfgSW:'2',cfgSD:'4',cfgKeep:'120'};
    function run(cfg0){
      const sent=[];
      const sb={console:{log(){},warn(){},error(){}},Object:Object,isFinite:isFinite,parseInt:parseInt,
        D:{cfg:cfg0},$:id=>vals[id]!==undefined?{value:vals[id]}:null,
        pruneOldLocalRecords:()=>0,save:()=>{},apiPush:(a,d)=>{sent.push({a:a,d:JSON.parse(JSON.stringify(d))})},
        renderBoard:()=>{},renderTL:()=>{},showToast:()=>{},
        hbFieldDeny:()=>false};   /* 事務所PC の端末として動かす（現場端末の守りは field-guard.test.js） */
      vm.createContext(sb);
      vm.runInContext('(function(){'+body+'})()',sb);
      return {cfg:sb.D.cfg,sent:sent};
    }
    const r=run({urineWarnH:6,urineDangerH:8,stoolWarnD:2,stoolDangerD:3,localKeepDays:180,
      autoLockMin:45,_staffs:[{name:'職員X',active:true}],_staffsTs:123});
    ok(r.cfg.urineWarnH===5&&r.cfg.urineDangerH===9&&r.cfg.stoolDangerD===4&&r.cfg.localKeepDays===120,'画面の5項目は上書きされる',r.cfg);
    ok(r.cfg.autoLockMin===45&&Array.isArray(r.cfg._staffs)&&r.cfg._staffs.length===1&&r.cfg._staffsTs===123,
      '端末の D.cfg から autoLockMin・_staffs・_staffsTs が消えない',r.cfg);
    ok(r.sent.length===1&&r.sent[0].a==='saveCfg','saveCfg を1回送る');
    const k=Object.keys(r.sent[0].d.cfg).sort().join(',');
    ok(k==='autoLockMin,localKeepDays,stoolDangerD,stoolWarnD,urineDangerH,urineWarnH',
      'サーバーへは5項目＋autoLockMin だけ（_staffs 等は送らない）',k);
    ok(r.sent[0].d.cfg.autoLockMin===45,'autoLockMin の値をそのまま送る');
    const r2=run({urineWarnH:6,autoLockMin:'abc',_staffs:[]});
    ok(!('autoLockMin' in r2.sent[0].d.cfg),'autoLockMin が数値でなければ送らない',r2.sent[0].d.cfg);
    const r3=run(undefined);
    ok(r3.cfg.urineWarnH===5&&Object.keys(r3.sent[0].d.cfg).length===5,'D.cfg が無くても落ちず、5項目だけ送る',r3.sent[0].d.cfg);
  })();

  head('9-2. 5日表示から記録モードで入ると押したコマの日付を使う');
  (function(){
    const body=handlerBody("$$('.sch-rec').forEach(function(b){b.addEventListener('click',function(){");
    const calls=[];
    const sb={console:{log(){},warn(){},error(){}},
      schCellCtx:{rid:7,slot:20,date:'2026-09-17',mode:'record'},
      $:id=>id==='tlDate'?{value:'2026-09-20'}:(id==='mSchCellTime'?{value:'10:05'}:null),
      today:()=>'2026-09-21',slotToHM:()=>'10:00',
      closeSchedCellModal:()=>{sb.schCellCtx=null},
      jumpToInputForRecord:(rid,d,hm,t)=>{calls.push([rid,d,hm,t])}};
    vm.createContext(sb);
    vm.runInContext('(function(){'+body+'}).call({dataset:{t:"urine"}})',sb);
    ok(calls.length===1&&calls[0][1]==='2026-09-17','押したコマの日付（schCellCtx.date）で記録画面へ渡す（#tlDate ではない）',calls);
    ok(calls[0][0]===7&&calls[0][2]==='10:05'&&calls[0][3]==='urine','入居者・時刻・種別は従来どおり');
    calls.length=0;
    sb.schCellCtx={rid:7,slot:20,mode:'record'};
    vm.runInContext('(function(){'+body+'}).call({dataset:{t:"none"}})',sb);
    ok(calls.length===1&&calls[0][1]==='2026-09-20','日付を持たない時だけ従来どおり #tlDate',calls);
  })();

  head('9-3. 誘導（none）を新規保存した時のトースト');
  (function(){
    const fn=X.fn('submitRec');
    // 2026-10-16: 保存の知らせは「取り消す」付きの showUndo に変わった（間に resetForm() が入る）。どちらの形でも対応表を拾う
    const m=/const tl=(\{[^}]*\})\[ci\.type\];\s*(?:resetForm\(\);\s*(?:buildResSel\(\);[^\n]*\n\s*)?)?show(?:Toast|Undo)\('✅ '\+\(res\?res\.name:''\)\+' — '\+tl\+'を記録しました'/.exec(fn);
    ok(!!m,'新規保存のトーストの対応表を見つけた');
    if(m){
      const map=vm.runInNewContext('('+m[1]+')');
      ok(map.none==='誘導','none → 「誘導」（undefined にならない）',map);
      ok(map.urine==='排尿'&&map.stool==='排便'&&map.both==='排尿＋排便'&&map.water==='水分摂取のみ','他の種別の表示名は従来どおり',map);
    }
  })();

  head('10. 実装の作法・触らない範囲');
  (function(){
    ok(/\nfunction\s+tlOverdueList\s*\(/.test(SRC),'tlOverdueList がトップレベル function 宣言');
    const pure=X.fn('tlOverdueList');
    ok(!/document|window|\$\(|Date\.now|new Date|today\(/.test(pure),'tlOverdueList は DOM・現在時刻に触れない');
    const tl=X.fn('renderTL');
    ok(/tlIsToday=\(date===today\(\)\)/.test(tl)&&/if\(tlIsToday\)tlOvdForRes/.test(tl),'renderTL は今日の表示の時だけ判定する');
    ok(/tlOvdSummary\(tlIsToday,tlOvdN\)/.test(tl)&&/tlNowPlace\(\)/.test(tl),'renderTL の最後で要約と縦線を更新する');
    ok(!/ovd|tlOvd|tl-now/.test(X.fn('showFiveDay')),'5日表示には超過表示・縦線を出さない');
    ok(!/ovd|tlOvd|tl-now/.test(X.fn('renderBoard')),'一覧表示（renderBoard）は変えていない');
    const np=X.fn('tlNowPlace');
    ok(/th\.hr-top/.test(np)&&/offsetLeft/.test(np)&&/offsetWidth/.test(np),'縦線の位置は時の見出しの offsetLeft／offsetWidth を実測して内分する');
    ok((SRC.match(/setInterval\(_tlTick/g)||[]).length===1,'60秒タイマーの登録箇所は1つ');
    ok(/if\(!\(opts&&opts\.quiet\)\)showToast\('⚠️ API同期失敗: '/.test(X.fn('syncFromAPI')),'syncFromAPI の失敗トーストは quiet の時だけ出さない（既定は従来どおり）');
    ok(/\.tl-w\{[^}]*position:relative/.test(HTML),'.tl-w に position:relative');
    const pr=/@media print\{\.tl-now,\.tl-c\.ovd > \.ovd-lbl,#tlOvdSum,#tlNowBtn\{display:none !important\}\.tl-c\.ovd::after\{display:none !important\}\}/;
    ok(pr.test(HTML),'印刷時は縦線・「未」・赤枠・件数・今ボタンを出さない');
    ok(/\.tl-now\{[^}]*z-index:1[;}]/.test(HTML),'縦線の z-index は氏名列（2）より下');
    ok(/\.tl-c\.ovd > \.ovd-lbl\{[^}]*z-index:1[;}]/.test(HTML),'「未」の z-index も氏名列より下');
    ok(/id="tlOvdSum"/.test(HTML)&&/id="tlNowBtn"/.test(HTML),'要約と「今」ボタンの器がある');
  })();
}

/* ════════════════════════════════════════════════════════════════
   11〜12. 同期の再入ガード（全件の要求）と「最近削除した id」（2026-09-26 差し戻し対応）
   実物の syncFromAPI を切り出し、通信（apiGet）と周辺の保存・描画だけを差し替えて動かす。
   ════════════════════════════════════════════════════════════════ */
const tick=()=>new Promise(r=>setImmediate(r));
function makeSyncSandbox(){
  const log={gets:[],toasts:[],markFull:0,cursor:[],ldShow:0};
  const pend=[];
  // Date は本物のまま、now だけ差し替える（syncFromAPI は new Date() も使う）
  class FakeDate extends Date{static now(){return sb._now}}
  const sb={console:{log(){},warn(){},error(){}},Promise:Promise,JSON:JSON,Object:Object,Array:Array,String:String,Number:Number,
    Date:FakeDate,_now:1e12};
  vm.createContext(sb);
  vm.runInContext([X.varDecl('_syncInFlight'),X.fn('syncFromAPI'),X.varDecl('SYNC_OVERLAP_MS'),X.fn('_cursorFromResponse'),
    X.fn('toNum'),X.varDecl('RECENT_DEL_MS'),X.varDecl('_recentDel'),X.fn('_recentDelAdd'),X.fn('_recentDelHas'),
    // 2026-10-07 追加の変数・関数（旧版には無い＝あれば読む）
    (/var HEAL_INTERVAL_MS=/.test(SRC)?X.varDecl('HEAL_INTERVAL_MS')+'\n'+X.varDecl('_healOkAt'):''),
    (/function _delRecAddMany\(/.test(SRC)?X.fn('_delRecAddMany'):'')].join('\n'),sb);
  Object.assign(sb,{
    apiUrl:'(接続先あり)',_dateHealNeeded:false,_catchUpLoaderOn:false,_schedHealNeeded:false,_linkDropN:0,
    SYS_STAFF_SNAPSHOT_ID:'sys_snap',SYS_STAFF_SNAPSHOT_MARKER:'__SNAP__',
    DATEFIX_HEAL_KEY:'k1',SCHED_HEAL_KEY:'k2',
    _writeQ:[],_wqCurrent:null,loadPendingQueue:()=>[],
    D:{residents:[],records:[],cfg:{}},
    ldShow:()=>{log.ldShow++},ldHide:()=>{},apiSetStatus:()=>{},
    _getLastSyncTs:()=>555,_setLastSyncTs:v=>{log.cursor.push(v)},_markFullSync:()=>{log.markFull++},
    _bumpResIdHw:()=>{},_normNameX:x=>String(x||''),
    extractStaffsFromCfg:()=>0,cleanData:()=>{},save:()=>{},apiPush:()=>{},saveApiUrl:()=>{},flushPendingQueue:()=>{},
    _delRecHas:()=>false,showToast:m=>{log.toasts.push(m)},
    localStorage:{setItem(){},getItem(){return null},removeItem(){}},
    apiGet:o=>{log.gets.push(o&&o.since||0);return new Promise((res,rej)=>pend.push({res,rej}))}
  });
  const reply=(records)=>{const p=pend.shift();p.res({residents:[],records:records||[],cfg:{},syncCursor:sb._now,delta:true});};
  const failNext=()=>{const p=pend.shift();p.rej(new Error('offline'))};
  return {sb,log,reply,failNext,pend};
}
async function asyncMore(){
  head('11. 差分の進行中に来た全件の要求は、差分に吸収されず後から全件が走る');
  {
    const T=makeSyncSandbox();const {sb,log}=T;
    const pa=sb.syncFromAPI(false,{quiet:true});         // 自動取得（差分）
    const pb=sb.syncFromAPI(true,{full:true});            // 「同期」ボタン（全件）
    const pc=sb.syncFromAPI(false);                       // 差分どうしは相乗り
    await tick();
    ok(log.gets.length===1&&log.gets[0]===555,'差分の進行中は取得は1本だけ（全件はまだ出さない）',log.gets);
    T.reply([]);await tick();await tick();await tick();
    const ra=await pa, rc=await pc;
    ok(ra===true&&rc===true,'差分の要求（自動取得・相乗り）は差分の結果を受け取る');
    ok(log.gets.length===2&&log.gets[1]===0,'差分が終わった後で、全件（since=0）の取得を改めて出す',log.gets);
    ok(log.ldShow===1,'全件の要求どおり読み込み表示を出す（showLoader は要求側に従う）',log.ldShow);
    ok(log.markFull===0,'全件がまだ終わっていない間は _markFullSync しない');
    T.reply([]);
    const rb=await pb;
    ok(rb===true&&log.markFull===1,'全件が実際に走り _markFullSync まで従来どおり',{rb:rb,markFull:log.markFull});
    ok(log.cursor.length===2,'カーソルの保存も差分・全件それぞれで従来どおり',log.cursor);
  }
  {
    const T=makeSyncSandbox();const {sb,log}=T;
    const pa=sb.syncFromAPI(false,{quiet:true});
    const pb=sb.syncFromAPI(true,{full:true});
    await tick();
    T.failNext();await tick();await tick();await tick();
    ok((await pa)===false&&log.toasts.length===0,'進行中の差分（quiet）が失敗してもトーストは出ない');
    ok(log.gets.length===2&&log.gets[1]===0,'差分が失敗しても全件の要求は改めて実行する',log.gets);
    T.failNext();
    ok((await pb)===false&&log.toasts.length===1&&/API同期失敗/.test(log.toasts[0]),'全件側の失敗は要求側（quiet なし）に従ってトーストを出す',log.toasts);
  }
  {
    const T=makeSyncSandbox();const {sb,log}=T;
    const pa=sb.syncFromAPI(true,{full:true});
    const pb=sb.syncFromAPI(true,{full:true});
    const pc=sb.syncFromAPI(false,{quiet:true});
    await tick();
    T.reply([]);
    ok((await pa)===true&&(await pb)===true&&(await pc)===true,'全件の進行中には全件・差分とも相乗り');
    ok(log.gets.length===1&&log.markFull===1,'取得は1本・_markFullSync も1回（従来どおり）',{gets:log.gets,markFull:log.markFull});
  }
  {
    const T=makeSyncSandbox();const {sb,log}=T;
    const pa=sb.syncFromAPI(false);
    const pb=sb.syncFromAPI(true,{full:true});
    const pc=sb.syncFromAPI(true,{full:true});
    await tick();T.reply([]);
    for(let i=0;i<6;i++)await tick();
    ok(log.gets.length===2,'差分の進行中に全件の要求が2つ来ても、後から走る全件は1本（2つ目は全件に相乗り）',log.gets);
    T.reply([]);
    ok((await pb)===true&&(await pc)===true&&log.markFull===1,'どちらの要求も全件の結果を受け取る');
    await pa;
  }

  head('12. 削除を送り終えた記録を、削除前のサーバー行から取り込み直さない');
  {
    const T=makeSyncSandbox();const {sb,log}=T;
    const row=(id)=>({id:id,residentId:1,date:'2026-09-20',time:'10:00',datetime:'2026-09-20T10:00',type:'urine'});
    sb.D.records=[row('keep')];                 // 'del' は端末で削除済み（D からは消えている）
    const p=sb.syncFromAPI(false,{quiet:true});await tick();   // 取得開始（リクエスト送信）
    sb._now+=3000;sb._recentDelAdd('del');       // その後で削除の送信が完了
    T.reply([row('del'),row('other')]);          // 削除より先に読み始めた応答＝削除前の行が載っている
    await p;
    const ids=sb.D.records.map(r=>r.id).sort().join(',');
    ok(ids==='keep,other','削除の完了より前に始めた同期 → 削除前のサーバー行を取り込まない（他の記録は通常どおり）',ids);
  }
  {
    const T=makeSyncSandbox();const {sb}=T;
    const row=(id)=>({id:id,residentId:1,date:'2026-09-20',time:'10:00',datetime:'2026-09-20T10:00',type:'urine'});
    sb._recentDelAdd('del');                     // 先に削除の送信が完了
    sb._now+=3000;
    const p=sb.syncFromAPI(false,{quiet:true});await tick();   // その後で始めた同期
    T.reply([row('del')]);                       // この時点のサーバー行＝作り直された正しい行
    await p;
    ok(sb.D.records.some(r=>r.id==='del'),'削除の完了より後に始めた同期 → サーバー行を取り込む（控えが期限内でも除外しない）');
  }
  {
    const T=makeSyncSandbox();const {sb}=T;
    sb._recentDelAdd('x0');
    ok(sb._recentDelHas('x0',sb._now)===true,'取得開始と削除完了が同時刻なら除外側（削除前の行が載りうる）');
    ok(sb._recentDelHas('x0',sb._now+1)===false,'取得開始が1ms でも後なら除外しない');
    ok(sb._recentDelHas('x0',sb._now-1)===true,'取得開始が前なら除外する');
  }
  {
    const T=makeSyncSandbox();const {sb}=T;
    const row=(id)=>({id:id,residentId:1,date:'2026-09-20',time:'10:00',datetime:'2026-09-20T10:00',type:'urine'});
    const p=sb.syncFromAPI(false);await tick();
    T.reply([row('del')]);await p;
    ok(sb.D.records.some(r=>r.id==='del'),'（対照）控えが無ければ取り込まれる＝除外が効いているのは控えのおかげ');
  }
  {
    const T=makeSyncSandbox();const {sb}=T;
    sb._recentDelAdd('x1');
    ok(sb._recentDelHas('x1')===true,'控えた直後は「最近削除した」');
    sb._now+=10*60*1000-1;ok(sb._recentDelHas('x1')===true,'10分以内は保持');
    sb._now+=2;ok(sb._recentDelHas('x1')===false,'10分を過ぎたら期限切れ');
    ok(sb._recentDelHas('never')===false,'控えていない id は対象外');
    sb._recentDelAdd(null);sb._recentDelAdd('');
    ok(Object.keys(sb._recentDel).length===0,'空の id は控えない（期限切れの項目も掃除される）',Object.keys(sb._recentDel));
  }
  {
    // 送信の成功で控える（順次送信キュー _writeDrain）
    const mk=(resp)=>{
      const sb={console:{log(){},warn(){},error(){}},Promise:Promise,Date:{now:()=>1e12}};
      vm.createContext(sb);
      vm.runInContext([X.varDecl('_writeQ'),X.varDecl('_wqCurrent'),X.fn('_writeDrain'),
        X.varDecl('RECENT_DEL_MS'),X.varDecl('_recentDel'),X.fn('_recentDelAdd'),X.fn('_recentDelHas')].join('\n'),sb);
      Object.assign(sb,{_wqPersist(){},flushPendingQueue(){},apiSetStatus(){},showToast(){},enqueuePending(){},
        isDroppableOnOldGas:()=>false,apiPost:()=>typeof resp==='function'?resp():Promise.resolve(resp)});
      return sb;
    };
    let sb=mk({ok:true});
    sb._writeQ.push({action:'delRecord',data:{id:'d1'}},{action:'saveRecord',data:{record:{id:'s1'}}});
    sb._writeDrain();for(let i=0;i<6;i++)await tick();
    ok(sb._recentDelHas('d1')===true&&sb._recentDelHas('s1')===false,'削除の送信が成功したら id を控える（修正の送信は控えない）');
    sb=mk({ok:false,error:'x'});
    sb._writeQ.push({action:'delRecord',data:{id:'d2'}});
    sb._writeDrain();for(let i=0;i<6;i++)await tick();
    ok(sb._recentDelHas('d2')===false,'削除の送信が失敗した時は控えない（未送信キュー側の _unsentDel が守る）');
    sb=mk(()=>Promise.reject(new Error('net')));
    sb._writeQ.push({action:'delRecord',data:{id:'d3'}});
    sb._writeDrain();for(let i=0;i<6;i++)await tick();
    ok(sb._recentDelHas('d3')===false,'通信エラーの時も控えない');
  }
  {
    // 再送（flushPendingQueue）の成功でも控える
    const sb={console:{log(){},warn(){},error(){}},Promise:Promise,Date:{now:()=>1e12}};
    vm.createContext(sb);
    vm.runInContext([X.varDecl('_pqFlushing'),X.fn('flushPendingQueue'),
      X.varDecl('RECENT_DEL_MS'),X.varDecl('_recentDel'),X.fn('_recentDelAdd'),X.fn('_recentDelHas')].join('\n'),sb);
    let q=[{action:'delRecord',data:{id:'p1'}},{action:'delRecord',data:{id:'p2'}}];
    Object.assign(sb,{apiUrl:'(接続先あり)',loadPendingQueue:()=>q.slice(),savePendingQueue:v=>{q=v},showToast(){},
      isDroppableOnOldGas:()=>false,apiPost:(a,d)=>Promise.resolve(d.id==='p1'?{ok:true}:{ok:false})});
    await new Promise(r=>sb.flushPendingQueue(r));
    ok(sb._recentDelHas('p1')===true&&sb._recentDelHas('p2')===false,'再送で削除できた id も控える（失敗した分は控えない）');
  }
  {
    const src=X.fn('_recentDelAdd')+X.fn('_recentDelHas');
    ok(!/localStorage|sessionStorage|_storageSet/.test(src),'最近削除した id は端末のメモリだけ（localStorage に保存しない）');
    ok(/if\(_unsentDel\[String\(r\.id\)\]\)\{seenRecId\[r\.id\]=true;return;\}\s*\/\/[^\n]*\n\s*if\(_recentDelHas\(r\.id,_fetchStartAt\)\)\{seenRecId\[r\.id\]=true;return;\}/.test(X.fn('syncFromAPI')),
      '取り込み時の除外は _unsentDel の直後で同じ扱い（手動の同期にも効く）');
    ok(/var _fetchStartAt=Date\.now\(\);[^\n]*\n(?:\s*\/\*[^\n]*\*\/\n)?\s*var json=(?:\(typeof opts\.fetch==='function'\)\?await opts\.fetch\(\):)?await apiGet\(/.test(X.fn('syncFromAPI')),'取得開始時刻はリクエストを送る直前に取る（追いつきの取得の差し替え opts.fetch も同じ位置）');
  }
}

function finish(){
  try{part9()}catch(e){fail++;console.log('  ❌ 例外: '+(e&&e.stack||e))}
  console.log('\n══════════════════════════════════');
  console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
  console.log('══════════════════════════════════');
  process.exit(fail?1:0);
}
