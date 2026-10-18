/* ══════════════════════════════════════════════════════════════════════
   保存を軽くする仕組み（2026-10-07）の検証ハーネス
   実行:  node tests/persist-worker.test.js
   ──────────────────────────────────────────────────────────────────────
   なぜ必要か: 保存1回（端末内の全記録の LZ 圧縮）に 2.7秒かかり、5分ごとの追い読みのたびに
   画面が固まっていた。①変化が無ければ書かない ②圧縮を別スレッド（Worker）へ ③離脱時はその場で書き切る、
   に変えた。ここが崩れる（書くべき時に書かない・古い内容で上書き・離脱で取りこぼす）と記録が消えるので、
   このテストで止める。

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
   localStorage・Worker・Blob・URL は偽物。保存の判断（書く／書かない／どの世代を書く）は実物で動かす。 */
function makeSandbox(opt){
  opt=opt||{};
  const store={}, writes=[];
  const posted=[];        // Worker へ送った {gen,s}
  const timers=[];
  let workerSrc=null, worker=null;
  const sb={
    console:{log(){},warn(){},error(){}},Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,Promise,RegExp,Date,
    setTimeout(f,ms){timers.push({f:f,ms:ms});return timers.length},clearTimeout(id){if(timers[id-1])timers[id-1].cancelled=true},
    localStorage:{
      getItem:k=>(k in store?store[k]:null),
      setItem:(k,v)=>{if(opt.quota&&k==='hbcr_v2'&&String(v).length>opt.quota)throw new Error('QuotaExceededError');store[k]=String(v);writes.push(k)},
      removeItem:k=>{delete store[k]}
    },
    showToast(){},
    pruneOldLocalRecords:()=>{if(!opt.prunable)return 0;sb.D.records=sb.D.records.slice(-1);return 1},
    _locked:false,_recIdx:null
  };
  if(!opt.noWorker){
    sb.Blob=function(parts){this.src=parts.join('')};
    sb.URL={createObjectURL:b=>{workerSrc=b.src;return 'blob:x'}};
    sb.Worker=function(){worker=this;this.postMessage=m=>{if(opt.postThrows)throw new Error('post');posted.push(m)};this.terminate=()=>{}};
  }
  vm.createContext(sb);
  vm.runInContext([
    X.fn('_lzFactory'),X.varDecl('LZString'),X.varDecl('COMPRESS_MAGIC'),X.fn('_storageSet'),X.fn('_storageGet'),
    'var _saveTimer=null,_saveDirty=false;var _idbMode=false,_idbMigrating=false,_storeHalt=false;',X.varDecl('_SAVE_DELAY_MS'),
    'var _pzQueuedJson=null;var _pzGen=0,_pzWrittenGen=0,_pzPending={};var _pzWorker=null,_pzWorkerBroken=false;',
    X.varDecl('PZ_WORKER_MIN'),X.varDecl('PZ_WORKER_TIMEOUT_MS'),'var _pzWatch=null;',X.fn('_pzArmWatch'),
    X.fn('_pzWorkerReady'),X.fn('_pzOnDone'),X.fn('_pzOnBroken'),X.fn('_persistWrite'),X.fn('_persistNow'),
    X.fn('_pzFlushPending'),(/function _pzSettle\(/.test(SRC)?X.fn('_pzSettle'):''),X.varDecl('BAK_OFF_KEY'),X.fn('_isQuotaErr'),X.fn('_bakOff'),X.fn('_dropBak'),X.fn('_freeLocalSpace'),X.fn('_keepCap'),X.fn('_localKeepDays'),X.varDecl('_storageWarnAt'),X.fn('_warnStorage'),X.fn('_persistFail'),X.fn('save'),X.fn('flushSave')
  ].join('\n'),sb);
  sb.D={residents:[{id:1,name:'入居者A'}],records:[],cfg:{}};
  sb.__timers=timers;
  sb.__store=store;sb.__writes=writes;sb.__posted=posted;
  sb.__worker=()=>worker;sb.__workerSrc=()=>workerSrc;
  /* Worker の返事を実物の Worker と同じ形で返す（実際に圧縮する） */
  sb.__reply=function(i,override){const m=posted[i];sb._pzOnDone({data:override||{gen:m.gen,c:sb.LZString.compressToUTF16(m.s)}})};
  sb.__disk=()=>{const v=sb._storageGet('hbcr_v2');return v==null?null:JSON.parse(v)};
  return sb;
}
function bigRecords(n,tag){const a=[];for(let i=0;i<n;i++)a.push({id:1000+i,residentId:1,date:'2026-10-0'+(1+i%7),time:'10:00',type:'urine',notes:tag||''});return a}

/* ════════════════════════════════════════════════════════════════
   1. 変化が無ければ書かない
   ════════════════════════════════════════════════════════════════ */
head('1. 変化が無ければ書かない');
(function(){
  const sb=makeSandbox({noWorker:true});
  sb.D.records=bigRecords(5);
  sb._saveDirty=true;sb._persistNow();
  const n1=sb.__writes.filter(k=>k==='hbcr_v2').length;
  ok(n1===1,'初回は書く',n1);
  sb._saveDirty=true;sb._persistNow();
  const n2=sb.__writes.filter(k=>k==='hbcr_v2').length;
  ok(n2===1,'中身が同じなら2回目は書かない（追い読みで何も変わらなかった時）',n2);
  sb.D.records.push({id:9,residentId:1,date:'2026-10-07',time:'11:00',type:'stool'});
  sb._saveDirty=true;sb._persistNow();
  const n3=sb.__writes.filter(k=>k==='hbcr_v2').length;
  ok(n3===2,'1件でも変われば書く',n3);
  ok(sb.__disk().records.length===6,'書いた中身は最新',sb.__disk().records.length);
  ok(sb.__store['hbcr_v2_bak']!==undefined,'書く前に旧版を hbcr_v2_bak へ退避する（従来どおり）');
})();

/* ════════════════════════════════════════════════════════════════
   2. 圧縮を別スレッドへ（世代の順序）
   ════════════════════════════════════════════════════════════════ */
head('2. Worker で圧縮して書く');
(function(){
  const sb=makeSandbox();
  sb.D.records=bigRecords(200,'a');
  sb._saveDirty=true;sb._persistNow();
  ok(sb.__posted.length===1,'大きいデータは Worker へ回す（画面の処理では圧縮しない）',sb.__posted.length);
  ok(sb.__writes.filter(k=>k==='hbcr_v2').length===0,'圧縮が終わるまでは書かない');
  sb.__reply(0);
  ok(sb.__writes.filter(k=>k==='hbcr_v2').length===1,'結果が届いたら書く');
  ok(sb.__store['hbcr_v2'].indexOf(sb.COMPRESS_MAGIC)===0,'圧縮形式（LZ1:）で書く＝従来と同じ形');
  ok(sb.__disk().records.length===200,'読み戻すと中身が一致する',sb.__disk().records.length);

  // 世代が入れ替わって届く
  const s2=makeSandbox();
  s2.D.records=bigRecords(200,'a');s2._saveDirty=true;s2._persistNow();       // 世代1
  s2.D.records=bigRecords(201,'b');s2._saveDirty=true;s2._persistNow();       // 世代2
  ok(s2.__posted.length===2,'続けて保存すると2つの世代を送る');
  s2.__reply(1);                                                              // 新しい方が先に届く
  ok(s2.__disk().records.length===201,'新しい世代を書く');
  s2.__reply(0);                                                              // 古い方が後から届く
  ok(s2.__disk().records.length===201,'後から届いた古い世代では上書きしない（巻き戻らない）',s2.__disk().records.length);

  // 古い方が先に届く（通常の順序）
  const s3=makeSandbox();
  s3.D.records=bigRecords(200,'a');s3._saveDirty=true;s3._persistNow();
  s3.D.records=bigRecords(202,'c');s3._saveDirty=true;s3._persistNow();
  s3.__reply(0);
  ok(s3.__disk().records.length===200,'古い世代が先に届けば、ひとまずそれを書く（何も書かないより新しい）');
  s3.__reply(1);
  ok(s3.__disk().records.length===202,'続いて新しい世代で上書きする');
})();

/* ════════════════════════════════════════════════════════════════
   3. 離脱時（flushSave）は待たずにその場で書き切る
   ════════════════════════════════════════════════════════════════ */
head('3. 離脱時の書き切り');
(function(){
  // 圧縮中にページを離れる（追加の変更なし）
  const sb=makeSandbox();
  sb.D.records=bigRecords(200,'a');sb._saveDirty=true;sb._persistNow();
  ok(sb.__writes.filter(k=>k==='hbcr_v2').length===0,'（前提）Worker の結果待ち');
  sb.flushSave();
  ok(sb.__disk()&&sb.__disk().records.length===200,'離脱時は圧縮中の世代をその場で書き切る',sb.__disk()&&sb.__disk().records.length);
  const w=sb.__writes.filter(k=>k==='hbcr_v2').length;
  ok(Object.keys(sb._pzPending).length===0,'その場で書き切ったら、用済みの圧縮待ちを片付ける');
  ok(sb.__timers.filter(t=>t.ms===sb.PZ_WORKER_TIMEOUT_MS&&!t.cancelled).length===0,
    '見張りも解く（凍結明けに「返事が無い」と誤って Worker を見限らない）');
  sb.__reply(0);
  ok(sb.__writes.filter(k=>k==='hbcr_v2').length===w,'後から届いた同じ世代の結果では書き直さない');
  ok(sb._pzWorkerBroken===false,'Worker は使い続けられる');
  sb.D.records=bigRecords(210,'e');sb._saveDirty=true;sb._persistNow();
  ok(sb.__posted.length===2,'次の大きな保存も Worker へ回る（重さが元に戻らない）',sb.__posted.length);

  // 保存待ち（300ms のタイマー中）にページを離れる
  const s2=makeSandbox();
  s2.D.records=bigRecords(200,'a');s2.save();
  ok(s2._saveDirty===true,'（前提）保存待ち');
  s2.flushSave();
  ok(s2.__disk()&&s2.__disk().records.length===200,'保存待ちの変更も、離脱時にその場で書く');
  ok(s2.__posted.length===0,'離脱時は Worker に回さない（結果を待てない）');

  // 圧縮中に新しい変更→離脱
  const s3=makeSandbox();
  s3.D.records=bigRecords(200,'a');s3._saveDirty=true;s3._persistNow();
  s3.D.records=bigRecords(205,'d');s3.save();
  s3.flushSave();
  ok(s3.__disk().records.length===205,'圧縮中に変更があれば、最新をその場で書く');
  s3.__reply(0);
  ok(s3.__disk().records.length===205,'後から届いた古い世代では上書きしない');

  ok(/window\.addEventListener\('pagehide',flushSave\)/.test(SRC)&&/visibilityState==='hidden'\)flushSave\(\)/.test(SRC),
    '離脱（pagehide・画面が隠れた時）に flushSave を呼ぶ配線は従来どおり');
})();

/* ════════════════════════════════════════════════════════════════
   4. Worker が使えない・壊れた時は従来の同期圧縮
   ════════════════════════════════════════════════════════════════ */
head('4. Worker が使えない時');
(function(){
  const sb=makeSandbox({noWorker:true});
  sb.D.records=bigRecords(200,'a');sb._saveDirty=true;sb._persistNow();
  ok(sb.__disk()&&sb.__disk().records.length===200,'Worker の無い環境ではその場で圧縮して書く（従来どおり）');

  const s2=makeSandbox({postThrows:true});
  s2.D.records=bigRecords(200,'a');s2._saveDirty=true;s2._persistNow();
  ok(s2.__disk()&&s2.__disk().records.length===200,'Worker へ送れなければその場で書く');
  ok(s2._pzWorkerBroken===true,'以後は Worker を使わない');

  const s3=makeSandbox();
  s3.D.records=bigRecords(200,'a');s3._saveDirty=true;s3._persistNow();
  s3.__worker().onerror();
  ok(s3.__disk()&&s3.__disk().records.length===200,'Worker が壊れたら、圧縮中だった世代をその場で書く');

  const s4=makeSandbox();
  s4.D.records=bigRecords(200,'a');s4._saveDirty=true;s4._persistNow();
  s4.__reply(0,{gen:s4.__posted[0].gen,err:'失敗'});
  ok(s4.__disk()&&s4.__disk().records.length===200,'Worker の圧縮が失敗したらその場で圧縮して書く');

  // 結果が返ってこない（端末で Worker が黙って止まった）
  const s6=makeSandbox();
  s6.D.records=bigRecords(200,'a');s6._saveDirty=true;s6._persistNow();
  const wt=s6.__timers.filter(t=>t.ms===s6.PZ_WORKER_TIMEOUT_MS&&!t.cancelled);
  ok(wt.length===1&&s6.PZ_WORKER_TIMEOUT_MS===20000,'Worker に送ったら20秒の見張りを掛ける');
  wt[0].f();
  ok(s6.__disk()&&s6.__disk().records.length===200,'20秒たっても結果が返らなければ、その場で圧縮して書く');
  ok(s6._pzWorkerBroken===true,'以後は Worker を使わない（従来の同期圧縮）');
  const s7=makeSandbox();
  s7.D.records=bigRecords(200,'a');s7._saveDirty=true;s7._persistNow();
  s7.__reply(0);
  ok(s7.__timers.filter(t=>t.ms===s7.PZ_WORKER_TIMEOUT_MS&&!t.cancelled).length===0,'結果が届いたら見張りを解く');

  const s5=makeSandbox();
  s5.D.records=[{id:1}];s5._saveDirty=true;s5._persistNow();
  ok(s5.__posted.length===0&&s5.__disk().records.length===1,'小さいデータは Worker に回さない（従来も圧縮しない大きさ）');
})();

/* ════════════════════════════════════════════════════════════════
   5. 書けなかった時・自動ロック中
   ════════════════════════════════════════════════════════════════ */
head('5. 失敗とロック');
(function(){
  const sb=makeSandbox({noWorker:true,quota:10});
  sb.D.records=bigRecords(50,'a');sb._saveDirty=true;sb._persistNow();
  ok(sb._saveDirty===true,'容量不足で書けなければ dirty を戻す（従来どおり）');
  ok(sb._pzQueuedJson===null,'書けなかった内容を「書いた」扱いにしない＝次の保存で必ずもう一度書こうとする');

  const s2=makeSandbox();
  s2.D.records=bigRecords(200,'a');s2._saveDirty=true;s2._persistNow();
  s2._locked=true;
  s2.__reply(0);
  ok(s2.__disk()===null,'自動ロックの後に届いた圧縮結果は書かない（消した記録を復活させない）');

  const s3=makeSandbox({noWorker:true});
  s3._locked=true;s3.D.records=bigRecords(5);s3._saveDirty=true;s3._persistNow();
  ok(s3.__disk()===null,'自動ロック中は保存しない（従来どおり）');
})();

/* ════════════════════════════════════════════════════════════════
   6. Worker の圧縮結果が画面側の圧縮と1文字も違わないこと
   ════════════════════════════════════════════════════════════════ */
head('6. Worker の中身');
(function(){
  const sb=makeSandbox();
  sb.D.records=bigRecords(300,'あいう');sb._saveDirty=true;sb._persistNow();
  const src=sb.__workerSrc();
  ok(typeof src==='string'&&src.indexOf('compressToUTF16')>=0,'Worker の中身は画面と同じ LZString（_lzFactory から作る）');
  // 実際に Worker の中身を別の砂場で動かす
  const out=[];
  const wctx={postMessage:m=>out.push(m),String,Math,Object,Array};
  vm.createContext(wctx);vm.runInContext(src,wctx);
  wctx.onmessage({data:sb.__posted[0]});
  ok(out.length===1&&out[0].gen===sb.__posted[0].gen,'Worker は世代番号を付けて返す');
  ok(out[0].c===sb.LZString.compressToUTF16(sb.__posted[0].s),'Worker の圧縮結果は画面側の圧縮と完全に同じ');
  sb._pzOnDone({data:out[0]});
  ok(sb.__disk().records.length===300&&sb.__disk().records[0].notes==='あいう','Worker の結果を書いて読み戻すと元どおり');
})();

/* ════════════════════════════════════════════════════════════════
   7. 配線
   ════════════════════════════════════════════════════════════════ */
head('7. 配線');
(function(){
  const ld=X.fn('load');
  ok(/D=JSON\.parse\(s\);_pzQueuedJson=s/.test(ld),'起動時に読んだ中身を控える（変わっていなければ最初の保存も書かない）');
  ok(/function _lzFactory\(\)/.test(SRC)&&/var LZString=_lzFactory\(\);/.test(SRC),'LZString は工場関数から作る（Worker と同じ中身）');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
