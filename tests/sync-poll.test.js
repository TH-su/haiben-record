/* ══════════════════════════════════════════════════════════════════════
   記録の追い読み（画面に依存しない同期）の検証ハーネス（2026-10-06）
   実行:  node tests/sync-poll.test.js
   ──────────────────────────────────────────────────────────────────────
   なぜ必要か: それまで記録の取得は「時系列画面を開いている間だけ」走っていた。
   一覧表示・入力画面を開いたままの端末は起動後ずっとサーバーと行き来せず、
   ①他端末の記録が届かない ②未送信キューが再送されない の2つが同時に起きていた
   （2026-10-06 朝、6時台の排便記録が他のタブレットに午後まで出なかった事象）。
   ここが画面に依存する実装へ戻ったら、このテストが落ちる。

   ★実物のソース（haiben-record.html）をそのまま評価する。判定ロジックを写経しない。
   ★記録はすべて合成データ。実在の氏名・記録は使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeExtractor}=require('./_extract');

const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();
const X=makeExtractor(SRC);
const HAS_RETRY=/function _syncPollRetrySoon\(/.test(SRC);   // 2026-10-07 追加の機能（旧版では節7を飛ばす）

let fail=0,pass=0;
function ok(c,m){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m)}}
function head(t){console.log('\n─── '+t+' ───')}

/* ════════ 砂場 ════════
   DOM と syncFromAPI はスタブ。追い読みの判定（いつ走る／走らない）だけを実物で動かす。 */
function makeSandbox(state){
  state=state||{};
  const calls={sync:0,flush:0,timers:[]};
  const scr={'sc-tl':!!state.tlOn,'sc-board':!!state.boardOn};
  const sb={
    console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,isNaN,parseInt,parseFloat,
    Promise,setInterval(){},setTimeout(f,ms){calls.timers.push({f:f,ms:ms});return 0},
    document:{
      visibilityState: state.visible===false?'hidden':'visible',
      querySelector(sel){ return (sel==='.mo.on' && state.modalOpen)?{}:null },
      addEventListener(){}
    },
    // 画面要素: id ごとに classList.contains('on') を返す
    $(id){
      if(id==='ldOv')return state.loading?{classList:{contains:()=>true}}:{classList:{contains:()=>false}};
      if(id in scr)return{classList:{contains:(c)=>c==='on'&&scr[id]}};
      return null;
    },
    syncFromAPI(showLoader,opts){ calls.sync++; const r=Array.isArray(state.syncResult)?state.syncResult.shift():state.syncResult; return Promise.resolve(r===undefined?true:r) },
    /* 2026-10-28: 差分の基準が無い時は追いつき（syncCatchUp）を呼ぶ。この試験は「いつ取りに行くか」だけを見るので、どちらも1回の取得に数える */
    _getLastSyncTs(){ return state.noCursor?0:1 },
    syncCatchUp(showLoader){ calls.sync++; calls.catchUp=(calls.catchUp||0)+1; const r=Array.isArray(state.syncResult)?state.syncResult.shift():state.syncResult; return Promise.resolve(r===undefined?true:r) },
    _netLastErTransient(){ return state.transient!==false },
    flushPendingQueue(){ calls.flush++ },
    _unsentCount(){ return state.unsent||0 },
    buildResSel(){}, renderBoard(){}, tlRenderKeepScroll(){},
    apiUrl: state.apiUrl===undefined?'http://x/exec':state.apiUrl,
    _locked: !!state.locked, _autoLockBusy: !!state.lockBusy, _syncInFlight: state.inFlight||null
  };
  vm.createContext(sb);
  vm.runInContext([
    X.varDecl('SYNC_POLL_MS'),X.varDecl('SYNC_POLL_BACKOFF_MS'),
    X.varDecl('SYNC_POLL_FAIL_MAX'),X.varDecl('SYNC_VISIBLE_GAP_MS'),
    X.varDecl('_syncPollAt'),
    X.fn('_syncPollDue'),X.fn('_syncPollTick'),X.fn('_unsentPollTick'),
    (HAS_RETRY?X.varDecl('SYNC_RESUME_RETRY_MS')+'\n'+X.fn('_syncPollRetrySoon'):'')
  ].join('\n'),sb);
  sb._syncPollAt=0; sb._syncPollBusy=false; sb._syncPollFails=0;
  sb.__calls=calls;
  return sb;
}

/* ════════════════════════════════════════════════════════════════
   1. 画面に依存しないこと（これが今回の本丸）
   ════════════════════════════════════════════════════════════════ */
head('1. どの画面でも取りに行く');
(function(){
  // 一覧表示（事故が起きた時の画面）
  const bd=makeSandbox({boardOn:true,tlOn:false});
  bd._syncPollTick();
  ok(bd.__calls.sync===1,'一覧表示でも取りに行く（ここが直った点）: '+bd.__calls.sync);

  // 時系列（従来も動いていた画面）
  const tl=makeSandbox({tlOn:true,boardOn:false});
  tl._syncPollTick();
  ok(tl.__calls.sync===1,'時系列でも従来どおり取りに行く: '+tl.__calls.sync);

  // 入力・帳票など、どの画面も開いていない扱い
  const other=makeSandbox({boardOn:false,tlOn:false});
  other._syncPollTick();
  ok(other.__calls.sync===1,'入力・帳票など他の画面でも取りに行く: '+other.__calls.sync);
})();

/* ════════════════════════════════════════════════════════════════
   2. 回してはいけない時は回さない
   ════════════════════════════════════════════════════════════════ */
head('2. 抑止の条件');
(function(){
  const cases=[
    ['画面が消えている端末', {visible:false}],
    ['接続先が未設定',       {apiUrl:''}],
    ['自動ロック中',         {locked:true}],
    ['ロック判定の最中',     {lockBusy:true}],
    ['別の同期が進行中',     {inFlight:{}}],
    ['モーダルを開いている', {modalOpen:true}],
    ['読み込み表示が出ている',{loading:true}]
  ];
  cases.forEach(function(c){
    const sb=makeSandbox(Object.assign({boardOn:true},c[1]));
    sb._syncPollTick();
    ok(sb.__calls.sync===0,c[0]+'＝取りに行かない');
  });
})();

/* ════════════════════════════════════════════════════════════════
   3. 間隔と、画面に戻った時の即取得
   ════════════════════════════════════════════════════════════════ */
head('3. 間隔の判定');
(function(){
  const sb=makeSandbox({boardOn:true});
  sb._syncPollAt=Date.now();                 // いま取ったばかり
  ok(sb._syncPollDue()===false,'取った直後は次の回を待つ');
  sb._syncPollTick();
  ok(sb.__calls.sync===0,'間隔が来ていなければ取りに行かない');
  sb._syncPollTick(true);                    // force＝画面に戻った時
  ok(sb.__calls.sync===1,'force なら間隔を待たずに取りに行く（画面に戻った時）');

  const sb2=makeSandbox({boardOn:true});
  sb2._syncPollAt=Date.now()-(sb2.SYNC_POLL_MS+1000);
  ok(sb2._syncPollDue()===true,'間隔が過ぎていれば取りに行く');
})();

/* ════════════════════════════════════════════════════════════════
   4. 連続失敗で間隔を落とす（落ちているサーバーを全端末で叩き続けない）
   ════════════════════════════════════════════════════════════════ */
head('4. 失敗時のバックオフ');
(function(){
  const sb=makeSandbox({boardOn:true});
  sb._syncPollFails=sb.SYNC_POLL_FAIL_MAX;
  sb._syncPollAt=Date.now()-(sb.SYNC_POLL_MS+1000);   // 通常の間隔は過ぎている
  ok(sb._syncPollDue()===false,'連続失敗中は通常の間隔では取りに行かない');
  sb._syncPollAt=Date.now()-(sb.SYNC_POLL_BACKOFF_MS+1000);
  ok(sb._syncPollDue()===true,'落とした間隔を過ぎれば取りに行く');
  ok(sb.SYNC_POLL_BACKOFF_MS>sb.SYNC_POLL_MS,'落とした間隔は通常より長い');
})();

/* ════════════════════════════════════════════════════════════════
   5. 未送信キューの追い読み（6時台の記録が送れないまま残った件）
   ════════════════════════════════════════════════════════════════ */
head('5. 未送信の再送');
(function(){
  const has=makeSandbox({boardOn:true,unsent:1});
  has._unsentPollTick();
  ok(has.__calls.flush===1,'未送信が残っていれば送り直しを試す: '+has.__calls.flush);

  const none=makeSandbox({boardOn:true,unsent:0});
  none._unsentPollTick();
  ok(none.__calls.flush===0,'未送信が無ければ何もしない');

  const locked=makeSandbox({boardOn:true,unsent:3,locked:true});
  locked._unsentPollTick();
  ok(locked.__calls.flush===0,'自動ロック中は送り直さない');

  const hidden=makeSandbox({boardOn:true,unsent:3,visible:false});
  hidden._unsentPollTick();
  ok(hidden.__calls.flush===0,'画面が消えている端末では送り直さない');
})();

/* ════════════════════════════════════════════════════════════════
   6. 回帰: 時系列の tick に記録の取得を戻していないか
   ════════════════════════════════════════════════════════════════ */
head('6. 回帰（画面依存に戻していないか）');
(function(){
  const tlTick=X.fn('_tlTick');
  // 「呼び出し」だけを見る（説明のコメントに名前が出るのは可）
  ok(!/syncFromAPI\(|_syncPollTick\(|_tlAutoSync\(/.test(tlTick),
    '_tlTick は記録の取得を呼ばない（時系列の表示更新だけ）');
  ok(/sc-tl/.test(tlTick),'_tlTick は従来どおり時系列画面のときだけ描き直す');

  const poll=X.fn('_syncPollTick');
  ok(!/sc-tl['"]\)\s*;\s*\n?\s*if\(!sc/.test(poll),'_syncPollTick は時系列画面を条件にしていない');
  ok(/visibilityState/.test(poll),'_syncPollTick は可視のときだけ動く');
  ok(/renderBoard/.test(poll),'取り込んだあと一覧を描き直す（数字が古いまま残らない）');

  ok(/setupSyncPoll/.test(SRC),'起動時に追い読みを登録している');
})();

/* ════════════════════════════════════════════════════════════════
   7. 画面に戻った直後の失敗を1回だけやり直す（2026-10-07）
   ════════════════════════════════════════════════════════════════ */
head('7. 画面復帰直後のやり直し');
(async function(){
  if(!HAS_RETRY){console.log('  （この版には無い機能＝飛ばす）');return}
  const tick=()=>new Promise(r=>setImmediate(r));
  // 通信系の失敗 → 3秒後に1回だけ
  const a=makeSandbox({boardOn:true,syncResult:[false,true],transient:true});
  a._syncPollTick(true,true);await tick();
  ok(a.__calls.timers.length===1&&a.__calls.timers[0].ms===a.SYNC_RESUME_RETRY_MS&&a.SYNC_RESUME_RETRY_MS===3000,
    '画面復帰の取得が通信系で失敗したら、3秒後のやり直しを1回だけ入れる',a.__calls.timers.map(t=>t.ms));
  a.__calls.timers[0].f();await tick();
  ok(a.__calls.sync===2,'3秒後に取りに行き直す',a.__calls.sync);
  ok(a._syncPollFails===0,'やり直しが成功したら失敗の数を0に戻す');

  // やり直しも失敗 → それ以上は連鎖しない
  const b=makeSandbox({boardOn:true,syncResult:[false,false],transient:true});
  b._syncPollTick(true,true);await tick();
  b.__calls.timers[0].f();await tick();
  ok(b.__calls.timers.length===1,'やり直しが失敗しても、さらにやり直さない（連鎖しない＝次は通常の間隔）',b.__calls.timers.length);

  // サーバーが断った（認証・HTTP 等）→ やり直さない
  const c=makeSandbox({boardOn:true,syncResult:[false],transient:false});
  c._syncPollTick(true,true);await tick();
  ok(c.__calls.timers.length===0,'通信系でない失敗（サーバーが断った）はやり直さない＝同じ結果になるだけ');

  // 5分ごとの通常の取得 → やり直さない
  const d=makeSandbox({boardOn:true,syncResult:[false],transient:true});
  d._syncPollTick();await tick();
  ok(d.__calls.timers.length===0,'5分ごとの通常の取得の失敗ではやり直さない（画面復帰の時だけ）');

  // 成功 → 何も入れない
  const e=makeSandbox({boardOn:true,syncResult:[true]});
  e._syncPollTick(true,true);await tick();
  ok(e.__calls.timers.length===0,'成功したらやり直さない');

  ok(/_syncPollTick\(true,true\)/.test(X.fn('setupSyncPoll')),'画面に戻った時だけ「1回だけやり直す」付きで呼ぶ');
})().then(fin,function(err){fail++;console.log('  ❌ 例外: '+(err&&err.stack||err));fin()});

function fin(){
console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
}
