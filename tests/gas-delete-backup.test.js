/* ══════════════════════════════════════════════════════════════════════
   消す前の控え（2026-10-21・改善プロンプト第3弾の5）の検証
   実行:  node tests/gas-delete-backup.test.js
   ──────────────────────────────────────────────────────────────────────
   ★実物の GAS（gas/haiben-api.gs）を _gas-ctx.js で動かす。判定ロジックを写経しない。
   ★記録・入居者はすべて合成データ。実在の氏名・記録は使わない。
   押さえる場面:
     1. 記録の削除（delRecord）: 消す前に行の中身を DeletedRows に1行残す。端末へ返す削除の印（Deleted）は今までどおり id・時刻・日付だけ
     2. 入居者の削除（delRes）: 消す前に行の中身を残す
     3. 控えを書けない時は消さない（記録・入居者とも残る）
     4. 控えは端末へ返さない（getAll の応答に DeletedRows の中身が出ない）
     5. 控えは 2000行で古い順に間引く
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path');
const {makeGasCtx, REC_HEADERS_FULL}=require('./_gas-ctx');
const GAS=fs.readFileSync(process.env.GAS_PATH||path.join(__dirname,'..','gas','haiben-api.gs'),'utf8');
let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra).slice(0,300):''))}}
function head(t){console.log('\n─── '+t+' ───')}
function makeSheet(){
  const sheet=[REC_HEADERS_FULL.slice()];
  for(let i=0;i<5;i++){
    const row={id:1900000000000+i,residentId:1,date:'2026-10-0'+(i+1),time:'10:00',datetime:'2026-10-0'+(i+1)+'T10:00',type:'urine',
      notes:'架空メモ'+i,staff:'架空職員',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
    sheet.push(REC_HEADERS_FULL.map(h=>row[h]===undefined?'':row[h]));
  }
  return sheet;
}
const RES_H=['id','name','yomi','room','gender','active','hidden','laxNote','cfg','schedule','padSet'];
function resSheet(){return [RES_H.slice(),['R1','架空 一郎','かくう いちろう','101','男',true,false,'','','[]',''],['R2','架空 花子','かくう はなこ','102','女',true,false,'','','[]','']]}
const J=r=>JSON.parse(r.getContent());
function post(ctx,body){return J(ctx.doPost({postData:{contents:JSON.stringify(body)}}))}

head('1. 記録の削除');
(function(){
  const sh=makeSheet(), sheets={};
  const ctx=makeGasCtx(GAS,sh,{writable:true,sheets});
  const X=String(sh[3][0]);
  const r=post(ctx,{action:'delRecord',id:X});
  ok(r.ok===true,'delRecord は従来どおり ok');
  ok(!sh.slice(1).some(row=>String(row[0])===X),'記録の行は消える（従来どおり）');
  const B=ctx.__sheets.DeletedRows;
  ok(B&&B.length===2&&B[0].join()==='at,sheet,id,json','DeletedRows を作り、見出し＋1行',B&&B.slice(0,2));
  const o=B&&JSON.parse(B[1][3]);
  ok(B[1][1]==='Records'&&B[1][2]===X&&o&&o.notes==='架空メモ2'&&String(o.id)===X,'控えに消した行の中身（メモなど）を残す',B&&B[1]);
  const D=ctx.__sheets.Deleted;
  ok(D&&D[1].length===3&&D[1][0]===X,'端末へ返す削除の印は今までどおり id・時刻・日付だけ',D&&D[1]);
})();

head('2. 入居者の削除');
(function(){
  const sheets={Residents:resSheet()};
  const ctx=makeGasCtx(GAS,makeSheet(),{writable:true,sheets});
  const r=post(ctx,{action:'delRes',id:'R2'});
  ok(r.ok===true,'delRes は従来どおり ok');
  ok(!ctx.__sheets.Residents.slice(1).some(row=>row[0]==='R2'),'入居者の行は消える（従来どおり）');
  const B=ctx.__sheets.DeletedRows, o=B&&JSON.parse(B[1][3]);
  ok(B&&B[1][1]==='Residents'&&B[1][2]==='R2'&&o&&o.name==='架空 花子'&&o.room==='102','控えに消した入居者の行の中身を残す',B&&B[1]);
})();

head('3. 控えを書けない時は消さない');
(function(){
  const sh=makeSheet(), sheets={Residents:resSheet()};
  const ctx=makeGasCtx(GAS,sh,{writable:true,sheets,failCreate:n=>n==='DeletedRows'});
  const X=String(sh[2][0]), before=sh.length;
  let r; try{r=post(ctx,{action:'delRecord',id:X})}catch(e){r={threw:String(e)}}
  ok(sh.length===before&&sh.slice(1).some(row=>String(row[0])===X),'控えを書けなければ記録は消さない',r);
  try{r=post(ctx,{action:'delRes',id:'R1'})}catch(e){r={threw:String(e)}}
  ok(ctx.__sheets.Residents.slice(1).some(row=>row[0]==='R1'),'控えを書けなければ入居者は消さない',r);
})();

head('4. 控えは端末へ返さない');
(function(){
  const sh=makeSheet(), sheets={};
  const ctx=makeGasCtx(GAS,sh,{writable:true,sheets});
  post(ctx,{action:'delRecord',id:String(sh[1][0])});
  const full=post(ctx,{action:'getAll'});
  ok(!/架空メモ0/.test(JSON.stringify(full))&&!('DeletedRows' in full),'getAll の応答に控えの中身が出ない');
})();

head('5. 控えは 2000行で間引く');
(function(){
  const big=[['at','sheet','id','json']];
  for(let i=0;i<2000;i++)big.push(['t','Records','old'+i,'{}']);
  const sh=makeSheet(), sheets={DeletedRows:big};
  const ctx=makeGasCtx(GAS,sh,{writable:true,sheets});
  post(ctx,{action:'delRecord',id:String(sh[1][0])});
  const B=ctx.__sheets.DeletedRows;
  ok(B.length===2001&&B[1][2]==='old1'&&B[2000][1]==='Records'&&B[2000][2]!=='old1999','控えは見出し＋2000行を超えない（古い順に間引き、新しい控えは最後）',B&&[B.length,B[1],B[2000]]);
  ok(!B.slice(1).some(r=>r[2]==='old0'),'いちばん古い控えから消える');
})();

console.log('\n合計: '+pass+' 件成功 / '+fail+' 件失敗');
process.exit(fail?1:0);
