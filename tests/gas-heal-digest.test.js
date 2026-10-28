/* ══════════════════════════════════════════════════════════════════════
   GAS 第2段（2026-10-07）の検証: heal（自己修復窓を省く）・削除の印・digest／getDays
   実行:  node tests/gas-heal-digest.test.js
   ──────────────────────────────────────────────────────────────────────
   ★実物の GAS（gas/haiben-api.gs）を _gas-ctx.js で動かす。判定ロジックを写経しない。
   ★旧版との比較は git の origin/main の gas/haiben-api.gs を同じ盤面で動かして行う。
   ★記録はすべて合成データ。実在の氏名・記録は使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), cp=require('child_process');
const {makeGasCtx, REC_HEADERS_FULL}=require('./_gas-ctx');
const ROOT=path.join(__dirname,'..');
const GAS_PATH=process.env.GAS_PATH||path.join(ROOT,'gas','haiben-api.gs');
const GAS=fs.readFileSync(GAS_PATH,'utf8');
let OLD=null;
try{OLD=cp.execSync('git -C '+JSON.stringify(path.dirname(GAS_PATH))+' show '+(process.env.OLD_REF||'origin/main')+':gas/haiben-api.gs',{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch(e){OLD=null}

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra).slice(0,300):''))}}
function head(t){console.log('\n─── '+t+' ───')}
const DAY=86400000, pad=n=>('0'+n).slice(-2);
function ymd(t){const d=new Date(t+9*3600000);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())}

/* 盤面: 30日ぶん・1日10件。updatedAt は記録の時刻（=古い記録は古い） */
function makeSheet(){
  const sheet=[REC_HEADERS_FULL.slice()];
  const now=Date.now();
  for(let i=0;i<300;i++){
    const t=now-Math.floor(i/10)*DAY-(i%10)*3600000-60000;
    const ds=ymd(t);
    const row={id:1900000000000+i,residentId:(i%3)+1,date:ds,time:'10:00',datetime:ds+'T10:00',type:'urine',staff:'検証',
      createdAt:new Date(t).toISOString(),updatedAt:new Date(t).toISOString()};
    sheet.push(REC_HEADERS_FULL.map(h=>row[h]===undefined?'':row[h]));
  }
  return sheet;
}
function ctxOf(src,sheet,sheets){return makeGasCtx(src,sheet,{writable:true,sheets:sheets||{}})}
const J=r=>JSON.parse(r.getContent());
function post(ctx,body){return J(ctx.doPost({postData:{contents:JSON.stringify(body)}}))}
const ids=res=>(res.records||[]).map(r=>String(r.id)).sort();

/* ════════ 1. heal を付けない（旧版の端末）＝従来と同じ応答 ════════ */
head('1. 旧版の端末には従来と同じ応答');
(function(){
  if(!OLD){console.log('  （旧版の GAS が読めない＝比較を飛ばす）');return}
  const sh=makeSheet();
  const since=Date.now()-2*DAY;
  for(const s of [0,since]){
    const a=post(ctxOf(OLD,sh.map(r=>r.slice())),{action:'getAll',since:s||undefined});
    const b=post(ctxOf(GAS,sh.map(r=>r.slice())),{action:'getAll',since:s||undefined});
    const strip=o=>{const c=Object.assign({},o);delete c.syncCursor;delete c.serverTime;delete c.heal;delete c.deleted;delete c.padSetVer;return JSON.stringify(c)};
    ok(strip(a)===strip(b),(s?'差分':'全件')+': 追加した heal・deleted・padSetVer の他は旧版と1文字も同じ',{a:a.records&&a.records.length,b:b.records&&b.records.length});
    ok(b.heal===true&&Array.isArray(b.deleted),(s?'差分':'全件')+': heal=true・deleted=[] を添える（旧版の端末は見ない）');
  }
})();

/* ════════ 2. heal:false ＝自己修復窓を省く ════════ */
head('2. heal:false は変わった記録だけ');
(function(){
  const sh=makeSheet();
  const ctx=ctxOf(GAS,sh);
  const since=Date.now()-2*DAY;
  const withHeal=post(ctx,{action:'getAll',since:since});
  const noHeal=post(ctx,{action:'getAll',since:since,heal:false});
  ok(withHeal.records.length>=140,'heal あり（従来）は直近14日ぶんを返す',withHeal.records.length);
  const expect=sh.slice(1).filter(r=>Date.parse(r[REC_HEADERS_FULL.indexOf('updatedAt')])>=since).length;
  ok(noHeal.records.length===expect&&noHeal.heal===false,'heal:false は since 以降に変わった記録だけ（窓を省く）',{got:noHeal.records.length,expect});
  ok(noHeal.delta===true&&typeof noHeal.syncCursor==='number','差分応答の形と基準時刻は従来どおり');
  // 古い記録を1件だけ直す → それだけが返る
  const ui=REC_HEADERS_FULL.indexOf('updatedAt');
  sh[250][ui]=new Date().toISOString();
  const r2=post(ctx,{action:'getAll',since:Date.now()-60000,heal:false});
  ok(r2.records.length===1&&String(r2.records[0].id)===String(sh[250][0]),'25日前の記録を直すと、その1件だけが返る',ids(r2));
  ok(r2.records[0].date===sh[250][REC_HEADERS_FULL.indexOf('date')],'日付は従来どおり JST の yyyy-MM-dd',r2.records[0].date);
})();

/* ════════ 3. 削除の印 ════════ */
head('3. 削除の印');
(function(){
  const sh=makeSheet(); const sheets={};
  const ctx=ctxOf(GAS,sh,sheets);
  const X=String(sh[5][0]), Xdate=sh[5][REC_HEADERS_FULL.indexOf('date')];
  const t0=Date.now();
  const r=post(ctx,{action:'delRecord',id:X});
  ok(r.ok===true,'delRecord は従来どおり ok');
  ok(!sh.slice(1).some(row=>String(row[0])===X),'記録の行は消える（従来どおり）');
  const D=ctx.__sheets.Deleted;
  ok(D&&D.length===2&&D[0].join()==='id,deletedAt,date','Deleted シートを作り、見出し＋1行',D&&D.slice(0,2));
  ok(D[1][0]===X&&D[1][1]>=t0&&D[1][2]===Xdate,'印は id・削除時刻・記録の日付だけ（氏名・中身は入れない）',D[1]);
  const d1=post(ctx,{action:'getAll',since:t0-1000,heal:false});
  ok(d1.deleted.indexOf(X)>=0,'削除の後の差分で deleted に入る',d1.deleted);
  const d2=post(ctx,{action:'getAll',since:Date.now()+1000,heal:false});
  ok(d2.deleted.length===0,'削除より後を基準にした差分には入らない');
  const full=post(ctx,{action:'getAll'});
  ok(full.deleted.indexOf(X)>=0,'全件取得には保持している印をすべて付ける');
  // 行が無い id を消しても印は残す
  post(ctx,{action:'delRecord',id:'1999999999999'});
  ok(ctx.__sheets.Deleted.length===3&&ctx.__sheets.Deleted[2][2]==='','サーバーに無い記録を消しても印は残す（他の端末の写しを送り直させない）');
  // 間引き
  const big={Deleted:[['id','deletedAt','date']]};
  const old=Date.now()-100*DAY;
  for(let i=0;i<ctx.DEL_TRIM_AT+5;i++)big.Deleted.push(['old'+i,old+i,'']);
  const c2=ctxOf(GAS,makeSheet(),big);
  post(c2,{action:'delRecord',id:'zz1'});
  ok(c2.__sheets.Deleted.length===2&&c2.__sheets.Deleted[1][0]==='zz1','印が上限を超えたら90日より古いものを間引く',c2.__sheets.Deleted.length);
  // 削除の後に同じ id が書かれた（別の端末の編集が勝った）→ 印を外す
  const sh4=makeSheet();const c5=ctxOf(GAS,sh4);
  const Yid=String(sh4[7][0]);
  post(c5,{action:'delRecord',id:Yid});
  ok(post(c5,{action:'getAll'}).deleted.indexOf(Yid)>=0,'（前提）削除の印がある');
  const rec={};REC_HEADERS_FULL.forEach((h,i)=>{rec[h]=sh4[1][i]});rec.id=Yid;rec.notes='編集が勝った';
  post(c5,{action:'saveRecord',record:rec});
  const after=post(c5,{action:'getAll'});
  ok(after.deleted.indexOf(Yid)<0&&after.records.some(r=>String(r.id)===Yid),'削除の後に同じ記録が書かれたら印を外す（作り直された記録が他の端末で消され続けない）');
  // Deleted シートが無いサーバー
  const c3=ctxOf(GAS,makeSheet());
  ok(post(c3,{action:'getAll'}).deleted.length===0,'削除の印がまだ無いサーバーでは deleted は空');
})();

/* ════════ 4. digest ════════ */
head('4. digest');
(function(){
  const sh=makeSheet();
  // 重複行（同じ日・同じ id）と職員の控え（sys_）を混ぜる
  sh.push(sh[3].slice());
  const snap=sh[4].slice(); snap[0]='sys_staffs_snapshot_v1'; sh.push(snap);
  const ctx=ctxOf(GAS,sh);
  const from=ymd(Date.now()-20*DAY);
  const g=post(ctx,{action:'digest',from:from});
  ok(g.ok===true&&g.from===from,'digest は ok と from を返す');
  const days=Object.keys(g.days).sort();
  ok(days.length>=20&&days.length<=21&&days[0]>=from,'from 以降の日だけを返す',{n:days.length,first:days[0],from});
  const d3=sh[3][REC_HEADERS_FULL.indexOf('date')];
  const expectN=sh.slice(1).filter(r=>r[REC_HEADERS_FULL.indexOf('date')]===d3&&!/^sys_/.test(String(r[0]))).map(r=>String(r[0])).filter((v,i,a)=>a.indexOf(v)===i).length;
  ok(g.days[d3][0]===expectN,'件数は id で重複を除き、職員の控え（sys_）を数えない',{got:g.days[d3][0],expectN});
  ok(typeof g.days[d3][1]==='number'&&g.days[d3][1]>=0&&g.days[d3][1]<4294967296,'id の要約値は32ビットの数');
  ok(g.days[d3][2]>0,'最終更新時刻を返す');
  ok(JSON.stringify(g).length<4000,'応答は小さい（20日ぶんで数KB未満）',JSON.stringify(g).length);
  // 1件消す → その日だけ変わる
  const before=JSON.parse(JSON.stringify(g.days));
  post(ctx,{action:'delRecord',id:String(sh[12][0])});
  const g2=post(ctx,{action:'digest',from:from});
  const changed=Object.keys(before).filter(d=>JSON.stringify(before[d])!==JSON.stringify(g2.days[d]));
  ok(changed.length===1&&changed[0]===sh[12][REC_HEADERS_FULL.indexOf('date')],'1件消すとその日の要約だけが変わる',changed);
})();

/* ════════ 5. getDays ════════ */
head('5. getDays');
(function(){
  const sh=makeSheet(); const sheets={};
  const ctx=ctxOf(GAS,sh,sheets);
  const d1=sh[1][REC_HEADERS_FULL.indexOf('date')], d2=sh[150][REC_HEADERS_FULL.indexOf('date')];
  post(ctx,{action:'delRecord',id:String(sh[151][0])});
  const g=post(ctx,{action:'getDays',days:[d1,d2]});
  const expect=sh.slice(1).filter(r=>[d1,d2].indexOf(r[REC_HEADERS_FULL.indexOf('date')])>=0).length;
  ok(g.ok===true&&g.records.length===expect,'指定した日の記録をすべて返す',{got:g.records.length,expect});
  ok(g.records.every(r=>r.date===d1||r.date===d2),'他の日の記録は入らない');
  ok(g.delta===true&&Array.isArray(g.residents)&&g.cfg!==undefined,'getAll の差分応答と同じ形（端末の取り込み処理をそのまま使える）');
  ok(g.syncCursor===undefined,'基準時刻（syncCursor）は返さない＝端末の差分同期の基準を動かさない');
  ok(Array.isArray(g.deleted)&&g.deleted.length===1,'削除の印を添える',g.deleted);
  /* 2026-10-28: 上限を 7 → 31 日（全件の取得をやめ、記録の無い端末も getDays で受け取るため） */
  const dlist=n=>Array.from({length:n},(_,i)=>'2026-01-'+('0'+(i+1)).slice(-2));
  ok(post(ctx,{action:'getDays',days:dlist(31)}).ok===true,'1回に31日までは受ける');
  const many=post(ctx,{action:'getDays',days:dlist(31).concat(['2026-02-01'])});
  ok(many.ok===false,'1回に32日以上は受けない（31日まで）');
  ok(post(ctx,{action:'getDays',days:[]}).ok===false,'日の指定が空なら受けない');
})();

/* ════════ 6. 読み取りはロックを取らない・書き込みは従来どおり ════════ */
head('6. ロック');
(function(){
  const sh=makeSheet();
  const ctx=ctxOf(GAS,sh);
  let locked=0; ctx.LockService.getScriptLock=()=>({waitLock(){locked++},releaseLock(){}});
  post(ctx,{action:'digest'}); post(ctx,{action:'getDays',days:[sh[1][2]]}); post(ctx,{action:'getAll',heal:false,since:1});
  ok(locked===0,'digest・getDays・getAll はロックを取らない（保存の行列に並ばない）',locked);
  post(ctx,{action:'delRecord',id:String(sh[2][0])});
  ok(locked===1,'削除（書き込み）は従来どおりロックを取る');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
