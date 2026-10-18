/* ══════════════════════════════════════════════════════════════════════
   差分同期（?since=）の取りこぼし 再現＋修正検証ハーネス（2026-09-08）
   実行:  node tests/delta-sync.test.js
   ──────────────────────────────────────────────────────────────────────
   ★実物のソース（gas/haiben-api.gs・haiben-record.html）をそのまま評価する。
     判定ロジックをテスト側に写経しない（写経すると本体を直してもテストが緑のままになる）。
   ★入居者・記録はすべて合成データ。実在の氏名・記録は一切使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeExtractor}=require('./_extract');
const {makeGasCtx}=require('./_gas-ctx');

const ROOT=path.join(__dirname,'..');
/* 既定は本体。HAIBEN_HTML / HAIBEN_GAS で差し替えられるのは変異テスト（修正を戻した写しで
   テストがちゃんと赤くなるかの確認）のため。通常運用では指定しない。 */
const GAS=fs.readFileSync(process.env.HAIBEN_GAS||path.join(ROOT,'gas','haiben-api.gs'),'utf8');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();
const X=makeExtractor(SRC);

let fail=0,pass=0;
function ok(c,m){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m)}}
function head(t){console.log('\n─── '+t+' ───')}

const MIN=60000, DAY=86400000;
const SHEETS_EPOCH=Date.UTC(1899,11,30);
function serialFromYmd(ymd){const [y,m,d]=ymd.split('-').map(Number);
  return Math.round((Date.UTC(y,m-1,d)-SHEETS_EPOCH)/DAY)}
function ymdJst(ms){const d=new Date(ms+32400000);
  return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2)}

/* ════════ 偽の Sheets / GAS 実行環境 ════════
   シートを配列で持ち、Advanced Service の Values.get / batchGet を実装する。
   これで readRecordsFast_（全件）と readRecordsWindow_（絞り込み）の【実物】を同じ盤面で走らせ、
   返す集合が一致することを機械照合できる。 */
const HEADERS=['id','residentId','date','time','type','notes','staff','createdAt','updatedAt'];
function colA1(n){let s='';while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26)}return s}

function makeSheet(rows){ return [HEADERS.slice()].concat(rows) }

/* 偽 Apps Script 環境は _gas-ctx.js に切り出した（伝播テスト propagation.test.js と共用）。
   既定は writable:false ＝ setValues/appendRow を捨てる従来の挙動。 */
function makeCtx(sheet){ return makeGasCtx(GAS, sheet) }
/* 2026-09-23 夜: doGet は読み取りを受けなくなった（POST 本文だけ）。記録の取得の中身は
   getAllResponse_（doPost の getAll と、ふさぐ前の doGet が共用していた関数）なので、それを直接呼ぶ。
   合言葉の検査は doPost 側で済むため、ここでは取得の中身（差分・自己修復窓）だけを確かめる。 */
function callDoGet(ctx,since){
  return JSON.parse(ctx.getAllResponse_(since?{since:String(since)}:{}).getContent());
}

/* ══════════════ ① 事象の再現（修正前の挙動を、修正後のコードでも確認できる形で） ══════════════ */
head('① 端末時計を since にすると「同期直前の窓」が抜ける（事象の再現）');
{
  const now=Date.now(), SKEW=5*MIN;
  // 20日前の記録（自己修復窓の外）を使う。窓の中だと修正後は必ず返るため、事象の再現にならない。
  const wroteAt=now-20*DAY;
  const sheet=makeSheet([['r1',1,serialFromYmd(ymdJst(wroteAt)),'11:30','urine','','職員S',
    new Date(wroteAt).toISOString(),new Date(wroteAt).toISOString()]]);
  const ctx=makeCtx(sheet);
  // 端末の時計が 5 分進んでいる → 書き込み直後に同期しても since が updatedAt を追い越す
  const bad=callDoGet(ctx,wroteAt+SKEW);
  ok(bad.records.length===0,'【再現】端末時計(+5分)を since にすると 11:30 の記録が返らない');
  ok(callDoGet(ctx,wroteAt+SKEW+30*MIN).records.length===0,'【再現】以後の差分同期でも二度と返らない');
  ok(callDoGet(ctx,0).records.length===1,'サーバーには在る（全件取得なら返る）');
}

head('② 読み取り所要時間の盲窓（時計が完全一致でも起きる）');
{
  const now=Date.now();
  const readAt=now-20*DAY;             // 20日前に読み取り開始（自己修復窓の外）
  const wroteAt=readAt+2000;           // その2秒後に他端末が書いた
  const gotAt=readAt+12000;            // 応答が端末に届いたのは12秒後
  const sheet=makeSheet([['r1',1,serialFromYmd(ymdJst(wroteAt)),'11:30','urine','','職員S',
    new Date(wroteAt).toISOString(),new Date(wroteAt).toISOString()]]);
  const ctx=makeCtx(sheet);
  ok(callDoGet(ctx,gotAt).records.length===0,'【再現】到達時刻を since にすると読み取り中に書かれた分が抜ける');
}

/* ══════════════ ③ 修正後のサーバー挙動 ══════════════ */
head('③ 修正後: syncCursor（読み取り開始時刻）と自己修復窓');
{
  const now=Date.now();
  const oldWrite=now-20*DAY;            // 窓の外・古い（14日より前）
  const recentWrite=now-2*DAY;         // 窓の中（RECENT_DAYS=14）
  const sheet=makeSheet([
    ['old',1,serialFromYmd(ymdJst(oldWrite)),'11:30','urine','','職員S',new Date(oldWrite).toISOString(),new Date(oldWrite).toISOString()],
    ['new',1,serialFromYmd(ymdJst(recentWrite)),'13:00','stool','','職員S',new Date(recentWrite).toISOString(),new Date(recentWrite).toISOString()]
  ]);
  const ctx=makeCtx(sheet);
  const r=callDoGet(ctx,0);
  ok(typeof r.syncCursor==='number'&&r.syncCursor>0,'syncCursor を返す');
  ok(r.syncCursor<=r.serverTime,'syncCursor は応答生成時刻(serverTime)以前＝読み取り開始時刻である');
  ok(r.recentDays===14,"自己修復窓（recentDays=14）を宣言する");

  // since を未来に飛ばしても、直近14日の記録は必ず返る＝取りこぼしが自動で埋まる
  const far=callDoGet(ctx,now+7*DAY);
  const ids=far.records.map(x=>x.id);
  ok(ids.indexOf('new')>=0,'【修正】since がどれだけ進んでいても直近14日の記録は必ず返る（自己修復）');
  ok(ids.indexOf('old')<0,'古い記録は差分どおり返さない（応答が無駄に膨らまない）');
}

/* ══════════════ ④ 絞り込み読みが全件読みと同じ集合を返すか（P1 の正しさ） ══════════════ */
head('④ 絞り込み読み(readRecordsWindow_)と全件読みの一致');
{
  const now=Date.now();
  const rows=[];
  // 300件: 日付・updatedAt の表現をわざと混ぜる（ISO文字列 / シリアル値 / 空）
  for(let i=0;i<300;i++){
    const t=now-(i*6*3600000);                 // 6時間おきに過去へ
    const ymd=ymdJst(t);
    const upd=(i%3===0)
      ? new Date(t).toISOString()                                   // ISO文字列
      : (i%3===1 ? (t-SHEETS_EPOCH)/DAY                             // シリアル値
                 : new Date(t).toISOString());
    rows.push(['r'+i,(i%5)+1,serialFromYmd(ymd),'09:00','urine','','職員S',new Date(t).toISOString(),upd]);
  }
  rows.push(['nots',1,serialFromYmd(ymdJst(now-20*DAY)),'09:00','urine','','職員S','','']);  // 時刻不明の古い行
  rows.push(['',1,serialFromYmd(ymdJst(now)),'09:00','urine','','職員S','','']);             // id 空＝捨てる行

  const since=now-4*DAY;
  const recentFrom=ymdJst(Date.now()-3*DAY);
  /* ★境界ちょうど（updatedAt === since）の行を必ず入れる。
     ここは全件読みの `ts >= since` と絞り込み読みの `ts < since は捨てる` が
     一致しているかを分ける唯一の点で、off-by-one はここにしか出ない。
     ISO文字列とシリアル値の両方の表現で置く（片方だけ丸め方が違う事故を検出するため）。 */
  rows.push(['edgeIso',1,serialFromYmd(ymdJst(since)),'09:00','urine','','職員S',
    new Date(since).toISOString(),new Date(since).toISOString()]);
  rows.push(['edgeSer',1,serialFromYmd(ymdJst(since)),'09:00','urine','','職員S',
    new Date(since).toISOString(),(since-SHEETS_EPOCH)/DAY]);
  // 境界の1ミリ秒手前（返してはいけない側）
  rows.push(['edgePrev',1,serialFromYmd(ymdJst(since-1)),'09:00','urine','','職員S',
    new Date(since-1).toISOString(),new Date(since-1).toISOString()]);

  const sheet=makeSheet(rows);
  const ctx=makeCtx(sheet);

  const win=ctx.readRecordsWindow_(since,recentFrom);
  ok(win!==null,'絞り込み読みが成立する（全件フォールバックに落ちていない）');

  // 全件読み＋doGet と同じ条件で作った期待集合
  const all=ctx.readRecords_();
  const expect=all.filter(function(r){
    if(ctx._isRecent_(r,recentFrom))return true;
    const ts=ctx.parseTs_(r.updatedAt)||ctx.parseTs_(r.tsUTC)||ctx.parseTs_(r.createdAt);
    if(!ts)return true;
    return ts>=since;
  }).map(r=>String(r.id)).sort();
  const got=(win||[]).map(r=>String(r.id)).sort();
  ok(JSON.stringify(got)===JSON.stringify(expect),
     '【一致】絞り込み読みの集合が全件読みの集合と完全一致（'+got.length+'件）');
  ok(got.indexOf('nots')>=0,'時刻が取れない行は取りこぼさず必ず返す（全件読み側と同じ扱い）');
  ok(got.indexOf('edgeIso')>=0,'【境界】updatedAt が since ちょうど（ISO文字列）の行を返す');
  /* シリアル値（浮動小数の日数）からの復元には 1ミリ秒未満の丸めが出るため、境界ちょうどの行は
     返る側にも返らない側にも倒れうる。守るべき性質は「絞り込み読みと全件読みが同じ判断をすること」
     なので、membership ではなく両者の一致で確認する（絶対値で書くとテストがたまに落ちる）。
     実運用ではカーソルに のりしろ10分 を引いているため、1ミリ秒の差は結果に影響しない。 */
  ok((got.indexOf('edgeSer')>=0)===(expect.indexOf('edgeSer')>=0),
     '【境界】updatedAt が since ちょうど（シリアル値）でも絞り込み読みと全件読みの判断が一致する');
  ok(got.indexOf('edgePrev')<0,'【境界】since の1ミリ秒前の行は返さない');
  ok(got.indexOf('')<0,'id が空の行は返さない');
  ok(got.length<all.length,'返す件数は全件より少ない＝転送量が減っている');

  // 列の中身も全件読みと一致するか（1件を突き合わせ）
  const oneW=(win||[]).find(r=>String(r.id)==='r0');
  const oneA=all.find(r=>String(r.id)==='r0');
  ok(oneW&&oneA&&JSON.stringify(oneW)===JSON.stringify(oneA),'各セルの値も全件読みと同一');
}

head('⑤ 絞り込みが使えない場面では必ず全件読みへ落ちる');
{
  const now=Date.now();
  // 全行が対象になる（40%超）→ null を返し、呼び出し側が全件読みを使う
  const rows=[];
  for(let i=0;i<20;i++){
    const t=now-i*3600000;
    rows.push(['r'+i,1,serialFromYmd(ymdJst(t)),'09:00','urine','','職員S',new Date(t).toISOString(),new Date(t).toISOString()]);
  }
  const ctx=makeCtx(makeSheet(rows));
  ok(ctx.readRecordsWindow_(now-30*DAY,ymdJst(now-3*DAY))===null,'ほぼ全行が対象なら null（全件読みに任せる）');
  ok(ctx.readRecordsWindow_(0,ymdJst(now-3*DAY))===null,'since=0（全件要求）なら null');
  // id 列が無いシート
  const broken=[['residentId','date'],[1,serialFromYmd(ymdJst(now))]];
  const ctx2=makeCtx(broken);
  ok(ctx2.readRecordsWindow_(now-DAY,ymdJst(now-3*DAY))===null,'判定列が無ければ null（推測で返さない）');
  // doGet が例外で止まらないこと
  const r=callDoGet(makeCtx(makeSheet(rows)),now-30*DAY);
  ok(r.ok===true&&Array.isArray(r.records),'全件フォールバック経路でも doGet は正常に応答する');
}

/* ══════════════ ⑥ クライアント: 基準時刻の作り方 ══════════════ */
head('⑥ クライアント: _cursorFromResponse（端末時計を使わない）');
{
  const sb={};
  vm.createContext(sb);
  vm.runInContext(X.varDecl('SYNC_OVERLAP_MS')+'\n'+X.fn('_cursorFromResponse'),sb);
  const OV=sb.SYNC_OVERLAP_MS;
  ok(OV===10*MIN,'のりしろは10分');
  ok(sb._cursorFromResponse({syncCursor:1000*MIN,serverTime:2000*MIN})===1000*MIN-OV,
     'syncCursor があればそれを使う（serverTime より優先）');
  ok(sb._cursorFromResponse({serverTime:2000*MIN})===2000*MIN-OV,
     '旧GAS（syncCursor なし）では serverTime にフォールバック＝HTML単独でも時計ズレが直る');
  ok(sb._cursorFromResponse({})===0,'時刻を返さないサーバーでは 0＝次回は全件取得にする');
  ok(sb._cursorFromResponse(null)===0,'応答が無い場合も 0');
  ok(!/Date\.now\(\)/.test(X.fn('_cursorFromResponse')),'【本丸】端末時計(Date.now)を一切使っていない');
  ok(/_setLastSyncTs\(_cursorFromResponse\(json\)\)/.test(SRC),
     '【本丸】同期の末尾でサーバー由来の基準を保存している');
  ok(!/_setLastSyncTs\(Date\.now\(\)\)/.test(SRC),'端末時計を基準にする旧コードが残っていない');
}

head('⑦ クライアント: 全件取得（復旧経路）が実際に呼ばれるか');
{
  const callers=SRC.match(/syncFromAPI\([^)]*\)/g)||[];
  const withFull=callers.filter(c=>/full/.test(c));
  ok(withFull.length>=4,'opts.full を渡す呼び出しが '+withFull.length+' 箇所ある（修正前は 0）');
  ok(/showToast\('🔄 サーバーから更新中\.\.\.'\);\s*\/\*[\s\S]*?\*\/\s*syncFromAPI\(true,\{full:true\}\)/.test(SRC),
     '【本丸】「🔄更新」が全件取得になった');
  ok(/const ok=await syncFromAPI\(true,\{full:true\}\)/.test(SRC),'設定画面の「同期」も全件取得');
  if(/function verifyByDigest\(/.test(SRC)){
    /* 2026-10-07: 1日1回の照合は、手元に記録と基準がある端末では日別の照合（verifyByDigest）。無い端末は従来どおり全件 */
    ok(/var _wantVerify=_needFullSync\(\);/.test(SRC)&&/syncFromAPI\(_startupBlock,\{full:_wantVerify&&!_byDigest\}\)/.test(SRC)&&/if\(ok&&_byDigest\)\{\s*verifyByDigest\(\)/.test(SRC),
      '起動時は 1日1回だけ照合（記録と基準がある端末は日別の照合・無い端末は全件。それ以外は差分）');
  }else{
    ok(/syncFromAPI\((?:true|_startupBlock),\{full:_needFullSync\(\)\}\)/.test(SRC),'起動時は 1日1回だけ全件（それ以外は差分）');
  }
  if(/_startupBlock/.test(SRC))ok(/var _startupBlock=!\(D&&Array\.isArray\(D\.records\)&&D\.records\.length>0\);/.test(SRC),'起動時の全画面の「取得中」は、端末に記録が無い時だけ（2026-10-07）');
  const nf={};vm.createContext(nf);
  nf.localStorage={_m:{},getItem(k){return k in this._m?this._m[k]:null},setItem(k,v){this._m[k]=String(v)},removeItem(k){delete this._m[k]}};
  vm.runInContext([X.varDecl('LAST_SYNC_KEY'),X.fn('_getLastSyncTs'),X.varDecl('LAST_FULL_KEY'),
    X.varDecl('FULL_SYNC_INTERVAL_MS'),X.fn('_needFullSync'),X.fn('_markFullSync')].join('\n'),nf);
  ok(nf._needFullSync()===true,'基準が無い端末（初回・消去直後）は全件');
  nf.localStorage.setItem('hbcr_last_sync_ts','1');
  ok(nf._needFullSync()===true,'全件の実績が無ければ全件');
  nf._markFullSync();
  ok(nf._needFullSync()===false,'全件直後は差分でよい');
  nf.localStorage.setItem('hbcr_last_full_ts',String(Date.now()-25*3600000));
  ok(nf._needFullSync()===true,'24時間を超えたら再び全件で照合する');
}

/* ══════════════ ⑧ クライアント: 送信キューの永続化 ══════════════ */
head('⑧ クライアント: 送信待ち・送信中の永続化と回収');
{
  const c={};vm.createContext(c);
  const store={};
  c.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
  c._storageSet=(k,v)=>{store[k]=String(v)};
  c._storageGet=k=>(k in store?store[k]:null);
  c._writeQ=[];c.console={log(){},warn(){}};c.Date=Date;c.JSON=JSON;c.Array=Array;c.String=String;c.Number=Number;
  vm.runInContext([X.varDecl('PQ_KEY'),X.varDecl('WQ_KEY'),X.varDecl('_wqCurrent'),
    X.fn('_wqPersist'),X.fn('loadPendingQueue'),X.fn('savePendingQueue'),X.fn('enqueuePending'),
    X.fn('recoverWriteQueue'),X.varDecl('_pqCount')].join('\n'),c);
  c._writeQ.push({action:'addRecord',data:{record:{id:'a1'}}});
  c._writeQ.push({action:'addRecord',data:{record:{id:'a2'}}});
  c._wqPersist();
  ok(store['hbcr_wq']!==undefined,'送信待ちが localStorage に写される');
  // 送信中の1件を取り出した状態（_writeDrain 相当）
  c._wqCurrent=c._writeQ.shift();c._wqPersist();
  const live=JSON.parse(c._storageGet('hbcr_wq'));
  ok(live.length===2&&live[0].data.record.id==='a1','送信中の1件も写しに残る（取りこぼさない）');
  // ここでタブが破棄されたとみなし、次回起動の回収を実行
  c._writeQ=[];c._wqCurrent=null;
  const n=c.recoverWriteQueue();
  ok(n===2,'起動時に 2 件を回収する');
  ok(c._storageGet('hbcr_wq')===null,'回収後に写しを消す');
  const pq=c.loadPendingQueue();
  ok(pq.length===2&&pq[0].action==='addRecord','回収分が再送行列(hbcr_pq)に入る＝次の同期で送られる');
  ok(/_wqPersist\(\);\s*\/\/ ★送る前に永続化/.test(SRC),'apiPush は「送る前に」永続化している');
}

head('⑨ クライアント: 削除済みidの控え（Dの暴走防止）');
{
  const c={};vm.createContext(c);
  const store={};
  c.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
  c.JSON=JSON;c.String=String;c.Array=Array;
  vm.runInContext([X.varDecl('DELREC_KEY'),X.fn('_delRecLoad'),X.fn('_delRecAdd'),X.fn('_delRecHas')].join('\n'),c);
  c._delRecAdd('x1');c._delRecAdd('x1');c._delRecAdd('x2');
  ok(c._delRecLoad().length===2,'同じidは二重に控えない');
  ok(c._delRecHas('x1')&&!c._delRecHas('x9'),'控えの有無を判定できる');
  for(let i=0;i<3100;i++)c._delRecAdd('z'+i);
  ok(c._delRecLoad().length===3000,'上限3000件で古い順に切り捨てる');
  ok(/if\(action==='delRecord'&&data&&data\.id!=null\)_delRecAdd\(data\.id\)/.test(SRC),
     '削除送信のたびに控えへ積む');
  ok(/if\(_delRecHas\(r\.id\)\)return;/.test(SRC),'送り直しの対象から削除済みidを除外している');
  ok(/if\(_srvIds\[String\(r\.id\)\]\)return;/.test(SRC),'サーバーに在る記録は送り直さない＝上書きしない');
  ok(/if\(_fullFetch\)\{[\s\S]{0,400}?_srvIds/.test(SRC),'送り直しは全件取得のときだけ（サーバーの全idを持つ時のみ）');
}

head('⑩ 自動ロックの消去判定（未送信が残る間は消さない）');
{
  ok(/var wq=_storageGet\(WQ_KEY\);if\(wq&&wq!=='\[\]'\)return false/.test(SRC),
     '永続側に送信待ちが残っていれば端末データを消さない');
  ok(/LAST_SYNC_KEY,LAST_FULL_KEY,WQ_KEY,LINK_BAK_KEY/.test(SRC),
     '消去時は全件照合の実績(LAST_FULL_KEY)も一緒に消す＝差分だけで埋めようとしない');
  // コメントを除いた「実際に消すキーの配列」だけを見る（説明文の言及に引っかからないように）
  const wipe=X.fn('autoLockWipe');
  const wipeCode=wipe.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  const arr=/\[([^\]]*)\]\s*\n?\s*\.forEach/.exec(wipeCode);
  ok(!!arr,'消去対象のキー配列を特定できる');
  ok(arr&&!/DELREC_KEY/.test(arr[1]),'削除済みidの控えは消さない（消すと削除済み記録を送り直してしまう）');
  ok(/WQ_KEY/.test(wipe)&&/LAST_FULL_KEY/.test(wipe),'消去対象に WQ_KEY と LAST_FULL_KEY が入っている');
}

head('⑪ 未送信の編集・削除がサーバー版に負けないか（自己修復窓の副作用対策）');
{
  ok(/var _unsentEdit=\{\}, _unsentDel=\{\}, _localAll=\{\};/.test(SRC),
     '未送信の編集id・削除idを集める');
  ok(/it\.action==='addRecord'\|\|it\.action==='saveRecord'/.test(SRC)&&/it\.action==='delRecord'/.test(SRC),
     '送信キューの中身を action で振り分けている');
  ok(/scan\(_writeQ\)/.test(SRC)&&/scan\(\[_wqCurrent\]\)/.test(SRC)&&/scan\(loadPendingQueue\(\)\)/.test(SRC),
     '送信待ち・送信中・再送行列の3つすべてを見る（片方だけだと取りこぼす）');
  ok(/if\(_unsentDel\[String\(r\.id\)\]\)\{seenRecId\[r\.id\]=true;return;\}/.test(SRC),
     '送信待ちの削除がある記録はサーバー版を戻さない（消したものが生き返らない）');
  ok(/if\(_unsentEdit\[String\(r\.id\)\]\)\{[\s\S]{0,120}?r=_lu;/.test(SRC),
     '送信待ちの編集がある記録はローカル版を採る');
  // 時計に依存していないこと（updatedAt の大小で判定していない）
  const blk=/var _unsentEdit[\s\S]*?apiRec\.forEach/.exec(SRC)[0];
  ok(!/updatedAt|_recTs|Date\.now/.test(blk),
     '【本丸】判定に時刻を一切使っていない＝端末時計のズレに引きずられない');
}

console.log('\n結果: '+pass+' 件成功 / '+fail+' 件失敗');
process.exit(fail?1:0);
