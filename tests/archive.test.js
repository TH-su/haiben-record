/* ══════════════════════════════════════════════════════════════════════
   古い記録を控えのシート（RecordsArchive）へ移す（2026-10-28・本人「推奨どおり」）の検証
   実行:  node tests/archive.test.js
   ──────────────────────────────────────────────────────────────────────
   ★実物の GAS（gas/haiben-api.gs）を _gas-ctx.js の偽の表で動かす。判定ロジックを写経しない。
   ★記録はすべて合成データ。実在の氏名・記録は使わない（職員名は「職員甲」型の記号）。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path');
const {makeGasCtx, REC_HEADERS_FULL}=require('./_gas-ctx');
const GAS=fs.readFileSync(process.env.HAIBEN_GAS||path.join(__dirname,'..','gas','haiben-api.gs'),'utf8');

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra).slice(0,400):''))}}
function head(t){console.log('\n─── '+t+' ───')}
const DAY=86400000, pad=n=>('0'+n).slice(-2);
function ymd(t){const d=new Date(t+9*3600000);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())}
const SNAP_ID='sys_staffs_snapshot_v1';

/* 盤面: days 日ぶん・1日 perDay 件（古い順に並ぶ）。途中に職員の一覧の控え（250日前の日付）。
   ＋後から入れた古い日付の記録を末尾に数件（行が日付の順になっていない場面） */
function makeBoard(days,perDay){
  const sheet=[REC_HEADERS_FULL.slice()];
  const now=Date.now(); let n=0;
  for(let d=days-1;d>=0;d--){
    for(let k=0;k<perDay;k++){
      const t=now-d*DAY-k*3600000-60000, ds=ymd(t);
      const o={id:'r'+(1700000000000+n),residentId:(n%38)+1,date:ds,time:'10:00',datetime:ds+'T10:00',type:'urine',staff:'職員甲',
        createdAt:new Date(t).toISOString(),updatedAt:new Date(t).toISOString()};
      sheet.push(REC_HEADERS_FULL.map(h=>o[h]===undefined?'':o[h]));n++;
    }
  }
  const st=now-250*DAY, sd=ymd(st);
  const snap={id:SNAP_ID,residentId:1,date:sd,time:'00:00',datetime:sd+'T00:00',type:'laxative',medicine:'_SYS_STAFFS_SNAPSHOT_',
    notes:'{"_mark":"__SYS_STAFFS_SNAPSHOT__","staffs":[{"n":"職員甲","a":1,"o":0}],"ts":'+st+'}',createdAt:new Date(st).toISOString(),updatedAt:new Date(st).toISOString()};
  sheet.splice(40,0,REC_HEADERS_FULL.map(h=>snap[h]===undefined?'':snap[h]));
  for(let i=0;i<4;i++){   // 後から入れた古い日付（230日前）
    const t=now-230*DAY+i*60000, ds=ymd(t), c=now-3*DAY;
    const o={id:'r_atokara'+i,residentId:2,date:ds,time:'08:00',datetime:ds+'T08:00',type:'stool',staff:'職員乙',createdAt:new Date(c).toISOString(),updatedAt:new Date(c).toISOString()};
    sheet.push(REC_HEADERS_FULL.map(h=>o[h]===undefined?'':o[h]));
  }
  return sheet;
}
function makeEnv(sheet,flags){
  const sheets={Deleted:[['id','deletedAt','date']]};
  flags=flags||{};
  const ctx=makeGasCtx(GAS,sheet,{writable:true,sheets:sheets,failDeleteRows:n=>!!(flags.failDel&&n==='Records')});
  // どのシートを読んだかを数える（区切りより後の日だけの呼び出しが控えを読まないことの確かめ）
  const V=ctx.Sheets.Spreadsheets.Values, b=V.batchGet.bind(V), g=V.get.bind(V), reads={};
  const note=rg=>{const nm=String(rg).split('!')[0];reads[nm]=(reads[nm]||0)+1};
  V.batchGet=function(id,o){(o.ranges||[]).forEach(note);return b(id,o)};
  V.get=function(id,rg,x){note(rg);return g(id,rg,x)};
  const post=body=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).getContent());
  return {ctx,sheets,post,reads,flags};
}
const idsOf=res=>(res.records||[]).map(r=>String(r.id)).sort().join(',');
const colOf=(sh,name)=>sh[0].indexOf(name);
const oldIdsIn=(grid,cut)=>grid.slice(1).filter(r=>r[0]!==''&&!/^sys_/.test(String(r[0]))&&String(r[colOf(grid,'date')])<cut).map(r=>String(r[0]));

(function main(){
head('1. 数えるだけ・移す・移した後も答えが同じ');
const sheet=makeBoard(320,6);
const E=makeEnv(sheet);
const from=ymd(Date.now()-320*DAY), cut=E.ctx.archiveCutoff_();
const D0=E.post({action:'digest',from:from});
const sampleOld=[ymd(Date.now()-300*DAY),ymd(Date.now()-230*DAY),ymd(Date.now()-201*DAY)];
const sampleNew=[ymd(Date.now()-199*DAY),ymd(Date.now()-10*DAY),ymd(Date.now())];
const G0old=E.post({action:'getDays',days:sampleOld}), G0new=E.post({action:'getDays',days:sampleNew,sys:true});
const nRows0=sheet.length;
const plan=E.ctx.archiveCount();
const expectMove=oldIdsIn(sheet,cut).length;
ok(plan.toMove===expectMove&&plan.toMove>0,'数えるだけ: 移る件数を数える（'+plan.toMove+'件・'+plan.oldest+'〜'+plan.newest+'）',plan);
ok(sheet.length===nRows0&&!E.sheets.RecordsArchive&&!E.ctx.archiveBoundary_(),'数えるだけでは何も書かない（控えのシートも区切りも作らない）');
const r=E.ctx.archiveRun_({chunk:300});
ok(r.moved===expectMove&&r.left===0&&r.chunks>=2,'移す: 全部を塊（300行）ごとに移す（'+r.moved+'件・'+r.chunks+'塊）',r);
ok(oldIdsIn(sheet,cut).length===0,'Records に区切りより前の記録が残らない');
ok(sheet.some(x=>x[0]===SNAP_ID),'職員の一覧の控え（sys_）は Records に残す');
ok(sheet.slice(1).every(x=>!x[0]||/^sys_/.test(x[0])||String(x[colOf(sheet,'date')])>=cut),'直近200日の記録は動かさない');
const A=E.sheets.RecordsArchive;
ok(A&&A.length-1===expectMove&&A[0].join()===sheet[0].join(),'控えのシートは Records と同じ見出しで、移した件数ぶんの行');
ok(E.ctx.archiveBoundary_()===cut,'区切りを今日から200日前に置く');
const D1=E.post({action:'digest',from:from});
ok(JSON.stringify(D1.days)===JSON.stringify(D0.days),'digest（保持の長い端末が頼む古い日を含む）の答えが移す前と同じ');
ok(idsOf(E.post({action:'getDays',days:sampleOld}))===idsOf(G0old),'古い日の getDays の答えが移す前と同じ（控えから読む）');
for(const k of Object.keys(E.reads))delete E.reads[k];
ok(idsOf(E.post({action:'getDays',days:sampleNew,sys:true}))===idsOf(G0new)&&!E.reads.RecordsArchive,'区切りより後の日だけの getDays は答えが同じで、控えを読まない');
for(const k of Object.keys(E.reads))delete E.reads[k];
E.post({action:'digest',from:ymd(Date.now()-180*DAY)});
ok(!E.reads.RecordsArchive,'保持180日の端末の digest は控えを読まない');
const r2=E.ctx.archiveRun_({});
ok(r2.moved===0&&E.sheets.RecordsArchive.length-1===expectMove,'もう一度実行しても何も変わらない');

head('2. 途中で止まっても、もう一度実行すれば同じ結果');
{
  const sh=makeBoard(320,6);
  const F=makeEnv(sh,{failDel:true});
  const D0b=F.post({action:'digest',from:from});
  let threw=false;try{F.ctx.archiveRun_({chunk:300})}catch(e){threw=true}
  ok(threw,'Records から消す所で止まる（写した後・消す前）');
  ok(oldIdsIn(sh,cut).length===expectMove,'止まった時は Records の記録は消えていない');
  ok(JSON.stringify(F.post({action:'digest',from:from}).days)===JSON.stringify(D0b.days),'写しと元が両方ある間も digest は同じ（同じ id を1件に数える）');
  F.flags.failDel=false;
  const r3=F.ctx.archiveRun_({chunk:300});
  const A3=F.sheets.RecordsArchive, ids3=A3.slice(1).map(x=>String(x[0]));
  ok(r3.left===0&&oldIdsIn(sh,cut).length===0,'もう一度実行すると残りを移し終える');
  ok(new Set(ids3).size===ids3.length&&ids3.length===expectMove,'控えに同じ id の行が2つできない（'+ids3.length+'行）');
  ok(JSON.stringify(F.post({action:'digest',from:from}).days)===JSON.stringify(D0b.days),'最後の digest も移す前と同じ');
}

head('3. 控えへ移した記録の直し・日付の直し・削除・後から入れた古い日付');
{
  const A=E.sheets.RecordsArchive, nRec=sheet.length, nArc=A.length;
  const tgt=A[5].slice(), idC=colOf(A,'id'), nC=colOf(A,'notes');
  const o={};A[0].forEach((h,i)=>{o[h]=tgt[i]});o.notes='直した中身';o.residentId=Number(o.residentId);
  const w=E.post({action:'saveRecord',record:o});
  ok(w.ok===true&&sheet.length===nRec&&A.length===nArc,'控えにある記録の直しは、控えの行に書く（Records に2つ目の行を作らない）');
  ok(A.some(x=>String(x[idC])===String(o.id)&&x[nC]==='直した中身'),'控えの行の中身が直る');
  const g=E.post({action:'getDays',days:[String(o.date)]});
  ok((g.records||[]).some(x=>String(x.id)===String(o.id)&&x.notes==='直した中身'),'古い日の getDays で直した中身が届く');
  // 日付を最近へ直す
  const t2=A[6].slice(), o2={};A[0].forEach((h,i)=>{o2[h]=t2[i]});o2.date=ymd(Date.now()-2*DAY);o2.datetime=o2.date+'T10:00';o2.residentId=Number(o2.residentId);
  E.post({action:'saveRecord',record:o2});
  ok(sheet.some(x=>String(x[0])===String(o2.id))&&!A.some(x=>String(x[idC])===String(o2.id)),'日付を区切りより後へ直した記録は Records へ移り、控えから外れる');
  // 削除
  const delId=String(A[7][idC]);
  E.post({action:'delRecord',id:delId});
  ok(!A.some(x=>String(x[idC])===delId)&&E.sheets.Deleted.some(x=>String(x[0])===delId),'控えにある記録を消すと、控えの行が消え、削除の印が付く');
  ok((E.post({action:'getDays',days:[ymd(Date.now()-1*DAY)]}).deleted||[]).indexOf(delId)>=0,'削除の印が端末に届く');
  // 後から入れる古い日付の新しい記録
  const nd=ymd(Date.now()-260*DAY);
  const nn={id:'r_atarashii_furui',residentId:3,date:nd,time:'07:00',datetime:nd+'T07:00',type:'urine',staff:'職員丙'};
  const nArc2=A.length;
  E.post({action:'addRecord',record:nn});
  ok(sheet.some(x=>x[0]==='r_atarashii_furui')&&A.length===nArc2,'後から入れた古い日付の新しい記録は Records に入り（次に移す時に控えへ）');
  ok((E.post({action:'getDays',days:[nd]}).records||[]).some(x=>x.id==='r_atarashii_furui'),'その日の getDays で届く（Records と控えの両方から読む）');
  const before=A.length;
  E.ctx.archiveRun_({});
  ok(!sheet.some(x=>x[0]==='r_atarashii_furui')&&A.length===before+1,'次に移す時に控えへ移る');
}

head('3の2. 反証レビューの指摘（同じ id・止まった途中の直しと削除・照らし合わせ・控えが新しい時・行のずれ）');
{
  // 同じ id の行が Records に2つ（古い日付）＝新しい方を1行だけ控えへ
  const sh=makeBoard(300,3), F=makeEnv(sh);
  const dupRow=sh.find(x=>String(x[colOf(sh,'date')])<ymd(Date.now()-260*DAY)&&!/^sys_/.test(x[0])&&x[0]).slice();
  const nC=colOf(sh,'notes'), uC=colOf(sh,'updatedAt');
  const newer=dupRow.slice();newer[nC]='新しい方';newer[uC]=new Date(Date.now()-1000).toISOString();
  sh.splice(10,0,newer);
  const r=F.ctx.archiveRun_({});
  const A=F.sheets.RecordsArchive, hits=A.filter(x=>x[0]===dupRow[0]);
  ok(r.left===0&&hits.length===1&&hits[0][nC]==='新しい方','Records に同じ id の行が2つあっても止まらず、新しい方を1行だけ控えへ',{left:r.left,hits:hits.length});
}
{
  // 写した後・消す前に止まった状態での区切り・読み取り・直し・削除
  const sh=makeBoard(320,4), F=makeEnv(sh,{failDel:true});
  try{F.ctx.archiveRun_({})}catch(e){}
  const cut2=F.ctx.archiveCutoff_();
  ok(F.ctx.archiveBoundary_()===cut2,'止まった時には区切りがもう置かれている（消す前に置く順）');
  const A=F.sheets.RecordsArchive, idC=colOf(A,'id');
  const oldDay=String(A[3][colOf(A,'date')]);
  const g=F.post({action:'getDays',days:[oldDay]}), gi=(g.records||[]).map(x=>String(x.id));
  ok(gi.length>0&&new Set(gi).size===gi.length,'両方に同じ id がある間も、getDays は1件ずつ返す');
  const t=A[3].slice(), o={};A[0].forEach((h,i)=>{o[h]=t[i]});o.notes='途中で直した';o.residentId=Number(o.residentId);
  F.post({action:'saveRecord',record:o});
  const g2=F.post({action:'getDays',days:[oldDay]});
  ok((g2.records||[]).some(x=>String(x.id)===String(o.id)&&x.notes==='途中で直した'),'止まった途中で直した記録は、getDays で直した中身が届く（Records に書く）');
  ok(!A.some(x=>String(x[idC])===String(o.id)),'その時、控えの古い写しは外す');
  const delId=String(A[4][idC]);
  F.post({action:'delRecord',id:delId});
  ok(!sh.some(x=>String(x[0])===delId)&&!A.some(x=>String(x[idC])===delId),'止まった途中で消した記録は、Records と控えの両方から消える');
  F.flags.failDel=false;F.ctx.archiveRun_({});
  ok(!A.some(x=>String(x[idC])===delId)&&!sh.some(x=>String(x[0])===delId),'もう一度移しても、消した記録は戻らない');
  ok(A.some(x=>String(x[idC])===String(o.id)&&x[colOf(A,'notes')]==='途中で直した'),'もう一度移すと、直した中身が控えへ移る');
}
{
  // 照らし合わせ: 写した後に控えの中身が違っていたら消さない
  const sh=makeBoard(300,3), F=makeEnv(sh);
  const realFlush=F.ctx.SpreadsheetApp.flush;
  let once=false;
  F.ctx.SpreadsheetApp.flush=function(){const A=F.sheets.RecordsArchive;if(!once&&A&&A.length>2){once=true;A[2][colOf(A,'notes')]='こわれた写し'}return realFlush.apply(this,arguments)};
  const before=oldIdsIn(sh,F.ctx.archiveCutoff_()).length;
  let threw=false;try{F.ctx.archiveRun_({})}catch(e){threw=/一致しません/.test(e.message)}
  ok(threw&&oldIdsIn(sh,F.ctx.archiveCutoff_()).length===before,'控えへの写しが元と違えば止まり、Records から消さない');
}
{
  // 控えの方が新しい写しを持つ時は、控えを残す
  const sh=makeBoard(300,3), F=makeEnv(sh,{failDel:true});
  try{F.ctx.archiveRun_({})}catch(e){}
  const A=F.sheets.RecordsArchive, nC=colOf(A,'notes'), uC=colOf(A,'updatedAt');
  A[2][nC]='控えが新しい';A[2][uC]=new Date(Date.now()).toISOString();
  const id=String(A[2][0]);
  F.flags.failDel=false;F.ctx.archiveRun_({});
  ok(F.sheets.RecordsArchive.some(x=>String(x[0])===id&&x[nC]==='控えが新しい')&&!sh.some(x=>String(x[0])===id),'もう一度移す時、控えの方が新しければ控えを残し、Records の古い行は消す');
}
{
  // 行のずれ: 判定の列を読んだ後・行を読む前に上の行が消えても、頼んだ日の記録を正しく返す
  const sh=makeBoard(60,4), F=makeEnv(sh);
  const day=ymd(Date.now()-5*DAY);
  const want=F.post({action:'getDays',days:[day]});
  const V=F.ctx.Sheets.Spreadsheets.Values, bg=V.batchGet;
  let n=0;
  V.batchGet=function(id,o){const isRow=(o.ranges||[]).some(rg=>/!A\d+:/.test(rg));if(isRow&&n++===0)sh.splice(2,7);return bg.call(this,id,o)};
  const got=F.post({action:'getDays',days:[day]});
  ok(got.ok===true&&idsOf(got)===idsOf(want),'getDays: 行がずれたら読み直して、頼んだ日の記録を返す',{got:idsOf(got).slice(0,80),want:idsOf(want).slice(0,80)});
  n=0;
  const since=Date.now()-3*DAY;
  const d1=F.post({action:'getAll',since:since,heal:false});
  const ok1=d1.records.every(r=>new Date(r.updatedAt).getTime()>=since);
  ok(ok1&&d1.records.length>0,'差分: 行がずれたら読み直して、基準より古い記録を混ぜない',{n:d1.records.length});
}

head('4. 全データの書き出し用の口（getArchive）');
{
  const A=E.sheets.RecordsArchive, total=A.length-1;
  const got=[];let off=0,guard=0,res;
  do{res=E.post({action:'getArchive',offset:off,limit:150});(res.records||[]).forEach(x=>got.push(String(x.id)));off+=150;guard++}while(off<res.total&&guard<100);
  ok(res.ok===true&&res.total===total&&res.archivedBefore===cut,'件数と区切りを返す（'+total+'件）');
  ok(got.length===total&&new Set(got).size===total&&got.sort().join()===A.slice(1).map(x=>String(x[0])).sort().join(),'ページを順に読むと控えの全部の行を1回ずつ受け取る');
  const big=E.post({action:'getArchive',offset:0,limit:999999});
  ok(big.records.length<=5000,'1回に返すのは5000行まで');
  const none=makeEnv(makeBoard(10,1)).post({action:'getArchive'});
  ok(none.ok===true&&none.total===0&&none.records.length===0,'控えのシートが無い時は0件を返す（作らない）');
}

head('5. 区切りが無い（まだ一度も移していない）間は今までと同じ');
{
  const sh=makeBoard(320,6), F=makeEnv(sh);
  for(const k of Object.keys(F.reads))delete F.reads[k];
  F.post({action:'digest',from:from});F.post({action:'getDays',days:sampleOld});
  ok(!F.reads.RecordsArchive&&!F.sheets.RecordsArchive,'控えのシートを読まない・作らない');
  const o={id:'r_kyou',residentId:1,date:ymd(Date.now()),time:'09:00',datetime:ymd(Date.now())+'T09:00',type:'urine',staff:'職員甲'};
  F.post({action:'addRecord',record:o});
  ok(sh.some(x=>x[0]==='r_kyou')&&!F.sheets.RecordsArchive,'書き込みも今までどおり Records だけ');
}

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
})();
