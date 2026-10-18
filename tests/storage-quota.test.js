/* ══════════════════════════════════════════════════════════════════════
   端末の保存領域が満杯の時の逃げ道（2026-10-16）の検証ハーネス
   実行:  node tests/storage-quota.test.js
   ──────────────────────────────────────────────────────────────────────
   なぜ必要か: 保存領域（localStorage・サイト単位で約5MB・care-tools と共用）が、本体と予備の写しの
   2部持ちで満杯になり「保存エラー」が同期のたびに出ていた。書けない時は ①予備を消して以後作らない
   ②古い記録を整理 ③この端末だけ保持日数を 120→92 日へ縮める、で書き切る。ここが崩れると
   端末の写し・送信待ちの控えが書けず、通信の無い時に閉じた記録が失われうるので、このテストで止める。

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

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra):''))}}
function head(t){console.log('\n─── '+t+' ───')}

/* ════════ 砂場 ════════
   localStorage は「全キーの文字数の合計」が上限を越えたら QuotaExceededError を投げる偽物（ブラウザと同じ数え方）。
   置き換え（同じキーへの書き直し）は古い値を差し引いて数える。 */
function makeSandbox(opt){
  opt=opt||{};
  const store={}, writes=[], toasts=[];
  function used(exceptKey){let n=0;for(const k in store){if(k!==exceptKey)n+=k.length+store[k].length}return n}
  const sb={
    console:{log(){},warn(){},error(){}},Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,Promise,RegExp,Date,
    setTimeout(){return 0},clearTimeout(){},
    localStorage:{
      getItem:k=>(k in store?store[k]:null),
      setItem:(k,v)=>{
        v=String(v);
        if(opt.otherErr&&k==='hbcr_v2'){throw new Error('SecurityError: 書けません')}
        if(sb.__quota!=null&&used(k)+k.length+v.length>sb.__quota){const e=new Error("Failed to execute 'setItem' on 'Storage': Setting the value of '"+k+"' exceeded the quota.");e.name='QuotaExceededError';e.code=22;throw e}
        store[k]=v;writes.push(k);
      },
      removeItem:k=>{delete store[k]}
    },
    showToast(m){toasts.push(m)},
    _locked:false,_recIdx:null,
    Date:Date
  };
  sb.__quota=opt.quota!=null?opt.quota:null;
  vm.createContext(sb);
  vm.runInContext([
    X.fn('_lzFactory'),X.varDecl('LZString'),X.varDecl('COMPRESS_MAGIC'),X.fn('_storageSet'),X.fn('_storageGet'),
    'var _saveTimer=null,_saveDirty=false;var _idbMode=false,_idbMigrating=false,_storeHalt=false;',X.varDecl('_SAVE_DELAY_MS'),
    'var _pzQueuedJson=null;var _pzGen=0,_pzWrittenGen=0,_pzPending={};var _pzWorker=null,_pzWorkerBroken=true;',
    X.varDecl('PZ_WORKER_MIN'),X.varDecl('PZ_WORKER_TIMEOUT_MS'),'var _pzWatch=null;',X.fn('_pzArmWatch'),
    X.fn('_pzWorkerReady'),X.fn('_pzOnDone'),X.fn('_pzOnBroken'),X.fn('_persistWrite'),X.fn('_persistNow'),
    X.fn('_pzFlushPending'),X.fn('_pzSettle'),
    X.varDecl('BAK_OFF_KEY'),X.fn('_isQuotaErr'),X.fn('_bakOff'),X.fn('_dropBak'),X.fn('_freeLocalSpace'),X.fn('_keepCap'),X.fn('_localKeepDays'),
    X.fn('pruneOldLocalRecords'),X.fn('_hbKeepFrom'),
    X.varDecl('_storageWarnAt'),X.fn('_warnStorage'),X.fn('_persistFail'),X.fn('save'),X.fn('flushSave'),
    X.varDecl('PQ_KEY'),'var _pqCount=0;',X.fn('savePendingQueue'),X.fn('loadPendingQueue')
  ].join('\n'),sb);
  sb.D={residents:[{id:1,name:'入居者A'}],records:[],cfg:{localKeepDays:180}};
  sb.__store=store;sb.__writes=writes;sb.__toasts=toasts;sb.__used=()=>used(null);
  sb.__disk=()=>{const v=sb._storageGet('hbcr_v2');return v==null?null:JSON.parse(v)};
  return sb;
}
function ymd(off){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+off);
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
/* 直近 days 日に1日 perDay 件。備考は日ごとに違う文にして圧縮が効きすぎないようにする */
function spread(days,perDay){
  const a=[];let id=1;
  for(let d=0;d<days;d++)for(let j=0;j<perDay;j++){
    a.push({id:'r'+(id++),residentId:1,date:ymd(-d),time:('0'+(6+j*3)).slice(-2)+':00',datetime:ymd(-d)+'T'+('0'+(6+j*3)).slice(-2)+':00',
      type:j%2?'urine':'stool',staff:'職員'+((d*7+j)%13),notes:'合成'+(d*31+j*17)%997+'-'+Math.random().toString(36).slice(2,10)});
  }
  return a;
}
/* その記録で本体を書いた時の大きさ（圧縮後の文字数・キー名込み） */
function sizeOf(records){
  const t=makeSandbox();t.D.records=records;t._storageSet('hbcr_v2',JSON.stringify(t.D));return t.__used();
}
function persist(sb){sb._saveDirty=true;sb._persistNow()}

/* ════════════════════════════════════════════════════════════════
   1. 容量に余裕がある時は従来どおり（予備の写しを作る・上限を付けない）
   ════════════════════════════════════════════════════════════════ */
head('1. 余裕がある時は従来どおり');
(function(){
  const sb=makeSandbox();
  sb.D.records=spread(10,3);persist(sb);
  sb.D.records.push(spread(1,1)[0]);persist(sb);
  ok(sb.__store['hbcr_v2_bak']!==undefined,'書く前に旧版を予備へ写す');
  ok(sb._bakOff()===false,'予備を止める印は付かない');
  ok(sb._keepCap()===0&&sb._localKeepDays()===180,'保持日数は設定の180日のまま',sb._localKeepDays());
  ok(sb.__toasts.length===0,'知らせは出ない',sb.__toasts);
})();

/* ════════════════════════════════════════════════════════════════
   2. 本体1部は入るが、予備と2部は入らない → 予備を消して書き切る
   ════════════════════════════════════════════════════════════════ */
head('2. 予備の写しを消して書き切る');
(function(){
  const recs=spread(60,3);
  const one=sizeOf(recs);
  const sb=makeSandbox();
  sb.D.records=recs.slice(0,-3);persist(sb);                  // 1回目（予備なし）
  sb.__quota=Math.floor(one*1.6);                               // 2部は入らない
  sb.D.records=recs;persist(sb);
  ok(sb.__store['hbcr_v2_bak']===undefined,'予備の写しは消えている');
  ok(sb._bakOff()===true,'この端末では以後予備を作らない印が付く');
  ok(sb.__disk()&&sb.__disk().records.length===recs.length,'本体には最新の全件が書けている',sb.__disk()&&sb.__disk().records.length);
  ok(sb.__toasts.length===0,'書けたので知らせは出ない',sb.__toasts);
  ok(sb._keepCap()===0,'保持日数は縮めていない');
  // 次の保存でも予備を作らない
  sb.D.records=recs.concat(spread(1,1).map(r=>Object.assign(r,{id:'x1'})));persist(sb);
  ok(sb.__store['hbcr_v2_bak']===undefined,'次の保存でも予備を作らない');
  ok(sb.__disk().records.length===recs.length+1,'次の保存も書ける');
})();

/* 2b. 予備を写すのは成功し、その後の本体の書き直しで溢れる場合（古い版が小さく、新しい版が大きい） */
head('2b. 本体の書き直しで溢れる場合');
(function(){
  const small=spread(20,3), big=spread(80,3);
  const X1=sizeOf(small), Y=sizeOf(big);
  ok(Y>X1*2,'前提: 新しい版は古い版の2倍より大きい',[X1,Y]);
  const sb=makeSandbox();
  sb.D.records=small;persist(sb);
  sb.__quota=Y+Math.floor(X1/2);                 // 予備(X1)+新(Y) は入らないが、新(Y)だけなら入る
  sb.D.records=big;persist(sb);
  ok(sb.__disk()&&sb.__disk().records.length===big.length,'本体に新しい版が書けている',sb.__disk()&&sb.__disk().records.length);
  ok(sb.__store['hbcr_v2_bak']===undefined&&sb._bakOff(),'予備は消し、以後作らない印が付く');
  ok(sb._keepCap()===0&&sb.__toasts.length===0,'保持日数は縮めず、知らせも出ない',[sb._keepCap(),sb.__toasts]);
})();

/* ════════════════════════════════════════════════════════════════
   3. 180日分そのものが入らない → この端末だけ 120 日に縮めて書く（設定の値は変えない）
   ════════════════════════════════════════════════════════════════ */
head('3. 保持日数を段階的に縮める');
(function(){
  const recs=spread(180,4);
  const s180=sizeOf(recs), s120=sizeOf(recs.filter(r=>r.date>=ymd(-120)));
  ok(s120<s180,'前提: 120日分は180日分より小さい',[s120,s180]);
  const sb=makeSandbox({quota:Math.floor((s120+s180)/2)});
  sb.D.records=recs;persist(sb);
  ok(sb._keepCap()===120,'この端末の上限が120日になる',sb._keepCap());
  ok(sb.D.cfg.localKeepDays===180,'設定の値（180日）は変えない',sb.D.cfg.localKeepDays);
  const disk=sb.__disk();
  ok(disk&&disk.records.length>0&&disk.records.every(r=>r.date>=ymd(-120)),'本体には直近120日分が書けている',disk&&disk.records.length);
  ok(sb.__toasts.length===0,'書けたので知らせは出ない',sb.__toasts);
  ok(sb._hbKeepFrom()===ymd(-120),'日別の照合も同じ120日から始める（縮めた分を取り込み直さない）',sb._hbKeepFrom());
})();

/* ════════════════════════════════════════════════════════════════
   4. 92日でも入らない → 92日より短くしない・知らせは30分に1回まで・次の保存で再試行できる
   ════════════════════════════════════════════════════════════════ */
head('4. 92日が下限・知らせの間引き');
(function(){
  const recs=spread(180,4);
  const sb=makeSandbox({quota:2000});
  sb.D.records=recs;persist(sb);
  ok(sb._keepCap()===92,'上限は92日で止まる（過去3か月の平均に要る）',sb._keepCap());
  ok(sb.D.records.every(r=>r.date>=ymd(-92))&&sb.D.records.length>0,'92日より新しい記録は残す');
  ok(sb.__toasts.length===1,'書けなかったことを1回知らせる',sb.__toasts);
  ok(/保存領域が不足/.test(sb.__toasts[0]||''),'知らせは日本語で何が起きたかを言う',sb.__toasts[0]);
  ok(sb._saveDirty===true,'書けなかった＝次の保存で書き直す印を残す');
  sb.D.records.push(Object.assign(spread(1,1)[0],{id:'y1'}));persist(sb);
  ok(sb.__toasts.length===1,'30分以内の2回目は知らせない（同期のたびに出さない）',sb.__toasts.length);
  sb._storageWarnAt=Date.now()-31*60*1000;
  sb.D.records.push(Object.assign(spread(1,1)[0],{id:'y2'}));persist(sb);
  ok(sb.__toasts.length===2,'30分たてばもう一度知らせる',sb.__toasts.length);
  // 空きができたら書ける
  sb.__quota=null;
  sb.D.records.push(Object.assign(spread(1,1)[0],{id:'y3'}));persist(sb);
  ok(sb.__disk()&&sb.__disk().records.some(r=>r.id==='y3'),'空きができれば次の保存で書ける');
})();

/* ════════════════════════════════════════════════════════════════
   5. 送信待ちの控え：間引く前に本体の予備を消して丸ごと残す
   ════════════════════════════════════════════════════════════════ */
head('5. 送信待ちの控えを間引かない');
(function(){
  const sb=makeSandbox();
  sb.D.records=spread(40,3);persist(sb);
  sb.D.records.push(Object.assign(spread(1,1)[0],{id:'z1'}));persist(sb);     // 予備ができる
  ok(sb.__store['hbcr_v2_bak']!==undefined,'前提: 予備の写しがある');
  const q=[];for(let i=0;i<40;i++)q.push({action:'addRecord',data:{record:{id:'q'+i,notes:Math.random().toString(36)}}});
  const t=makeSandbox();t.savePendingQueue(q);const qLen=t.__used();          // 控えの大きさ（圧縮後）
  const bakLen=(sb.__store['hbcr_v2_bak']||'').length;
  ok(bakLen>qLen,'前提: 予備の写しは控えより大きい',[bakLen,qLen]);
  sb.__quota=sb.__used()+Math.floor(qLen/2);                                  // 今のままでは入らず、予備を消せば入る
  sb.savePendingQueue(q);
  const back=sb.loadPendingQueue();
  ok(back.length===40,'送信待ちは40件すべて残る（半分に間引かない）',back.length);
  ok(sb.__store['hbcr_v2_bak']===undefined&&sb._bakOff(),'代わりに本体の予備を消した');
  ok(!sb.__toasts.some(t=>/一部のみ/.test(t)),'「一部のみ保持」の知らせは出ない',sb.__toasts);
})();

/* 5b. 予備を既に消した端末：控えを間引く前に、本体の保持日数を縮めて場所を空ける（レビュー指摘 2026-10-16） */
head('5b. 予備が無い端末でも控えを間引かない');
(function(){
  const recs=spread(180,4);
  const sb=makeSandbox();
  sb.localStorage.setItem('hbcr_bak_off','1');
  sb.D.records=recs;persist(sb);
  ok(sb.__store['hbcr_v2_bak']===undefined,'前提: 予備は無い');
  const q=[];for(let i=0;i<40;i++)q.push({action:'addRecord',data:{record:{id:'q'+i,notes:Math.random().toString(36)}}});
  const t=makeSandbox();t.savePendingQueue(q);const qLen=t.__used();
  sb.__quota=sb.__used()+Math.floor(qLen/2);                 // 本体を縮めない限り控えは入らない
  sb.savePendingQueue(q);
  ok(sb.loadPendingQueue().length===40,'送信待ちは40件すべて残る',sb.loadPendingQueue().length);
  ok(sb._keepCap()===120,'代わりにこの端末の保持日数を120日に縮めた',sb._keepCap());
  ok(sb.__disk()&&sb.__disk().records.every(r=>r.date>=ymd(-120)),'本体は縮めた日数で書き直されている');
  ok(!sb.__toasts.some(m=>/一部のみ/.test(m)),'「一部のみ保持」の知らせは出ない',sb.__toasts);
})();

/* ════════════════════════════════════════════════════════════════
   6. 容量以外の失敗は従来どおりの知らせ（上限・予備に手を付けない）
   ════════════════════════════════════════════════════════════════ */
head('6. 容量以外の失敗');
(function(){
  const sb=makeSandbox({otherErr:true});
  sb.D.records=spread(5,2);persist(sb);
  ok(sb._keepCap()===0&&sb._bakOff()===false,'保持日数も予備も触らない');
  ok(/保存エラー/.test(sb.__toasts[0]||''),'従来の保存エラーの知らせ',sb.__toasts);
})();

/* ════════════════════════════════════════════════════════════════
   7. 実装の作法
   ════════════════════════════════════════════════════════════════ */
head('7. 実装の作法');
(function(){
  ok(!/localKeepDays\)\|\|180;\s*\n\s*if\(!\(days>0\)\|\|days>=3650\)days=180/.test(X.fn('_hbKeepFrom')),'日別の照合は設定の値を直接読まない（_localKeepDays を通す）');
  ok(/_localKeepDays\(\)/.test(X.fn('pruneOldLocalRecords')),'整理も _localKeepDays を通す');
  ok(/_localKeepDays\(\)/.test(X.fn('intervalStats')),'平均の窓も _localKeepDays を通す');
  ok(/KEEP_CAP_MIN=92/.test(SRC),'下限は92日（過去3か月の平均の窓）');
  ok(/id="cdStorage"/.test(HTML)&&!/html\.hb-field #cdStorage/.test(HTML),'設定の「保存領域」は現場用の端末でも見られる（中身は出さない）');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
