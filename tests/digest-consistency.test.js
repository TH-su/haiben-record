/* ══════════════════════════════════════════════════════════════════════
   日別の照合（2026-10-07）: 端末の要約（_hbDigestLocal）と GAS の要約（digestResponse_）が
   同じデータで1日も違わないことを確かめる。片方だけ規則を変えると、毎日すべての日が「違う」と出て
   照合が全件取得より重くなる（＝改修の意味が無くなる）ので、ここで止める。
   実行:  node tests/digest-consistency.test.js
   ★実物の haiben-record.html と gas/haiben-api.gs を評価する。写経しない。合成データのみ。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeExtractor}=require('./_extract');
const {makeGasCtx, REC_HEADERS_FULL}=require('./_gas-ctx');
const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const GAS=fs.readFileSync(process.env.GAS_PATH||path.join(ROOT,'gas','haiben-api.gs'),'utf8');
const SRC=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const X=makeExtractor(SRC);

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra).slice(0,300):''))}}
function head(t){console.log('\n─── '+t+' ───')}
const DAY=86400000,pad=n=>('0'+n).slice(-2);
function ymd(t){const d=new Date(t+9*3600000);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())}

const sb={Math,String,Number,Array,Object,JSON,Date,console:{log(){},warn(){}},D:{cfg:{}}};
vm.createContext(sb);
vm.runInContext([X.varDecl('BAK_OFF_KEY'),X.fn('_keepCap'),X.fn('_localKeepDays'),X.fn('_hbIdHash32'),X.fn('_hbDigestLocal'),X.fn('_hbTsGas'),X.fn('_hbDigestDiff'),X.fn('_hbKeepFrom')].join('\n'),sb);

/* 合成の盤面と、それを getAll で受け取った端末の記録（＝端末が実際に持つ形） */
const BASE=Date.now();   // 盤面は同じ時刻から作る（作るたびに時刻がずれると「サーバーの方が新しい」に見える）
function board(){
  const sheet=[REC_HEADERS_FULL.slice()];
  const now=BASE;
  for(let i=0;i<400;i++){
    const t=now-Math.floor(i/8)*DAY-(i%8)*3600000;
    const ds=ymd(t);
    const row={id:(i%50===0)?('r'+i):(1910000000000+i),residentId:(i%4)+1,date:ds,time:'09:00',datetime:ds+'T09:00',type:'urine',staff:'検証',
      createdAt:new Date(t).toISOString(),updatedAt:(i%37===0)?'':new Date(t).toISOString()};
    sheet.push(REC_HEADERS_FULL.map(h=>row[h]===undefined?'':row[h]));
  }
  const snap=sheet[2].slice();snap[0]='sys_staffs_snapshot_v1';sheet.push(snap);   // 職員の控え
  sheet.push(sheet[9].slice());                                                    // 重複行
  return sheet;
}
const J=r=>JSON.parse(r.getContent());
function srvDigest(sheet,from){const c=makeGasCtx(GAS,sheet,{writable:true});return J(c.doPost({postData:{contents:JSON.stringify({action:'digest',from})}}))}
function srvAll(sheet){const c=makeGasCtx(GAS,sheet,{writable:true});return J(c.doPost({postData:{contents:JSON.stringify({action:'getAll'})}})).records}

head('1. 同じデータなら1日も違わない');
(function(){
  const sh=board();
  const from=ymd(Date.now()-40*DAY);
  const s=srvDigest(sh,from);
  const local=srvAll(sh);                         // 端末は getAll の応答をそのまま持つ
  const l=sb._hbDigestLocal(from,local);
  const diff=sb._hbDigestDiff(s.days,l,from);
  ok(Object.keys(s.days).length>=40,'サーバーの要約は40日以上ぶん',Object.keys(s.days).length);
  ok(diff.length===0,'端末とサーバーで違う日が0（規則が一致）',diff);
  const r2=sb._hbDigestLocal(from,local.slice().reverse());
  ok(Object.keys(l).length===Object.keys(r2).length&&Object.keys(l).every(d=>JSON.stringify(l[d])===JSON.stringify(r2[d])),'記録の並び順が違っても要約は同じ');
})();

head('1b. ISO 以外の時刻の行（手で直した行など）・時刻が空の行があっても、4つ目の要約値がそろう（2026-10-29）');
(function(){
  const sh=board();
  const ui=REC_HEADERS_FULL.indexOf('updatedAt'), ci=REC_HEADERS_FULL.indexOf('createdAt');
  sh[12][ui]='2026-05-19 10:00';         // ISO ではない文字列（GAS は 0 と読む）
  sh[13][ui]='';                          // 空＝作った時刻へ
  sh[14][ui]='';sh[14][ci]='';            // どちらも空
  sh[15][ui]=String(Date.now()-3600000);  // 数字の文字列
  const from=ymd(Date.now()-40*DAY);
  const s=srvDigest(sh,from);
  const diff=sb._hbDigestDiff(s.days,sb._hbDigestLocal(from,srvAll(sh)),from);
  ok(s.digestVer===2&&Object.values(s.days).every(e=>e.length===4),'GAS は digestVer 2 と4つの要約値を返す');
  ok(diff.length===0,'違う日が0',diff);
})();

head('2. 違いがあればその日だけ');
(function(){
  const sh=board();
  const from=ymd(Date.now()-40*DAY);
  const local=srvAll(sh);
  // 端末側だけ1件足す（未送信の記録）・1件欠ける（取りこぼし）
  const extra=Object.assign({},local[0],{id:1999999999991});
  const miss=local[100];
  const mine=local.filter(r=>r!==miss).concat([extra]);
  const diff=sb._hbDigestDiff(srvDigest(sh,from).days,sb._hbDigestLocal(from,mine),from);
  ok(diff.length===2&&diff.indexOf(extra.date)>=0&&diff.indexOf(miss.date)>=0,'手元に余分な日・手元に欠けた日だけが違うと出る',diff);
  // サーバーで直された（更新時刻が新しい）
  const ui=REC_HEADERS_FULL.indexOf('updatedAt');
  const sh2=board();sh2[30][ui]=new Date(Date.now()+60000).toISOString();
  const d2=sb._hbDigestDiff(srvDigest(sh2,from).days,sb._hbDigestLocal(from,srvAll(board())),from);
  ok(d2.length===1&&d2[0]===sh2[30][REC_HEADERS_FULL.indexOf('date')],'サーバーで直された日だけが違うと出る',d2);
  // 手元の方が新しい（未送信の編集）は違いに数えない
  const local3=srvAll(board());local3[5]=Object.assign({},local3[5],{updatedAt:new Date(Date.now()+60000).toISOString()});
  ok(sb._hbDigestDiff(srvDigest(board(),from).days,sb._hbDigestLocal(from,local3),from).length===0,'手元の方が新しい（未送信の編集）だけなら違いにしない');
  // from より前は見ない
  const old=Object.assign({},local[0],{id:1999999999992,date:ymd(Date.now()-90*DAY)});
  ok(sb._hbDigestDiff(srvDigest(board(),from).days,sb._hbDigestLocal(from,srvAll(board()).concat([old])),from).length===0,'照合の始まりより前の日は見ない');
})();

head('3. 照合の始まりの日');
(function(){
  sb.D={cfg:{localKeepDays:180}};
  const f=sb._hbKeepFrom();
  const d=new Date();d.setDate(d.getDate()-180);
  ok(f===d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),'端末に残す日数（180日）の始まりと同じ',f);
  sb.D={cfg:{localKeepDays:99999}};
  ok(/^\d{4}-\d{2}-\d{2}$/.test(sb._hbKeepFrom()),'全保持の設定でも照合は180日で区切る（要約が大きくならない）');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
