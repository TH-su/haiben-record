/* ══════════════════════════════════════════════════════════════════════
   1時間ごとの照合（_healByDigest・2026-10-29）の検証: 起動と1時間ごとの14日の窓を、日別の照合で代える
   実行:  node tests/heal-hourly.test.js
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
    X.varDecl('_syncInFlight'),X.varDecl('HEAL_INTERVAL_MS'),X.varDecl('_healOkAt'),X.fn('syncFromAPI'),
    X.varDecl('_healDigestWanted'),X.varDecl('HEAL_DAYS'),X.fn('_hbHealFrom'),X.fn('_healByDigest'),X.varDecl('HEAL_V2_KEY'),X.varDecl('_healDigestV2'),X.fn('apiGet'),
    X.varDecl('SYNC_OVERLAP_MS'),X.fn('_cursorFromResponse'),X.varDecl('LAST_SYNC_KEY'),X.fn('_getLastSyncTs'),X.fn('_setLastSyncTs'),
    X.varDecl('LAST_FULL_KEY'),X.varDecl('FULL_SYNC_INTERVAL_MS'),X.fn('_needFullSync'),
    X.varDecl('HB_DIGEST_CHUNK'),X.varDecl('_verifyBusy'),X.fn('_hbIdHash32'),X.fn('_hbKeepFrom'),X.fn('_hbDigestLocal'),X.fn('_hbTsGas'),X.fn('_hbDigestDiff'),
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

const settle=async dev=>{for(let i=0;i<200;i++){await new Promise(r=>setImmediate(r));if(!dev.sb._healDigestBusy&&!dev.sb._healDigestWanted&&!dev.sb._verifyBusy)return}};
/* 記録のある端末: 保持日数の中の記録を持ち、差分の基準は5分前・全日の照合は済み。omit に入れた id は手元に無い（取りこぼし） */
function deviceWith(srv,sheet,omit,v2){
  const from=(function(){const d=new Date();d.setDate(d.getDate()-180);return ymdLocal(d)})();
  const local=sheet.slice(1).map(rowObj).filter(o=>!/^sys_/.test(o.id)&&o.date>=from&&omit.indexOf(o.id)<0).map(o=>Object.assign({},o,{residentId:Number(o.residentId)}));
  return makeDevice(srv,{records:local,ls:{hbcr_last_sync_ts:String(Date.now()-5*60000),hbcr_datefix_heal_v1:'1',hbcr_last_full_ts:String(Date.now()),hbcr_digest_v2:(v2===false?undefined:'1')}});
}
const idsOn=(sheet,daysAgo)=>sheet.slice(1).map(rowObj).filter(o=>o.date===ymdJst(Date.now()-daysAgo*DAY)).map(o=>o.id);
const sum=(calls,f)=>calls.filter(f||(()=>true)).reduce((a,c)=>a+c.bytes,0);

(async function main(){

head('1. 起動して最初の同期: 窓なしの差分＋直近14日の照合で、取りこぼしを取り戻す');
{
  const sheet=makeBoard(200,24,250);
  const srv=makeServer(GAS,sheet);
  const miss5=idsOn(sheet,5).slice(0,2), miss40=idsOn(sheet,40).slice(0,1);
  const dev=deviceWith(srv,sheet,miss5.concat(miss40));
  const r=await dev.sb.syncFromAPI(false,{quiet:true});
  await settle(dev);
  ok(r===true,'同期が成功する');
  const ga=srv.calls.filter(c=>c.action==='getAll');
  ok(ga.length===1&&ga[0].body.since>0&&ga[0].body.heal===false,'差分は窓なし（heal:false）で1回だけ',ga.map(c=>c.body));
  ok(!srv.calls.some(c=>c.full),'全件の取得を呼ばない');
  const dg=srv.calls.filter(c=>c.action==='digest');
  ok(dg.length===1&&dg[0].body.from===dev.sb._hbHealFrom(),'直近14日の要約（digest・from='+dev.sb._hbHealFrom()+'）を1回',dg.map(c=>c.body.from));
  const gd=srv.calls.filter(c=>c.action==='getDays');
  ok(gd.length===1&&gd[0].body.days.length===1&&gd[0].body.days[0]===ymdJst(Date.now()-5*DAY),'違う日（5日前）だけを getDays で取り直す',gd.map(c=>c.body.days));
  const have=new Set(dev.sb.D.records.map(r=>String(r.id)));
  ok(miss5.every(id=>have.has(id)),'5日前の取りこぼし2件が手元に戻る');
  ok(!have.has(miss40[0]),'40日前の取りこぼしは今までの窓（14日）と同じく、ここでは取らない（1日1回の全日の照合が取る）');
  ok(dev.sb._healOkAt>0,'照合が通った時刻を残す（次の1時間は照合しない）');
  ok(dev.log.markFull===0,'全日の照合済みの印は付けない');
  const n0=srv.calls.length;
  const r2=await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const c2=srv.calls.slice(n0);
  ok(r2===true&&c2.length===1&&c2[0].action==='getAll'&&c2[0].body.heal===false,'1時間以内の次の同期は窓なしの差分1本だけ',c2.map(c=>c.action));
  dev.sb._healOkAt=Date.now()-61*60000;
  const n1=srv.calls.length;
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const c3=srv.calls.slice(n1).map(c=>c.action);
  ok(JSON.stringify(c3)===JSON.stringify(['getAll','digest']),'60分たった同期は 差分＋digest だけ（違う日が無ければ getDays なし）',c3);
}

head('2. 受け取る量: 今までの14日の窓と比べる（架空38名・1日24件）');
{
  const sheet=makeBoard(200,24,250);
  const srvA=makeServer(GAS,sheet), srvB=makeServer(GAS,sheet);
  const a=deviceWith(srvA,sheet,[]), b=deviceWith(srvB,sheet,[]);
  b.sb._healDigestOff=true;   // 今までの道（窓つき）
  await a.sb.syncFromAPI(false,{quiet:true});await settle(a);
  await b.sb.syncFromAPI(false,{quiet:true});await settle(b);
  const ba=sum(srvA.calls), bb=sum(srvB.calls);
  console.log('     今まで（窓つき）: '+bb+'B（'+srvB.calls.map(c=>c.action).join('・')+'）／直した後: '+ba+'B（'+srvA.calls.map(c=>c.action).join('・')+'）');
  ok(srvB.calls[0].body.heal===undefined,'前提: 今までの道は窓つきで頼む');
  console.log('     GAS が読んだマスの数: 今まで '+srvB.st.cells+'（読み取り '+srvB.st.sheetsCalls+'回）／直した後 '+srvA.st.cells+'（'+srvA.st.sheetsCalls+'回）');
  ok(srvA.st.cells<=srvB.st.cells*1.5,'GAS が読むマスの数が今までの1.5倍を超えない',{a:srvA.st.cells,b:srvB.st.cells});
  ok(ba<bb*0.2,'差が無い時の受け取りが今までの2割未満（'+Math.round(100-ba/bb*100)+'%減）',{ba,bb});
}

head('3. 一度 digestVer 2 を見た端末で、GAS が digest を知らない版へ戻された: 今までの窓つきに戻して受け取り直す（全件にしない）');
{
  const sheet=makeBoard(60,10,250);
  const srv=makeServer(GAS,sheet,{pre1007:true});
  const miss=idsOn(sheet,3).slice(0,1);
  const dev=deviceWith(srv,sheet,miss);
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const acts=srv.calls.map(c=>c.action+(c.action==='getAll'?(c.body.heal===false?'(窓なし)':'(窓つき)'):''));
  ok(JSON.stringify(acts)===JSON.stringify(['getAll(窓なし)','digest','getAll(窓つき)']),'窓なし→digest（知らない）→窓つきの差分',acts);
  ok(!srv.calls.some(c=>c.full),'全件の取得を呼ばない');
  ok(dev.sb._healDigestOff===true&&dev.sb._healOkAt>0,'以後は今までの窓つき・照合の時刻も残る');
  ok(new Set(dev.sb.D.records.map(r=>String(r.id))).has(miss[0]),'3日前の取りこぼしが戻る');
}

head('3b. digestVer 2 をまだ見ていない端末: 今までどおり窓つき（digest を呼ばない）');
{
  const sheet=makeBoard(30,10,250);
  const srv=makeServer(GAS,sheet,{pre1007:true});
  const dev=deviceWith(srv,sheet,[],false);
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const acts=srv.calls.map(c=>c.action+(c.body.heal===false?'(窓なし)':'(窓つき)'));
  ok(JSON.stringify(acts)===JSON.stringify(['getAll(窓つき)']),'窓つきの差分1本だけ（直す前と同じ）',acts);
  ok(dev.sb._healOkAt>0,'窓つきで受け取れた時刻を残す');
}

head('3c. 印の無い端末でも、1日1回の全日の照合で digestVer 2 を見たら、次の1時間から照合に代わる');
{
  const sheet=makeBoard(60,10,250);
  const srv=makeServer(GAS,sheet);
  const dev=deviceWith(srv,sheet,[],false);
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  ok(srv.calls.length===1&&srv.calls[0].body.heal===undefined,'最初は窓つき');
  const v=await dev.sb.verifyByDigest();
  ok(v===true&&dev.sb._healDigestV2===true&&dev.mem.hbcr_digest_v2==='1','全日の照合で GAS の印（digestVer 2）を覚える',{v,flag:dev.mem.hbcr_digest_v2});
  dev.sb._healOkAt=Date.now()-61*60000;
  const n0=srv.calls.length;
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const c=srv.calls.slice(n0).map(x=>x.action+(x.action==='getAll'?(x.body.heal===false?'(窓なし)':'(窓つき)'):''));
  ok(JSON.stringify(c)===JSON.stringify(['getAll(窓なし)','digest']),'次の1時間は 窓なしの差分＋digest',c);
}

head('4. digest が通信で失敗: すぐ今までの窓つきで受け取り直す（照合だけが壊れても修復が止まらない）');
{
  const sheet=makeBoard(30,10,250);
  const srv=makeServer(GAS,sheet);
  const dev=deviceWith(srv,sheet,[]);
  const realFetch=dev.sb.fetchTO;let fails=1;
  dev.sb.fetchTO=async(u,o)=>{if(JSON.parse(o.body).action==='digest'&&fails-->0)throw new Error('架空の通信失敗');return realFetch(u,o)};
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const acts4=srv.calls.map(c=>c.action+(c.action==='getAll'?(c.body.heal===false?'(窓なし)':'(窓つき)'):''));
  ok(JSON.stringify(acts4)===JSON.stringify(['getAll(窓なし)','getAll(窓つき)']),'窓なしの差分→（digest 失敗）→窓つきの差分',acts4);
  ok(dev.sb._healOkAt>0&&dev.sb._healDigestOff===false,'窓つきで受け取れた時刻を残し、旧 GAS 扱いにはしない');
  dev.sb._healOkAt=Date.now()-61*60000;
  ok(dev.log.toasts.length===0,'職員向けの知らせは出さない（自動の照合）',dev.log.toasts);
  const n0=srv.calls.length;
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  ok(srv.calls.slice(n0).some(c=>c.action==='digest')&&dev.sb._healOkAt>Date.now()-60000,'次の1時間の同期では照合し直して通る');
}

head('5. 🔄 更新（heal:true）は今までどおり窓つき・照合を重ねない');
{
  const sheet=makeBoard(30,10,250);
  const srv=makeServer(GAS,sheet);
  const dev=deviceWith(srv,sheet,[]);
  await dev.sb.syncFromAPI(false,{heal:true});await settle(dev);
  const acts=srv.calls.map(c=>c.action);
  ok(acts.length===1&&srv.calls[0].body.heal===undefined,'窓つきの差分1本だけ',acts);
  ok(dev.sb._healOkAt>0,'窓つきで受け取れた時刻を残す');
}

head('6. 送信待ちの直しを、照合の取り直しで巻き戻さない');
{
  const sheet=makeBoard(20,10,250);
  const srv=makeServer(GAS,sheet);
  const miss=idsOn(sheet,2).slice(0,1);
  const dev=deviceWith(srv,sheet,miss);
  const tgt=dev.sb.D.records.find(r=>r.date===ymdJst(Date.now()-2*DAY));
  const edited=Object.assign({},tgt,{notes:'送信待ちの直し',updatedAt:new Date().toISOString()});
  dev.sb.D.records[dev.sb.D.records.indexOf(tgt)]=edited;
  dev.sb._writeQ.push({action:'saveRecord',data:{record:edited}});
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  ok(srv.calls.some(c=>c.action==='getDays'),'前提: 2日前を取り直した');
  const now=dev.sb.D.records.find(r=>String(r.id)===String(tgt.id));
  ok(now&&now.notes==='送信待ちの直し','送信待ちの直しが残る',now&&now.notes);
}

head('7. 他の端末の「直し」を差分で取りこぼし、その後に同じ日の別の記録が直された: 照合で見つけて取り直す');
{
  const sheet=makeBoard(20,10,250);
  const H=REC_HEADERS_FULL, iU=H.indexOf('updatedAt'), iN=H.indexOf('notes');
  const day=ymdJst(Date.now()-1*DAY);
  const rows=sheet.slice(1).filter(r=>r[H.indexOf('date')]===day);
  const X=rows[0], Y=rows[1];
  const dev=deviceWith(makeServer(GAS,sheet),sheet,[]);   // 手元は直す前の X・Y を持つ
  X[iU]=new Date(Date.now()-20*60000).toISOString();X[iN]='他の端末の直し';   // 基準（5分前）ののりしろ（10分）より前＝差分に載らない
  Y[iU]=new Date(Date.now()-60000).toISOString();Y[iN]='後からの直し';        // 差分に載る
  const srv=makeServer(GAS,sheet);dev.sb.fetchTO=async(u,o)=>{const s=srv.post(o.body);return{ok:true,json:async()=>JSON.parse(s)}};
  /* 手元の Y は差分で届く。手元の X は古いまま＝日の件数・id・最大時刻はそろうが、4つ目の要約値がずれる */
  await dev.sb.syncFromAPI(false,{quiet:true});await settle(dev);
  const gd=srv.calls.filter(c=>c.action==='getDays');
  ok(gd.length===1&&gd[0].body.days.indexOf(day)>=0,'その日を getDays で取り直す',gd.map(c=>c.body.days));
  const x=dev.sb.D.records.find(r=>String(r.id)===String(X[0]));
  ok(x&&x.notes==='他の端末の直し','取りこぼした直しが手元に届く',x&&x.notes);
}

console.log('\n  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
