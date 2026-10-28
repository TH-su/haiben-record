/* ══════════════════════════════════════════════════════════════════════
   追いつき（syncCatchUp・2026-10-28）の検証: 「全件の取得」をやめ、短い呼び出しに分けて受け取る
   実行:  node tests/catch-up.test.js
   ──────────────────────────────────────────────────────────────────────
   ★画面の実物（syncFromAPI・verifyByDigest・syncCatchUp ほか）を切り出し、通信だけを
     実物の GAS（gas/haiben-api.gs を _gas-ctx.js で動かしたもの）へつなぐ。判定ロジックを写経しない。
   ★旧版の GAS は git の origin/main の gas/haiben-api.gs を同じ盤面で動かす（混在の時の安全網の確認）。
   ★記録はすべて合成データ。実在の氏名・記録は使わない（職員名は「職員甲」型の記号）。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm'), cp=require('child_process');
const {makeExtractor}=require('./_extract');
const {makeGasCtx, REC_HEADERS_FULL}=require('./_gas-ctx');

const ROOT=path.join(__dirname,'..');
const GAS=fs.readFileSync(process.env.HAIBEN_GAS||path.join(ROOT,'gas','haiben-api.gs'),'utf8');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();
const X=makeExtractor(SRC);
/* 旧版の GAS: 直す前（2026-10-07 の digest・getDays はあるが sys は知らない版）。
   main がこの直しを取り込んだ後は OLD_REF で直す前のコミットを指す */
let OLD=null;
try{OLD=cp.execSync('git -C '+JSON.stringify(ROOT)+' show '+(process.env.OLD_REF||'5ddb9e3')+':gas/haiben-api.gs',{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch(e){OLD=null}

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra).slice(0,400):''))}}
function head(t){console.log('\n─── '+t+' ───')}
const DAY=86400000, pad=n=>('0'+n).slice(-2);
function ymdJst(t){const d=new Date(t+9*3600000);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())}
function ymdLocal(t){const d=new Date(t);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}

/* ════════ 盤面（架空） ════════
   days 日ぶん・1日 perDay 件。updatedAt は記録の時刻。
   ＋職員の一覧の控え（id=sys_staffs_snapshot_v1）を ctlDaysAgo 日前の日付で置く（保持の180日より前＝日別の照合では届かない場所） */
const SNAP_ID='sys_staffs_snapshot_v1', SNAP_MARK='_SYS_STAFFS_SNAPSHOT_';
function makeBoard(days,perDay,ctlDaysAgo){
  const sheet=[REC_HEADERS_FULL.slice()];
  const now=Date.now(); let n=0;
  for(let d=days-1;d>=0;d--){
    for(let k=0;k<perDay;k++){
      const t=now-d*DAY-(k%20)*600000-60000;
      const ds=ymdJst(t);
      const row={id:'r'+(1700000000000+n),residentId:(n%38)+1,date:ds,time:'10:00',datetime:ds+'T10:00',type:(n%3?'urine':'stool'),
        urineAmt:'中',consistency:'普通',notes:'',staff:'職員甲',createdAt:new Date(t).toISOString(),updatedAt:new Date(t).toISOString()};
      sheet.push(REC_HEADERS_FULL.map(h=>row[h]===undefined?'':row[h]));
      n++;
    }
  }
  if(ctlDaysAgo!=null){
    const t=now-ctlDaysAgo*DAY, ds=ymdJst(t);
    const payload=JSON.stringify({_mark:'__SYS_STAFFS_SNAPSHOT__',staffs:[{n:'職員甲',a:1,o:0},{n:'職員乙',a:1,o:1},{n:'職員丙',a:0,o:2}],hosps:[],ts:t});
    const row={id:SNAP_ID,residentId:1,date:ds,time:'00:00',datetime:ds+'T00:00',type:'laxative',medicine:SNAP_MARK,notes:payload,
      createdAt:new Date(t).toISOString(),updatedAt:new Date(t).toISOString()};
    sheet.splice(1+Math.floor(sheet.length/3),0,REC_HEADERS_FULL.map(h=>row[h]===undefined?'':row[h]));   // 途中の行に置く
  }
  return sheet;
}
const rowObj=r=>{const o={};REC_HEADERS_FULL.forEach((h,i)=>{o[h]=r[i]});return o};

/* ════════ 偽の GAS（実物を vm で）＋通信の記録 ════════ */
function makeServer(src,sheet,opts){
  opts=opts||{};
  const sheets={Deleted:[['id','deletedAt','date']].concat(opts.deleted||[])};
  const ctx=makeGasCtx(src,sheet,{writable:false,sheets:sheets,residents:[{id:1,name:'入居者甲',room:'101',active:true},{id:2,name:'入居者乙',room:'102',active:true}]});
  /* Sheets の読み取り（Advanced Service）の回数と読んだマスの数を数える（GAS の時間は手元で測れないので、その代わり） */
  const V=ctx.Sheets.Spreadsheets.Values, st={sheetsCalls:0,cells:0};
  const g=V.get.bind(V), b=V.batchGet.bind(V);
  V.get=function(id,rg){st.sheetsCalls++;const r=g(id,rg);(r.values||[]).forEach(x=>{st.cells+=x.length});return r};
  V.batchGet=function(id,o){st.sheetsCalls++;const r=b(id,o);(r.valueRanges||[]).forEach(vr=>(vr.values||[]).forEach(x=>{st.cells+=x.length}));return r};
  const calls=[];
  function post(bodyStr){
    const body=JSON.parse(bodyStr);
    if(opts.pre1007&&(body.action==='digest'||body.action==='getDays')){   // 2026-10-07 より前の版＝知らない口はロックの後ろで unknown action
      const s=JSON.stringify({ok:false,error:'unknown action: '+body.action});calls.push({action:body.action,body:body,bytes:s.length,records:0});return s;
    }
    const c0=st.sheetsCalls;
    const s=ctx.doPost({postData:{contents:bodyStr}}).getContent();
    const j=JSON.parse(s);
    calls.push({action:body.action,body:body,bytes:Buffer.byteLength(s),records:(j.records||[]).length,sheetsCalls:st.sheetsCalls-c0,
      full:body.action==='getAll'&&!(body.since>0)});
    return s;
  }
  return {ctx,post,calls,st,sheets};
}

/* ════════ 画面の実物を切り出した端末 ════════ */
function makeDevice(server,init){
  init=init||{};
  const mem=Object.assign({},init.ls||{});
  const log={toasts:[],pushes:[],markFull:0,ld:[],roster:0};
  const sb={console:{log(){},warn(){},error(){}},Promise,JSON,Object,Array,String,Number,Math,Date,RegExp,isNaN,setTimeout,clearTimeout,
    window:{},
    localStorage:{getItem(k){return k in mem?mem[k]:null},setItem(k,v){mem[k]=String(v)},removeItem(k){delete mem[k]}}};
  vm.createContext(sb);
  const pieces=[
    X.varDecl('_syncInFlight'),X.varDecl('HEAL_INTERVAL_MS'),X.varDecl('_healOkAt'),X.fn('syncFromAPI'),X.fn('apiGet'),
    X.varDecl('SYNC_OVERLAP_MS'),X.fn('_cursorFromResponse'),X.varDecl('LAST_SYNC_KEY'),X.fn('_getLastSyncTs'),X.fn('_setLastSyncTs'),
    X.varDecl('LAST_FULL_KEY'),X.varDecl('FULL_SYNC_INTERVAL_MS'),X.fn('_needFullSync'),
    X.varDecl('HB_DIGEST_CHUNK'),X.varDecl('_verifyBusy'),X.fn('_hbIdHash32'),X.fn('_hbKeepFrom'),X.fn('_hbDigestLocal'),X.fn('_hbDigestDiff'),
    X.varDecl('_verifyP'),X.fn('verifyByDigest'),X.fn('_verifyByDigestRun'),
    X.varDecl('_catchUpP'),X.varDecl('_catchUpLoaderOn'),X.fn('_hbUnknownAction'),X.fn('_hbTodayYmd'),X.fn('syncCatchUp'),X.fn('_syncCatchUpRun'),
    X.varDecl('DATEFIX_HEAL_KEY'),X.varDecl('_dateHealNeeded'),
    X.fn('toNum'),X.varDecl('RECENT_DEL_MS'),X.varDecl('_recentDel'),X.fn('_recentDelHas'),
    X.varDecl('SYS_STAFF_SNAPSHOT_ID'),X.varDecl('SYS_STAFF_SNAPSHOT_MARKER'),X.fn('isUserRec'),X.fn('_findStaffSnapshot')
  ];
  vm.runInContext(pieces.join('\n'),sb);
  const delIds={};
  Object.assign(sb,{
    apiUrl:'https://script.google.com/macros/s/kakuu/exec',apiToken:'',_schedHealNeeded:false,_linkDropN:0,
    _writeQ:init.writeQ||[],_wqCurrent:null,loadPendingQueue:()=>init.pq||[],
    D:{residents:init.residents||[],records:init.records||[],cfg:{}},
    ldShow:m=>{log.ld.push('show:'+m)},ldHide:()=>{log.ld.push('hide')},apiSetStatus:()=>{},
    _markFullSync:()=>{log.markFull++;mem.hbcr_last_full_ts=String(Date.now())},
    _bumpResIdHw:()=>{},_normNameX:x=>String(x||''),
    extractStaffsFromCfg:()=>0,cleanData:()=>{},save:()=>{},saveApiUrl:()=>{},flushPendingQueue:()=>{},
    apiPush:(a,d)=>{log.pushes.push({a:a,id:d&&d.record&&d.record.id});sb._writeQ.push({action:a,data:d})},   // 本物と同じく送信の列に載せる
    _delRecHas:id=>!!delIds[String(id)],_delRecAddMany:ids=>{ids.forEach(i=>{delIds[String(i)]=1})},
    syncMasterRoster:()=>{log.roster++},
    showToast:m=>{log.toasts.push(m)},
    _localKeepDays:()=>init.keepDays||180,
    fetchTO:async(url,o)=>{const s=server.post(o.body);return{ok:true,json:async()=>JSON.parse(s)}}
  });
  // vm の中の _dateHealNeeded は localStorage を見て決まる（キーが無い＝新しい端末は true）
  return {sb,log,mem,delIds};
}
const localDigestEq=(dev,server)=>{
  const from=dev.sb._hbKeepFrom();
  const srv=JSON.parse(server.ctx.doPost({postData:{contents:JSON.stringify({action:'digest',from:from})}}).getContent());
  const diff=dev.sb._hbDigestDiff(srv.days,dev.sb._hbDigestLocal(from,dev.sb.D.records),from);
  return {diff,days:Object.keys(srv.days).length};
};

(async function main(){

/* ════════ 1. 記録0件・基準なしの端末（初回・接続先を保存した直後）＝新しい GAS ════════ */
head('1. 記録0件の端末が、全件を取らずに保持日数ぶん（180日）を全部受け取る');
{
  const sheet=makeBoard(220,12,250);
  const delRow=rowObj(sheet[sheet.length-5]);   // 消された記録（Records から消え、印だけが残る）
  sheet.splice(sheet.length-5,1);
  const srv=makeServer(GAS,sheet,{deleted:[[delRow.id,Date.now()-3600000,delRow.date]]});
  const dev=makeDevice(srv);
  ok(dev.sb._dateHealNeeded===true,'前提: 新しい端末は日付の一度きりの回復の印が無い（直す前はこれで必ず全件になっていた）');
  const p1=dev.sb.syncCatchUp(true), p2=dev.sb.syncCatchUp(true);
  ok(p1===p2,'連打しても追いつきは1つにまとまる（2回目は1回目の結果を待つ）');
  const r=await p1;
  ok(r===true,'追いつきが成功する',dev.log.toasts);
  ok(!srv.calls.some(c=>c.full),'全件の取得（since なしの getAll）を1回も呼ばない',srv.calls.map(c=>c.action));
  const eq=localDigestEq(dev,srv);
  ok(eq.diff.length===0&&eq.days>=170,'手元の日ごとの要約が、サーバーの digest と保持日数の全部の日（'+eq.days+'日）で一致する',eq.diff.slice(0,5));
  const from=dev.sb._hbKeepFrom();
  const want=sheet.slice(1).map(rowObj).filter(o=>!/^sys_/.test(o.id)&&o.date>=from).map(o=>o.id).sort();
  const got=dev.sb.D.records.filter(r=>!/^sys_/.test(String(r.id))).map(r=>String(r.id)).sort();
  ok(JSON.stringify(want)===JSON.stringify(got),'保持日数の中の記録を1件残らず受け取る（'+got.length+'件）',{want:want.length,got:got.length});
  ok(!dev.sb.D.records.some(r=>String(r.id)===delRow.id),'消された記録は手元に無い');
  ok(!!dev.delIds[delRow.id],'削除の印を控えに入れる（送り直さない）');
  const snap=dev.sb._findStaffSnapshot();
  ok(!!snap&&/職員乙/.test(snap.notes||''),'職員の一覧の控え（保持日数より前の日付）が届く');
  ok(Number(dev.mem.hbcr_last_sync_ts)>0,'差分の基準ができる（次の起動から差分で済む）');
  ok(dev.mem[dev.sb.DATEFIX_HEAL_KEY]==='1'&&dev.sb._dateHealNeeded===false,'記録の無い端末は日付の回復の印を立て、全件を強制しない');
  ok(dev.log.markFull===1,'照合済みの印を付ける（その日のうちは1日1回の照合をしない）');
  const gd=srv.calls.filter(c=>c.action==='getDays');
  const maxDays=Math.max.apply(null,gd.map(c=>c.body.days.length));
  ok(maxDays<=31,'1本で頼む日数は31日まで（'+maxDays+'日）');
  ok(gd.length<=8,'getDays の本数は 8 本まで（7日刻みなら26本・'+gd.length+'本）',gd.map(c=>c.body.days.length));
  ok(dev.log.ld[0].indexOf('show:')===0&&dev.log.ld[dev.log.ld.length-1]==='hide'&&dev.log.ld.filter(x=>x==='hide').length===1,'全画面の幕は1回出して1回だけ閉じる（途中で点滅しない）',dev.log.ld);
  ok(dev.log.roster===1,'名簿の同期は最後に1回だけ',dev.log.roster);
}

/* ════════ 2. 記録・基準のある端末の「🔄 更新」 ════════ */
head('2. 記録のある端末の「🔄 更新」: 取りこぼしを取り戻し・消された記録を外し・送信待ちを守る');
{
  const sheet=makeBoard(200,10,250);
  const srv=makeServer(GAS,sheet);
  const all=sheet.slice(1).map(rowObj);
  const from=(function(){const d=new Date();d.setDate(d.getDate()-180);return ymdLocal(d)})();
  const inKeep=all.filter(o=>!/^sys_/.test(o.id)&&o.date>=from);
  // 手元: 40日前の記録を3件取りこぼしている（差分の窓の外）・消された記録を1件持つ・送信待ちの編集が1件・サーバーに無い新しい記録が1件
  const missing=inKeep.filter(o=>{const t=Date.now()-40*DAY;return o.date===ymdJst(t)}).slice(0,3).map(o=>o.id);
  const goneId='r_kesareta';
  const local=inKeep.filter(o=>missing.indexOf(o.id)<0).map(o=>Object.assign({},o,{residentId:Number(o.residentId)}));
  const delDate=ymdJst(Date.now()-60*DAY);
  local.push({id:goneId,residentId:1,date:delDate,time:'10:00',datetime:delDate+'T10:00',type:'urine',createdAt:new Date(Date.now()-60*DAY).toISOString(),updatedAt:new Date(Date.now()-60*DAY).toISOString()});
  srv.sheets.Deleted.push([goneId,Date.now()-50*DAY,delDate]);
  const editTarget=inKeep[inKeep.length-20];
  const li=local.findIndex(o=>o.id===editTarget.id);
  local[li]=Object.assign({},local[li],{notes:'送信待ちの直し',updatedAt:new Date().toISOString()});
  const today=ymdJst(Date.now());
  const fresh={id:'r_mada_okutteinai',residentId:2,date:today,time:'11:00',datetime:today+'T11:00',type:'stool',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  local.push(fresh);
  // 送信待ちにも載っていないのにサーバーに無い今日の記録（送信待ちが消えた端末の取り残し）＝送り直しの本来の相手
  const lost={id:'r_torinokoshi',residentId:2,date:today,time:'09:00',datetime:today+'T09:00',type:'urine',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  local.push(lost);
  const dev=makeDevice(srv,{records:local,ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1',hbcr_last_full_ts:String(Date.now())},
    writeQ:[{action:'saveRecord',data:{record:local[li]}},{action:'addRecord',data:{record:fresh}}]});
  const r=await dev.sb.syncCatchUp(true);
  ok(r===true,'追いつきが成功する');
  ok(!srv.calls.some(c=>c.full),'全件の取得を呼ばない',srv.calls.map(c=>c.action+(c.body.since?'(since)':'')));
  ok(srv.calls.some(c=>c.action==='getAll'&&c.body.since>0&&c.body.heal===undefined),'差分（直近14日の窓つき）を1回取る');
  const ids=new Set(dev.sb.D.records.map(r=>String(r.id)));
  ok(missing.every(id=>ids.has(id)),'差分の窓の外で取りこぼしていた3件を取り戻す',missing);
  ok(!ids.has(goneId),'ほかの端末で消された記録を外す');
  const ed=dev.sb.D.records.find(r=>String(r.id)===editTarget.id);
  ok(ed&&ed.notes==='送信待ちの直し','送信待ちの直しはサーバーの古い版に巻き戻らない',ed&&ed.notes);
  ok(ids.has(fresh.id),'サーバーに無い送信待ちの新しい記録は消えない（和集合）');
  const pushOf=id=>dev.log.pushes.filter(x=>x.a==='addRecord'&&x.id===id).length;
  ok(pushOf(fresh.id)===0,'送信待ちに載っている記録は、取り込みの送り直しで重ねて積まない（📤未送信が長く残らない）',dev.log.pushes);
  ok(pushOf(lost.id)===1,'送信待ちに無い取り残しの記録は、1回の更新で1回だけ送り直す',dev.log.pushes);
  ok(!!dev.sb._findStaffSnapshot(),'職員の一覧の控えも届く（新しい GAS）');
  const eq=localDigestEq(dev,srv);
  ok(eq.diff.filter(d=>d!==today).length===0,'送信待ちの記録のある今日を除き、手元の要約がサーバーと一致する',eq.diff);
}

/* ════════ 3. 旧版の GAS との混在（画面を先に配って、GAS を配るまでの間） ════════ */
head('3. 旧版の GAS（sys を知らない・2026-10-07 の digest はある）');
if(!OLD){console.log('  （旧版の GAS が読めない＝飛ばす）')}else{
  {
    const sheet=makeBoard(60,5,250);
    const srv=makeServer(OLD,sheet);
    const dev=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
    const r=await dev.sb.syncCatchUp(true,{needSys:true});
    ok(r===true&&srv.calls.some(c=>c.full),'「全員を受信」は全件に戻る（安全網・今までと同じ結果）',srv.calls.map(c=>c.action));
    ok(!!dev.sb._findStaffSnapshot(),'全件で職員の一覧の控えが届く');
  }
  {
    const sheet=makeBoard(60,5,250);
    const srv=makeServer(OLD,sheet);
    const dev=makeDevice(srv,{records:[]});
    const r=await dev.sb.syncCatchUp(true);
    ok(r===true&&srv.calls.filter(c=>c.full).length===1,'記録0件の端末も全件に戻る（全件は1回だけ）',srv.calls.map(c=>c.action));
  }
  {
    const sheet=makeBoard(60,5,250);
    const srv=makeServer(OLD,sheet);
    const all=sheet.slice(1).map(rowObj).filter(o=>!/^sys_/.test(o.id));
    const local=all.slice(0,all.length-30).map(o=>Object.assign({},o,{residentId:Number(o.residentId)}));
    const dev=makeDevice(srv,{records:local,ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
    const r=await dev.sb.syncCatchUp(true);
    ok(r===true&&!srv.calls.some(c=>c.full),'「🔄 更新」は全件に戻らず照合で進める（代表者の選択 2026-10-28）',srv.calls.map(c=>c.action));
    ok(srv.calls.filter(c=>c.action==='getDays').every(c=>c.body.days.length<=7),'旧版には 7日ずつで頼む（getDaysMax を返さない版）');
    ok(localDigestEq(dev,srv).diff.length===0,'手元の要約がサーバーと一致する');
  }
}
{
  const sheet=makeBoard(30,5,250);
  const srv=makeServer(GAS,sheet,{pre1007:true});
  const dev=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
  const r=await dev.sb.syncCatchUp(true);
  ok(r===true&&srv.calls.filter(c=>c.full).length===1,'2026-10-07 より前の GAS（getDays を知らない）は全件に戻る',srv.calls.map(c=>c.action));
}
{
  const srv=makeServer(GAS,makeBoard(10,2,null));
  const dev=makeDevice(srv,{records:[]});
  dev.sb.fetchTO=async()=>{throw new Error('offline')};
  const r=await dev.sb.syncCatchUp(true);
  ok(r===false&&dev.log.ld[dev.log.ld.length-1]==='hide','通信できない時は失敗を返し、幕を閉じる（全件の待ちに入らない）',dev.log.ld);
  ok(!(Number(dev.mem.hbcr_last_sync_ts)>0),'失敗した時は差分の基準を作らない');
}
{
  // 日付の回復が残る「記録を持つ旧い端末」は、今までどおり一度だけ全件（誤日付の記録を直すため）
  const sheet=makeBoard(20,3,null);
  const srv=makeServer(GAS,sheet);
  const dev=makeDevice(srv,{records:[rowObj(sheet[1])].map(o=>Object.assign(o,{residentId:1}))});
  const r=await dev.sb.syncCatchUp(true);
  ok(r===true&&srv.calls.filter(c=>c.full).length===1,'日付の回復が残る記録のある端末だけは一度だけ全件（今までどおり）');
}

/* ════════ 3の2. 一時的な失敗・接続先の保存・重なり（反証レビューの指摘） ════════ */
head('3の2. 一時的な失敗で全件に落ちない・接続先の保存の失敗で基準を消さない・照合の重なり');
{
  const sheet=makeBoard(30,5,250);
  const srv=makeServer(GAS,sheet);
  const real=srv.post;
  srv.post=function(b){const j=JSON.parse(b);if(j.action==='getDays'){srv.calls.push({action:'getDays',body:j});return JSON.stringify({ok:false,error:'サーバーで問題が起きました'})}return real(b)};
  const dev=makeDevice(srv,{records:[]});
  const r=await dev.sb.syncCatchUp(true);
  ok(r===false&&!srv.calls.some(c=>c.full),'新しい GAS が一時的に断った時（混雑など）は全件に落ちず失敗を返す',srv.calls.map(c=>c.action));
}
{
  const sheet=makeBoard(30,5,250);
  const srv=makeServer(GAS,sheet);
  const real=srv.post;
  srv.post=function(b){const j=JSON.parse(b);if(j.action==='digest')throw new Error('タイムアウト（30秒）');return real(b)};
  const dev=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
  const r=await dev.sb.syncCatchUp(true);
  ok(r===false&&!srv.calls.some(c=>c.full),'digest が時間切れの時も全件に落ちない（照合済みにしない）',srv.calls.map(c=>c.action));
  ok(dev.log.markFull===0,'照合済みの印を付けない');
}
{
  const srv=makeServer(GAS,makeBoard(30,5,250));
  const dev=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:'123456789',hbcr_datefix_heal_v1:'1',hbcr_last_full_ts:String(Date.now())}});
  dev.sb.fetchTO=async()=>{throw new Error('offline')};
  await dev.sb.syncCatchUp(true,{reset:true});
  ok(dev.mem.hbcr_last_sync_ts==='123456789','接続先の保存の直後に通信できなくても、差分の基準を消さない（5分の追い読みを全件にしない）');
  ok(!('hbcr_last_full_ts' in dev.mem),'前の接続先の照合済みの印は外す（次の起動で新しい接続先と照合する）');
  const dev2=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:'123456789',hbcr_datefix_heal_v1:'1'}});
  const r2=await dev2.sb.syncCatchUp(true,{reset:true});
  ok(r2===true&&Number(dev2.mem.hbcr_last_sync_ts)>123456789&&!srv.calls.some(c=>c.full),'通信できれば前の接続先の基準を使わず、照合の読み始めの時刻で作り直す');
}
if(OLD){
  // 保持日数1年の端末が旧 GAS（digest は200日まで）で「🔄 更新」を2回押す
  const sheet=makeBoard(400,3,250);
  const srv=makeServer(OLD,sheet);
  const all=sheet.slice(1).map(rowObj).filter(o=>!/^sys_/.test(o.id)).map(o=>Object.assign(o,{residentId:Number(o.residentId)}));
  const dev=makeDevice(srv,{records:all,keepDays:365,ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
  await dev.sb.syncCatchUp(true);
  const n1=srv.calls.filter(c=>c.action==='getDays').length;
  ok(n1<=2,'保持日数1年の端末が旧 GAS で照合しても、200日より前の日を毎回「違う日」と数えない（getDays '+n1+'本）');
}
{
  const srv=makeServer(GAS,makeBoard(40,5,250));
  const local=makeBoard(40,5,null).slice(1).map(rowObj);
  const dev=makeDevice(srv,{records:[],ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
  const pv=dev.sb.verifyByDigest();          // 起動の裏の照合（inner なし）
  const pc=dev.sb.syncCatchUp(true);         // そこへ「🔄 更新」
  await pv;const r=await pc;
  ok(r===true&&srv.calls.filter(c=>c.action==='digest').length===2,'起動の裏の照合が進行中でも、追いつきは終わりを待って自分の照合を改めて行う');
  ok(dev.log.ld[dev.log.ld.length-1]==='hide','幕は最後に閉じる');
  const iShow=dev.log.ld.indexOf('show:サーバーから受け取っています...');
  ok(iShow>=0&&dev.log.ld.slice(iShow,-1).indexOf('hide')<0,'追いつきの幕は、進行中の照合の取得が終わっても途中で閉じない',dev.log.ld);
}
head('3の3. 画面のつなぎ（文面の確かめ）');
ok(/p=\(_getLastSyncTs\(\)>0\)\?syncFromAPI\(false,\{quiet:true\}\):syncCatchUp\(false\)/.test(SRC),'5分ごとの追い読みは、差分の基準が無い時は全件でなく追いつき');
ok(/if\(!ok&&_startupBlock\)showToast\(/.test(SRC),'記録の無い端末の起動で受け取れなかった時は知らせる');
ok(/syncCatchUp\(true,\{reset:true\}\)/.test(SRC)&&!/_setLastSyncTs\(0\);\s*syncCatchUp/.test(SRC),'接続先の保存の直後は基準を先に消さず reset の追いつき');

/* ════════ 4. GAS: sys を付けない応答は直す前と同じ ════════ */
head('4. GAS: sys を付けない getDays の応答は直す前と同じ・sys を付けた時だけ控えの行が足される');
if(OLD){
  const sheet=makeBoard(40,8,250);
  const a=makeServer(OLD,sheet.map(r=>r.slice())), b=makeServer(GAS,sheet.map(r=>r.slice()));
  const days=[0,1,2,3,4,5,6].map(i=>ymdJst(Date.now()-i*3*DAY));
  const strip=s=>s.replace(/"serverTime":\d+/,'"serverTime":0');
  const ra=strip(a.post(JSON.stringify({action:'getDays',days:days}))), rb=strip(b.post(JSON.stringify({action:'getDays',days:days})));
  ok(ra===rb,'7日（とびとびの日）を頼んだ応答が1バイトも違わない（時刻の項目を除く）',[ra.length,rb.length]);
  const rs=JSON.parse(b.post(JSON.stringify({action:'getDays',days:days,sys:true})));
  ok(rs.sysVer===1&&rs.records.some(r=>r.id===SNAP_ID),'sys:true の時は sysVer:1 と控えの行を返す');
  ok(rs.records.length===JSON.parse(rb).records.length+1,'足されるのは控えの行だけ');
  const dg=JSON.parse(b.post(JSON.stringify({action:'digest',from:ymdJst(Date.now()-180*DAY)})));
  ok(dg.getDaysMax===31&&dg.syncCursor>0&&dg.syncCursor<=dg.serverTime,'digest は getDaysMax と読み始めの時刻を宣言する');
  // まとまりが200を超える盤面（1日おきに頼む・行がとびとび）でも、全件を読まずに同じ記録の集合を返す
  const big=makeBoard(80,30,null);
  const idx=[];for(let i=1;i<big.length;i++)idx.push(i);
  // 行を混ぜて、同じ日の記録が散らばる盤面にする（後から入力した記録・直した記録が下に付く場面）
  const mixed=[big[0]].concat(idx.sort((x,y)=>((x*7919)%big.length)-((y*7919)%big.length)).map(i=>big[i]));
  const d31=Array.from({length:31},(_,i)=>ymdJst(Date.now()-i*2*DAY));
  const so=makeServer(OLD,mixed.map(r=>r.slice())), sn=makeServer(GAS,mixed.map(r=>r.slice()));
  const set=r=>JSON.parse(r).records.map(x=>x.id).sort().join();
  // 旧版は1回7日までなので、7日ずつ頼んで合わせる
  let oldIds=[];for(let i=0;i<d31.length;i+=7)oldIds=oldIds.concat(JSON.parse(so.post(JSON.stringify({action:'getDays',days:d31.slice(i,i+7)}))).records.map(x=>x.id));
  const rn=sn.post(JSON.stringify({action:'getDays',days:d31}));
  ok(oldIds.sort().join()===set(rn),'行がとびとびの盤面でも、31日分を1回で頼んだ記録の集合が直す前（7日ずつ）と同じ');
  ok(sn.calls[0].sheetsCalls===3,'Sheets の読み取りは見出し・判定の4列・行の3回だけ',sn.calls[0]);
  /* 読んだマスの数で「全件の読み取りに戻っていない」を確かめる（回数だけでは、全件の読み取りも1回で見分けがつかない・反証レビューの指摘）。
     盤面: 古い200日は日付の順・新しい62日は2つの記録の流れが2行ずつ入れ違う（同じ日の行が細かく散る）。新しい62日のうち1日おきの31日を頼む
     ＝行のまとまりが200を超える（直す前は全件の読み取りに戻っていた） */
  const old200=makeBoard(262,20,null);
  const head=[old200[0]], body=old200.slice(1);
  const cut=200*20, older=body.slice(0,cut), newer=body.slice(cut);
  const nd=[];for(let i=0;i<newer.length;i++)nd.push(newer[i]);
  // 新しい62日を「日 i の2行 → 日 i+1 の2行 → …」と入れ違えに並べ直す
  const byDay={};nd.forEach(r=>{(byDay[r[2]]=byDay[r[2]]||[]).push(r)});
  const dk=Object.keys(byDay).sort(), woven=[];
  for(let k=0;k<20;k+=2)for(let d=0;d<dk.length;d+=2){[d,d+1].forEach(x=>{if(dk[x])woven.push(byDay[dk[x]][k],byDay[dk[x]][k+1])})}
  const board=head.concat(older,woven.filter(Boolean));
  const target=dk.filter((_,i)=>i%2===0).slice(0,31);
  const so2=makeServer(OLD,board.map(r=>r.slice())), sn2=makeServer(GAS,board.map(r=>r.slice()));
  let oldIds2=[];for(let i=0;i<target.length;i+=7)oldIds2=oldIds2.concat(JSON.parse(so2.post(JSON.stringify({action:'getDays',days:target.slice(i,i+7)}))).records.map(x=>x.id));
  const before=sn2.st.cells;
  const rn2=sn2.post(JSON.stringify({action:'getDays',days:target}));
  const readCells=sn2.st.cells-before, fullCells=(board.length-1)*REC_HEADERS_FULL.length;
  ok(oldIds2.sort().join()===set(rn2),'行が細かく散る盤面でも、返す記録の集合が直す前と同じ（'+JSON.parse(rn2).records.length+'件）');
  ok(readCells<fullCells*0.5,'読んだマスの数が全件の読み取りの半分より少ない（'+readCells+'／全件 '+fullCells+'）');
  /* 散った行が2か所に分かれる盤面（入れ違いの62日をシートの途中に置き、後から入れた記録を末尾に5件足す）。
     最初の行から最後の行まで1回で読むと、間の100日も読む。すき間を倍々に広げれば2か所だけを読む */
  const late=target.slice(0,5).map((d,i)=>{const o={id:'r_atokara'+i,residentId:1,date:d,time:'10:00',datetime:d+'T10:00',type:'urine',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};return REC_HEADERS_FULL.map(h=>o[h]===undefined?'':o[h])});
  const board2=head.concat(older.slice(0,100*20),woven.filter(Boolean),older.slice(100*20),late);
  const sn3=makeServer(GAS,board2.map(r=>r.slice()));
  const b3=sn3.st.cells;
  const rn3=JSON.parse(sn3.post(JSON.stringify({action:'getDays',days:target})));
  const cells3=sn3.st.cells-b3, limit3=(board2.length-1)*4+(woven.length+400)*REC_HEADERS_FULL.length;
  ok(rn3.records.length===JSON.parse(rn2).records.length+5,'後から入れた記録も返す');
  ok(cells3<limit3,'散った行が2か所に分かれても、間の行をまとめて読まない（'+cells3+'／上限 '+limit3+'）');
}

/* ════════ 5. 架空の2万5千件で、直す前と直した後を数える ════════ */
head('5. 架空の2万5千件（220日・1日約114件）: 1本の呼び出しの量と本数');
{
  const sheet=makeBoard(220,114,250);
  const n=sheet.length-1;
  const out=[];
  if(OLD){
    const so=makeServer(OLD,sheet.map(r=>r.slice()));
    const dv=makeDevice(so,{records:[],ls:{hbcr_datefix_heal_v1:'1'}});
    // 直す前の入口は全件1本（syncFromAPI(true,{full:true})）
    await dv.sb.syncFromAPI(true,{full:true});
    const c=so.calls;
    out.push(['直す前（全件）',c.length,Math.max.apply(null,c.map(x=>x.records)),Math.max.apply(null,c.map(x=>x.bytes)),c.reduce((s,x)=>s+x.bytes,0),so.st.sheetsCalls,so.st.cells]);
  }
  const sn=makeServer(GAS,sheet.map(r=>r.slice()));
  const dn=makeDevice(sn,{records:[]});
  const t0=Date.now();
  const r=await dn.sb.syncCatchUp(true);
  const ms=Date.now()-t0;
  ok(r===true,'記録0件の端末の追いつきが成功する');
  const c=sn.calls;
  out.push(['直した後（記録0件の端末）',c.length,Math.max.apply(null,c.map(x=>x.records)),Math.max.apply(null,c.map(x=>x.bytes)),c.reduce((s,x)=>s+x.bytes,0),sn.st.sheetsCalls,sn.st.cells]);
  // 記録のある端末の「🔄 更新」（差が無い時）
  const s2=makeServer(GAS,sheet.map(r=>r.slice()));
  const local=dn.sb.D.records.slice();
  const d2=makeDevice(s2,{records:local,ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1'}});
  await d2.sb.syncCatchUp(true);
  const c2=s2.calls;
  out.push(['直した後（記録のある端末の🔄更新・差なし）',c2.length,Math.max.apply(null,c2.map(x=>x.records)),Math.max.apply(null,c2.map(x=>x.bytes)),c2.reduce((s,x)=>s+x.bytes,0),s2.st.sheetsCalls,s2.st.cells]);
  console.log('\n  記録 '+n+' 件の盤面（架空・1件は本番より大きめ）');
  console.log('  | 場面 | 本数 | 1本の最大の記録数 | 1本の最大のバイト | 合計のバイト | Sheets の読み取り回数 | 読んだマスの数 |');
  console.log('  |---|---|---|---|---|---|---|');
  out.forEach(o=>console.log('  | '+o[0]+' | '+o.slice(1).join(' | ')+' |'));
  console.log('  （直した後の記録0件の端末の本数の内訳: '+c.map(x=>x.action+(x.body.days?'×'+x.body.days.length+'日':'')).join('・')+'。手元の計算時間 '+ms+'ms）');
  const maxRec=Math.max.apply(null,c.map(x=>x.records));
  ok(maxRec<=31*114+10,'1本で受け取る記録は31日分まで（'+maxRec+'件・全件は'+n+'件）');
  ok(!c.some(x=>x.full)&&!c2.some(x=>x.full),'どちらの場面も全件を呼ばない');
  ok(Math.max.apply(null,c2.map(x=>x.records))<=15*114+10,'記録のある端末の🔄更新は、差が無ければ1本の最大が直近14日の窓（今日を含めて15日）まで');
}

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
