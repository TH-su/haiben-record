/* ══════════════════════════════════════════════════════════════════════
   ロックを外す前に書き込みを確定させる（SpreadsheetApp.flush）の検証ハーネス（2026-09-23）
   実行:  node tests/lock-flush.test.js
   ──────────────────────────────────────────────────────────────────────
   最重要:
     ①書いた時は「最後の書き込み → flush →（キャッシュの無効化）→ ロックを外す」の順になること
     ②中止の経路（no postData・unknown action・saveSched／setMasterState の検証NG 等＝1文字も書かない）は
       flush しないこと（従来のまま）
     ③flush が失敗しても、ロックは必ず外し、成功の応答を返さないこと（{ok:false, error:'flush_fail'}）
     ④書いている途中で落ちても、書けた分を確定してから外すこと
     ⑤キャッシュの無効化（読み手に取り直しを促す合図）は flush の後に出すこと
     ⑥（再現）タイムアウト後の送り直しで同じ記録（同じ id）が続けて届くと、直す前は同じ id の行が2つになり、
       直した後は1つになることを、直す前の版と並べて確かめる
   ★実物のソース（gas/haiben-api.gs）をそのまま評価し、doPost を通して確かめる（写経しない）。
     直す前の版は git の 9f79982（flush を持たない最後の版＝2026-09-23 時点の HEAD）から取り出す。
   ★偽シートのモデル化（結果を左右するので明記する）:
     ・書き込み（setValue／setValues／clearContent／appendRow／deleteRow／insertSheet／insertColumnsAfter）は、
       その実行の pending に溜まるだけで、他の実行からは見えない
     ・appendRow は「実行ごとの pending に溜まり、確定した時点の末尾（中身のある最終行の次）に付く」。
       呼んだ時点の最終行ではなく、確定した時点の最終行で位置が決まる
     ・読み取り（getSheetByName を含む）は、先に自分の pending を確定してから読む（同じ実行の中では書いた値が読める）。
       本物より確定が早い＝競合の窓を狭く見積もる側（それでも再現するものだけを「再現」と呼ぶ）
     ・SpreadsheetApp.flush() と end()（実行の終わり）で pending を確定する。入居者マスタ（openById）の書き込みも同じ pending に入る
     ・ops に 'lock'／'write:<シート名>'／'flush'／'cache:<キー>'／'release' を起きた順に残す
   ★入居者・記録はすべて合成データ。実在の氏名・記録は一切使わない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const LF_TOKEN='lf-aikotoba-kakuu';   // 試験用の合言葉（架空）
const fs=require('fs'), path=require('path'), vm=require('vm'), cp=require('child_process'), os=require('os');

const ROOT=path.join(__dirname,'..');
/* 既定は本体。HAIBEN_GAS で差し替えられるのは変異テスト（修正を戻した写しでテストがちゃんと赤くなるかの確認）のため。 */
const SRC_NEW=fs.readFileSync(process.env.HAIBEN_GAS||path.join(ROOT,'gas','haiben-api.gs'),'utf8');
/* 直す前の最後の版（9f79982）。取れない時は配信前の控え（~/.claude/backups）を使う */
const OLD_SHA='9f79982';
const OLD_FIX=path.join(os.homedir(),'.claude','backups','flush-rollout-20260923','haiben-record','gas','haiben-api.gs');
function oldSource(){
  try{
    return cp.execFileSync('git',['-C',ROOT,'show',OLD_SHA+':gas/haiben-api.gs'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  }catch(e){
    return fs.existsSync(OLD_FIX)?fs.readFileSync(OLD_FIX,'utf8'):null;
  }
}
const SRC_OLD=oldSource();

let fail=0,pass=0;
function ok(c,m,e){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(e!==undefined?'  → '+JSON.stringify(e):''))}}
function head(t){console.log('\n─── '+t+' ───')}

/* ════════ 偽の Apps Script（書き込みを溜めて、flush か「実行の終わり」で確定する） ════════
   store は全実行で共有する「確定済み」のブック。ss＝このGASのスプレッドシート、master＝入居者マスタ（openById）。 */
function makeStore(books){
  const s={};
  Object.keys(books).forEach(b=>{s[b]={};Object.keys(books[b]).forEach(n=>{s[b][n]=books[b][n].map(r=>r.slice())})});
  return s;
}
const isBlank=v=>v===''||v===null||v===undefined;
const lastRowOf=g=>{for(let i=g.length-1;i>=0;i--){if((g[i]||[]).some(v=>!isBlank(v)))return i+1}return 0};
const lastColOf=g=>{let m=0;g.forEach(r=>{(r||[]).forEach((v,j)=>{if(!isBlank(v))m=Math.max(m,j+1)})});return m};

function makeExec(store,opt){
  const o=opt||{};
  const ops=[], pending=[], nWrite={};
  const commit=()=>{while(pending.length)pending.shift()()};
  function write(name,fn){
    nWrite[name]=(nWrite[name]||0)+1;
    if(o.failWrite&&o.failWrite(name,nWrite[name]))throw new Error('Service Spreadsheets failed while accessing document');
    ops.push('write:'+name);
    pending.push(fn);
  }
  function sheet(bk,name){
    const G=()=>store[bk][name];
    const read=()=>{commit();return G()};
    return{
      getName:()=>name,
      getLastRow:()=>lastRowOf(read()),
      getLastColumn:()=>lastColOf(read()),
      getMaxColumns:()=>Math.max(26,lastColOf(read())),
      getRange(r,c,nr,nc){
        nr=nr===undefined?1:nr;nc=nc===undefined?1:nc;
        const setGrid=vals=>()=>{const g=G();
          for(let i=0;i<vals.length;i++){const ri=r-1+i;if(!g[ri])g[ri]=[];for(let j=0;j<vals[i].length;j++)g[ri][c-1+j]=vals[i][j]}};
        return{
          getValues(){const g=read(),out=[];
            for(let i=0;i<nr;i++){const src=g[r-1+i]||[],row=[];for(let j=0;j<nc;j++){const v=src[c-1+j];row.push(v===undefined?'':v)}out.push(row)}
            return out},
          getValue(){const src=read()[r-1]||[];const v=src[c-1];return v===undefined?'':v},
          setValues(vals){write(name,setGrid(vals.map(x=>x.slice())))},
          setValue(v){write(name,setGrid([[v]]))},
          clearContent(){const blank=[];for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++)row.push('');blank.push(row)}
            write(name,setGrid(blank));return this}
        };
      },
      /* 確定した時点の最終行の次に付く（呼んだ時点の最終行ではない） */
      appendRow(row){const copy=row.slice();write(name,()=>{const g=G();g[lastRowOf(g)]=copy});return this},
      deleteRow(r){write(name,()=>{G().splice(r-1,1)})},
      insertColumnsAfter(){write(name,()=>{})}
    };
  }
  function book(bk){
    return{
      getId:()=>bk,
      getSheetByName(n){commit();return store[bk][n]?sheet(bk,n):null},
      insertSheet(n){write(n,()=>{if(!store[bk][n])store[bk][n]=[]});return sheet(bk,n)}
    };
  }
  const lock=o.lockFor?o.lockFor(ops):{tryLock:()=>true,waitLock(){ops.push('lock')},releaseLock(){ops.push('release')}};
  const sb={
    console:{log(){},warn(){},error(){}},
    SpreadsheetApp:{
      getActiveSpreadsheet:()=>book('ss'),
      openById:id=>{if(id!=='MASTER-ID'||!store.master)throw new Error('Exception: 見つかりません');return book('master')},
      flush(){ops.push('flush');if(o.flushFails)throw new Error('Service Spreadsheets timed out');commit()}
    },
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>(k==='MASTER_SHEET_ID'?(o.noMaster?null:'MASTER-ID'):k==='HAIBEN_TOKEN'?LF_TOKEN:null)})},   // 2026-10-08 から合言葉が未設定なら全部断るため、設定済みにする
    CacheService:{getScriptCache:()=>({get:()=>null,put(){},remove(k){ops.push('cache:'+k)}})},
    LockService:{getScriptLock:()=>lock},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType(){return this},getContent:()=>s})}
  };
  vm.createContext(sb);
  vm.runInContext(o.src||SRC_NEW,sb,{filename:'haiben-api.gs'});
  return{sb:sb,ops:ops,end:commit,pending:pending};
}

/* ops を読みやすく縮める。書き込みは W、キャッシュの無効化は cache。例: 'lock W flush cache release' */
const seq=ops=>ops.map(x=>x.indexOf('write:')===0?'W':(x.indexOf('cache:')===0?'cache':x)).join(' ');
const WROTE=/^lock( W)+ flush release$/;                 // 書いた時の決まり（合図なし）
const WROTE_SIG=/^lock( W)+ flush cache release$/;       // 書いた時の決まり（キャッシュの無効化あり）
const rawPost=(E,body)=>E.sb.doPost(body===null?{}:{postData:{contents:JSON.stringify(body&&typeof body==='object'&&!('token' in body)?Object.assign({token:LF_TOKEN},body):body)}}).getContent();
const post=(E,body)=>JSON.parse(rawPost(E,body));

/* ── 本体の定数（写経しない。本体から読む） ── */
const K=(function(){
  const E=makeExec(makeStore({ss:{}}));
  return vm.runInContext('({REC:REC_DEFAULT_HEADERS.slice(),RES:RES_DEFAULT_HEADERS.slice(),CFG:CFG_DEFAULT_HEADERS.slice(),'
    +'RES_KEY:RESIDENTS_CACHE_KEY,ROSTER_KEY:MASTER_ROSTER_CACHE_KEY,DEL_KEY:(typeof DELETED_CACHE_KEY==="undefined"?null:DELETED_CACHE_KEY)})',E.sb);
})();

/* ── 試験データ（合成） ── */
function recRow(id,rid,time){
  const r=K.REC.map(()=>'');
  const set=(k,v)=>{r[K.REC.indexOf(k)]=v};
  set('id',id);set('residentId',rid);set('date','2026-09-01');set('time',time||'10:00');set('type','urine');
  set('staff','職員S');set('createdAt','2026-09-01T01:00:00.000Z');set('updatedAt','2026-09-01T01:00:00.000Z');
  return r;
}
function resRow(id,name,room,sched){
  const r=K.RES.map(()=>'');
  const set=(k,v)=>{r[K.RES.indexOf(k)]=v};
  set('id',id);set('name',name);set('room',room);set('active',true);set('hidden',false);set('schedule',sched||'');
  return r;
}
/* このGASのブック（Records／Residents／Config）と入居者マスタのブック（master／meta） */
function books(opt){
  const o=opt||{};
  const ss={
    Records:[K.REC.slice(),recRow('rec-001',1,'09:00'),recRow('rec-002',2,'09:30')],
    Residents:[K.RES.slice(),resRow(1,'入居者A','101','["09:00"]'),resRow(2,'入居者B','102','')],
    Config:[K.CFG.slice(),['alertHours',48]]
  };
  const master={
    master:[['id','name','dataJson'],['M001','入居者A','{"hospitalized":false}'],['M002','入居者B','壊れた値']],
    meta:[[1700000000000]]
  };
  (o.drop||[]).forEach(n=>{delete ss[n];delete master[n]});
  return{ss:ss,master:master};
}
const REC_NEW={id:'rec-900',residentId:1,date:'2026-09-23',time:'10:00',type:'urine',staff:'職員S'};
const RES_A={id:1,name:'入居者A',yomi:'ニュウキョシャエー',room:'101',active:true,hidden:false};
const idsOf=(store,sheet)=>store.ss[sheet].slice(1).map(r=>r[0]);
const countId=(store,sheet,id)=>idsOf(store,sheet).filter(x=>String(x)===String(id)).length;
const cacheOps=E=>E.ops.filter(x=>x.indexOf('cache:')===0);
/* 書いた時: flush → 合図 → 外す の順か（合図が無い経路では flush → 外す） */
function orderOk(E){
  const f=E.ops.indexOf('flush'),rl=E.ops.lastIndexOf('release');
  const c=E.ops.map((x,i)=>x.indexOf('cache:')===0?i:-1).filter(i=>i>=0);
  const lastW=E.ops.map((x,i)=>x.indexOf('write:')===0?i:-1).filter(i=>i>=0).pop();
  return f>lastW&&c.every(i=>i>f&&i<rl)&&rl===E.ops.length-1;
}

/* ══════════════ 0. 前提 ══════════════ */
head('0. 前提（本体と直す前の版を読めたか）');
{
  /* 2026-10-28: 古い記録を控えへ移す処理（archiveRun_・_archiveChunk_）は doPost とは別の入口（代表者がエディタ・時間の引き金で実行）で、
     自分でロックを取り、写した後と消した後に確定する。doPost の経路の決まり（1か所だけ）はそれを除いて数える */
  const XG=require('./_extract').makeExtractor(SRC_NEW);
  let rest=SRC_NEW;
  ['archiveRun_','_archiveChunk_'].forEach(n=>{try{rest=rest.replace(XG.fn(n),'')}catch(e){}});
  const code=rest.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  ok((code.match(/SpreadsheetApp\.flush\(\)/g)||[]).length===1,'flush を呼ぶのは1か所だけ（flushBeforeRelease_ の中・移す処理を除く）');
  ok((code.match(/lock\.releaseLock\(\)/g)||[]).length===1,'ロックを外すのは doPost の finally の1か所だけ（移す処理を除く）');
  if(/function _archiveChunk_\(/.test(SRC_NEW)){
    const ch=XG.fn('_archiveChunk_'), run=XG.fn('archiveRun_');
    ok(ch.indexOf('SpreadsheetApp.flush()')<ch.indexOf('照らし合わせ')&&ch.indexOf('照らし合わせ')<ch.indexOf('sh.deleteRows('),'移す処理は 写す→確定→照らし合わせ→消す の順');
    ok(/finally\{ try\{ lock\.releaseLock\(\); \}catch\(_\)\{\} \}/.test(run),'移す処理のロックは finally で外す');
  }
  ok(!!SRC_OLD&&!/SpreadsheetApp\.flush\(\)/.test(SRC_OLD),'直す前の版（9f79982）を読めた＝下の「再現」が走る（flush を持たない版）');
}

/* ══════════════ 1. 書いた時の順 ══════════════ */
head('1. 書いた時は 最後の書き込み → flush →（合図）→ 外す');
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'addRecord',record:REC_NEW});
  ok(r.ok===true,'addRecord（新しい記録）は通る',r);
  ok(WROTE.test(seq(E.ops)),'★addRecord: 追記 → flush → 外す',seq(E.ops));
  ok(E.pending.length===0&&countId(s,'Records','rec-900')===1,'外す前に追記が確定している（実行の終わりに持ち越さない）');
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'saveRecord',record:{id:'rec-002',residentId:2,date:'2026-09-01',time:'09:45',type:'urine',staff:'職員S'}});
  ok(r.ok===true&&WROTE.test(seq(E.ops)),'★saveRecord（既存の記録の上書き）: 書き込み → flush → 外す',[r,seq(E.ops)]);
  ok(countId(s,'Records','rec-002')===1&&idsOf(s,'Records').length===2,'上書きで行は増えない');
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'delRecord',id:'rec-001'});
  /* 2026-10-07: 削除の印（Deleted シート）も書き、flush の後に印のキャッシュを無効化する（旧版は合図なし） */
  const HAS_MARK=/function deleteRecordMarked_\(/.test(SRC_NEW);
  ok(r.ok===true&&(HAS_MARK?WROTE_SIG:WROTE).test(seq(E.ops)),'★delRecord: 削除（＋削除の印） → flush →（合図）→ 外す',[r,seq(E.ops)]);
  if(HAS_MARK)ok(cacheOps(E).join()==='cache:'+K.DEL_KEY,'無効化するのは削除の印のキャッシュ',cacheOps(E));
  ok(countId(s,'Records','rec-001')===0,'削除は外す前に確定している');
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'saveRes',resident:RES_A});
  ok(r.ok===true&&WROTE_SIG.test(seq(E.ops)),'★saveRes: 書き込み → flush → キャッシュ無効化 → 外す',[r,seq(E.ops)]);
  ok(cacheOps(E).join()==='cache:'+K.RES_KEY,'無効化するのは入居者のキャッシュ',cacheOps(E));
}
{
  const t0=books();t0.ss.Residents=[K.RES.filter(h=>h!=='schedule'),resRow(1,'入居者A','101').slice(0,K.RES.length-1)];
  const s=makeStore(t0),E=makeExec(s);
  const r=post(E,{action:'saveRes',resident:RES_A});
  ok(r.ok===true&&/^lock W W flush cache release$/.test(seq(E.ops)),'★saveRes（不足列の追加あり）: 見出し → 行 → flush → 無効化 → 外す',[r,seq(E.ops)]);
  ok(s.ss.Residents[0].indexOf('schedule')>=0,'不足列（schedule）の見出しも確定している');
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'saveSched',id:1,schedule:['08:00','20:00']});
  ok(r.ok===true&&WROTE_SIG.test(seq(E.ops)),'★saveSched: 予定のセル → flush → キャッシュ無効化 → 外す',[r,seq(E.ops)]);
  ok(s.ss.Residents[1][K.RES.indexOf('schedule')]==='["08:00","20:00"]','予定は外す前に確定している');
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'delRes',id:2});
  ok(r.ok===true&&WROTE_SIG.test(seq(E.ops)),'★delRes: 削除 → flush → キャッシュ無効化 → 外す',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'saveCfg',cfg:{alertHours:72,warnDays:3}});
  ok(r.ok===true&&/^lock W W flush release$/.test(seq(E.ops)),'★saveCfg: 消す → 書く → flush → 外す',[r,seq(E.ops)]);
  ok(JSON.stringify(s.ss.Config.slice(1,3))==='[["alertHours",72],["warnDays",3]]','設定は外す前に確定している',s.ss.Config);
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'setMasterState',masterId:'M001',hospitalized:true});
  ok(r.ok===true&&r.hospitalized===true,'setMasterState は通る',r);
  ok(/^lock W W flush cache release$/.test(seq(E.ops)),'★setMasterState: dataJson → meta A1 → flush → 名簿キャッシュ無効化 → 外す',seq(E.ops));
  ok(cacheOps(E).join()==='cache:'+K.ROSTER_KEY,'無効化するのは名簿のキャッシュ',cacheOps(E));
  ok(JSON.parse(s.master.master[1][2]).hospitalized===true&&s.master.meta[0][0]!==1700000000000,'入居者マスタ側の2か所（dataJson・meta A1）も外す前に確定している');
}

/* ══════════════ 2. 中止の経路 ══════════════ */
head('2. 中止の経路（1文字も書かない）は flush しない（従来のまま）');
[
  ['unknown action',{action:'nope'},'unknown action: nope'],
  ['saveSched の予定が配列でない',{action:'saveSched',id:1,schedule:'08:00'},'invalid schedule'],
  ['saveSched の入居者が居ない',{action:'saveSched',id:99,schedule:['08:00']},'resident not found'],
  ['setMasterState の masterId が無い',{action:'setMasterState',hospitalized:true},'masterId がありません'],
  ['setMasterState の方がマスタに居ない',{action:'setMasterState',masterId:'M999',hospitalized:true},'not found'],
  ['setMasterState の dataJson が壊れている',{action:'setMasterState',masterId:'M002',hospitalized:true},'dataJson の形式が不正です'],
  /* 2026-10-18（改善プロンプト第2弾の14）: 例外の中身は応答に出さず定型文にした（意図的な期待値の更新） */
  ['addRecord の記録が無い',{action:'addRecord'},'サーバーで処理できませんでした。時間をおいてもう一度お試しください']
].forEach(([label,body,err])=>{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,body);
  ok(r.ok===false&&r.error===err&&seq(E.ops)==='lock release',label+' → そのままの応答で、lock → 外す だけ',[r,seq(E.ops)]);
});
{
  /* 本文が無い要求は合言葉も無い＝2026-10-08 から認証で断る（ロックも取らない・1文字も書かない）。以前は猶予モードで
     認証を通り、no postData でロックを取ってから外していた */
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,null);
  ok(r.ok===false&&/認証エラー/.test(r.error)&&seq(E.ops)==='','no postData → 認証で断る（ロックを取らない・flush しない）',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s,{noMaster:true});
  const r=post(E,{action:'setMasterState',masterId:'M001',hospitalized:true});
  ok(r.ok===false&&seq(E.ops)==='lock release','setMasterState の連携が未設定 → flush しない',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'delRecord',id:'rec-999'});
  if(/function deleteRecordMarked_\(/.test(SRC_NEW)){
    /* 2026-10-07: サーバーに無い記録の削除でも印は残す（他の端末の写しを送り直させない）＝書く → flush してから外す */
    ok(r.ok===true&&WROTE_SIG.test(seq(E.ops)),'delRecord の対象が無くても削除の印は書く → flush → 合図 → 外す',[r,seq(E.ops)]);
  }else{
    ok(r.ok===true&&seq(E.ops)==='lock release','delRecord の対象が無い（書かない）→ 従来どおり ok:true・flush しない',[r,seq(E.ops)]);
  }
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'delRes',id:99});
  ok(r.ok===true&&seq(E.ops)==='lock cache release','delRes の対象が無い → flush しない（キャッシュの無効化は従来どおり出す）',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'saveCfg'});
  ok(r.ok===true&&seq(E.ops)==='lock release','saveCfg の設定が無い → 従来どおり ok:true・flush しない',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s);
  const r=post(E,{action:'setMasterState',masterId:'M002',hospitalized:true});
  ok(s.master.master[2][2]==='壊れた値','壊れた dataJson は上書きしない（従来の安全側のまま）');
}

/* ══════════════ 3. シートの作成・見出しも書き込み ══════════════ */
head('3. シートの自動作成・見出しの書き込みも「書いた」に数える');
{
  const s=makeStore(books({drop:['Config']})),E=makeExec(s);
  const r=post(E,{action:'saveCfg',cfg:{alertHours:24}});
  ok(r.ok===true&&/^lock W W W flush release$/.test(seq(E.ops)),'★Config タブが無い: 作成 → 見出し → 設定 → flush → 外す',[r,seq(E.ops)]);
  ok(s.ss.Config&&s.ss.Config[0].join()===K.CFG.join(),'作ったタブと見出しも外す前に確定している');
}
{
  const s=makeStore(books({drop:['Residents']})),E=makeExec(s);
  const r=post(E,{action:'saveSched',id:1,schedule:['08:00']});
  ok(r.ok===false&&r.error==='resident not found','Residents タブが無い saveSched は入居者が居ないので失敗で返る（従来どおり）',r);
  ok(/^lock W W flush release$/.test(seq(E.ops)),'★ただしタブの作成と見出しは書いたので、flush してから外す',seq(E.ops));
}
/* 見出し・不足列だけを書いて中止する経路。後続の upsertRow_／saveSched_ の印に隠れないので、
   getOrCreateSheet_（見出し行が空）と ensureHeaders_（不足列）の印が抜けたらここで落ちる */
{
  /* schedule 列が無い＋該当の入居者が居ない: 不足列の見出しだけ書いて中止 */
  const t0=books();t0.ss.Residents=[K.RES.filter(h=>h!=='schedule'),resRow(1,'入居者A','101').slice(0,K.RES.length-1)];
  const s=makeStore(t0),E=makeExec(s);
  const r=post(E,{action:'saveSched',id:99,schedule:['08:00']});
  ok(r.ok===false&&r.error==='resident not found','schedule 列が無く入居者も居ない saveSched は失敗で返る（従来どおり）',r);
  ok(seq(E.ops)==='lock W flush release','★ただし不足列の見出しは書いたので、flush してから外す',seq(E.ops));
  if(SRC_OLD){
    const Eo=makeExec(makeStore(t0),{src:SRC_OLD});
    rawPost(Eo,{action:'saveSched',id:99,schedule:['08:00']});
    ok(seq(Eo.ops)==='lock W release','（対照）直す前は不足列の見出しを書いたまま flush せずに外していた',seq(Eo.ops));
  }
}
{
  /* 見出し行が空＋該当の入居者が居ない: 見出しだけ書いて中止 */
  const t0=books();t0.ss.Residents=[K.RES.map(()=>'')];
  const s=makeStore(t0),E=makeExec(s);
  const r=post(E,{action:'saveSched',id:99,schedule:['08:00']});
  ok(r.ok===false&&r.error==='resident not found','見出し行が空で入居者も居ない saveSched は失敗で返る（従来どおり）',r);
  ok(seq(E.ops)==='lock W flush release','★ただし見出しは書いたので、flush してから外す',seq(E.ops));
  if(SRC_OLD){
    const Eo=makeExec(makeStore(t0),{src:SRC_OLD});
    rawPost(Eo,{action:'saveSched',id:99,schedule:['08:00']});
    ok(seq(Eo.ops)==='lock W release','（対照）直す前は見出しを書いたまま flush せずに外していた',seq(Eo.ops));
  }
}
{
  const s=makeStore(books({drop:['meta']})),E=makeExec(s);
  const r=post(E,{action:'setMasterState',masterId:'M001',hospitalized:false});
  ok(r.ok===true&&/^lock W W W flush cache release$/.test(seq(E.ops)),'★マスタ側に meta タブが無い: dataJson → タブ作成 → A1 → flush → 無効化 → 外す',[r,seq(E.ops)]);
}

/* ══════════════ 4. flush が失敗した時 ══════════════ */
head('4. flush が失敗した時（ロックは必ず外す・成功の応答を返さない）');
[
  ['addRecord',{action:'addRecord',record:REC_NEW},WROTE],
  ['saveRes',{action:'saveRes',resident:RES_A},WROTE_SIG],
  ['saveSched',{action:'saveSched',id:1,schedule:['08:00']},WROTE_SIG],
  ['saveCfg',{action:'saveCfg',cfg:{alertHours:12}},WROTE],
  ['setMasterState',{action:'setMasterState',masterId:'M001',hospitalized:true},WROTE_SIG]
].forEach(([label,body,re])=>{
  const s=makeStore(books()),E=makeExec(s,{flushFails:true});
  const raw=rawPost(E,body);
  ok(raw==='{"ok":false,"error":"flush_fail"}','★'+label+': 確定できなければ {ok:false, error:\'flush_fail\'}',raw);
  ok(re.test(seq(E.ops)),label+': flush を試みてから必ず外す（無効化も外す前に出す）',seq(E.ops));
});
{
  const s=makeStore(books()),E=makeExec(s,{flushFails:true});
  const r=post(E,{action:'saveSched',id:1,schedule:'x'});
  ok(r.error==='invalid schedule'&&seq(E.ops)==='lock release','中止の経路は flush しないので、flush の失敗に巻き込まれない（元の応答のまま）',[r,seq(E.ops)]);
}

/* ══════════════ 5. 途中で落ちた時 ══════════════ */
head('5. 書いている途中で落ちた時（書けた分を確定してから外す）');
{
  /* 不足列の見出しは書けたが、行の書き込みで落ちる */
  const t0=books();t0.ss.Residents=[K.RES.filter(h=>h!=='schedule'),resRow(1,'入居者A','101').slice(0,K.RES.length-1)];
  const s=makeStore(t0),E=makeExec(s,{failWrite:(name,n)=>name==='Residents'&&n===2});
  const r=post(E,{action:'saveRes',resident:RES_A});
  ok(r.ok===false&&r.error==='サーバーで処理できませんでした。時間をおいてもう一度お試しください'&&!/Service Spreadsheets|Error:/.test(r.error),'saveRes: 途中の例外は ok:false・応答は定型文（例外の中身を出さない・2026-10-18）',r);
  ok(seq(E.ops)==='lock W flush release','★saveRes: 書けた見出し → flush → 外す（外した後に確定して、次の実行と前後が入れ替わらない）',seq(E.ops));
  ok(E.pending.length===0&&s.ss.Residents[0].indexOf('schedule')>=0,'書きかけは外す前に確定している');
  ok(cacheOps(E).length===0,'途中で落ちた時のキャッシュの扱いは従来どおり（無効化しない）');
}
{
  /* 設定: 消すのは書けたが、書き直しで落ちる */
  const s=makeStore(books()),E=makeExec(s,{failWrite:(name,n)=>name==='Config'&&n===2});
  const r=post(E,{action:'saveCfg',cfg:{alertHours:6}});
  ok(r.ok===false&&seq(E.ops)==='lock W flush release','★saveCfg: 消した分 → flush → 外す',[r,seq(E.ops)]);
}
{
  const s=makeStore(books()),E=makeExec(s,{flushFails:true,failWrite:(name,n)=>name==='Config'&&n===2});
  const r=post(E,{action:'saveCfg',cfg:{alertHours:6}});
  ok(r.ok===false&&r.error==='flush_fail'&&seq(E.ops)==='lock W flush release','途中で落ちた上に flush も失敗 → flush_fail で返し、必ず外す',[r,seq(E.ops)]);
}

/* ══════════════ 6. 合図の位置と成功時の応答 ══════════════ */
head('6. キャッシュの無効化は flush の後・成功時の応答は1文字も変えない');
const CASES=[
  ['addRecord',{action:'addRecord',record:REC_NEW}],
  ['saveRecord',{action:'saveRecord',record:{id:'rec-001',residentId:1,type:'stool'}}],
  ['delRecord',{action:'delRecord',id:'rec-001'}],
  ['saveRes',{action:'saveRes',resident:RES_A}],
  ['saveSched',{action:'saveSched',id:1,schedule:['07:00']}],
  ['delRes',{action:'delRes',id:2}],
  ['saveCfg',{action:'saveCfg',cfg:{alertHours:36}}],
  ['setMasterState',{action:'setMasterState',masterId:'M001',hospitalized:true}]
];
CASES.forEach(([label,body])=>{
  const E=makeExec(makeStore(books()));
  rawPost(E,body);
  ok(orderOk(E),label+': 最後の書き込み → flush → 合図 → 外す',E.ops);
});
if(SRC_OLD){
  CASES.forEach(([label,body])=>{
    const Eo=makeExec(makeStore(books()),{src:SRC_OLD}),En=makeExec(makeStore(books()));
    const ro=JSON.parse(rawPost(Eo,body)),rn=JSON.parse(rawPost(En,body));
    if(label==='setMasterState'){delete ro.hospitalizedAt;delete rn.hospitalizedAt}   // 時刻だけは実行ごとに変わる
    ok(JSON.stringify(ro)===JSON.stringify(rn),label+': 成功時の応答は直す前と同じ',[ro,rn]);
  });
  {
    const Eo=makeExec(makeStore(books()),{src:SRC_OLD});
    rawPost(Eo,{action:'saveRes',resident:RES_A});
    ok(seq(Eo.ops)==='lock W cache release','（対照）直す前は flush せず、確定前にキャッシュを消して外していた',seq(Eo.ops));
  }
}

/* ══════════════ 7. 再現 ══════════════
   B は A がロックを外した瞬間にロックを取り、A の実行が終わる前に走り切る
   （本物では、外してから A の実行が終わる＝溜まった書き込みが確定するまでの隙間）。 */
function race(src,runA,runB){
  const store=makeStore(books());
  let hook=null;
  const lockFor=ops=>({tryLock:()=>true,waitLock(){ops.push('lock')},
    releaseLock(){ops.push('release');const h=hook;hook=null;if(h)h()}});
  const A=makeExec(store,{src:src,lockFor:lockFor}),B=makeExec(store,{src:src,lockFor:lockFor});
  let rB=null;
  hook=()=>{rB=runB(B.sb);B.end()};
  const rA=runA(A.sb);
  A.end();                                        // A の実行の終わり（溜まっていた書き込みの確定）
  return{rA:rA,rB:rB,store:store};
}
head('7. 再現: タイムアウト後の送り直し（同じ記録が続けて2回届く）');
if(!SRC_OLD){
  ok(false,'直す前の版が読めないため再現を飛ばした（git も控えも無い）');
}else{
  const send=sb=>JSON.parse(sb.doPost({postData:{contents:JSON.stringify({action:'addRecord',token:LF_TOKEN,record:REC_NEW})}}).getContent());
  const o=race(SRC_OLD,send,send), n=race(SRC_NEW,send,send);
  ok(o.rA.ok===true&&o.rB&&o.rB.ok===true,'再現 直す前: 2回とも「保存しました」になる',[o.rA,o.rB]);
  ok(countId(o.store,'Records','rec-900')===2,'★再現 直す前: 同じ id の行が2つになる（2回目が1回目の行を見つけられない）',idsOf(o.store,'Records'));
  ok(n.rA.ok===true&&n.rB&&n.rB.ok===true,'直した後: 2回とも通る',[n.rA,n.rB]);
  ok(countId(n.store,'Records','rec-900')===1,'★直した後: 同じ id の行は1つ（2回目は1回目の行を上書きする）',idsOf(n.store,'Records'));
  ok(idsOf(n.store,'Records').length===3,'直した後: ほかの記録は増えも減りもしない',idsOf(n.store,'Records'));
}

console.log('\n結果: '+pass+' 件成功 / '+fail+' 件失敗');
process.exit(fail?1:0);
