/* ══════════════════════════════════════════════════════════════════════
   人ごとのおむつ・パッド（padSet・2026-10-19）の検証ハーネス
   実行:  node tests/padset.test.js
   ★実物のソース（gas/haiben-api.gs・haiben-record.html）をそのまま評価する。判定ロジックを写経しない。
   ★入居者・記録はすべて合成データ。実在の氏名・記録は使わない。接続先は設定しない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeGasCtx}=require('./_gas-ctx');
const {makeExtractor}=require('./_extract');
const ROOT=path.join(__dirname,'..');
const GAS=fs.readFileSync(path.join(ROOT,'gas','haiben-api.gs'),'utf8');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);return m[1]})();
const X=makeExtractor(SRC);

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra):''))}}
function head(t){console.log('\n─── '+t+' ───')}
function post(ctx,body){return JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).getContent())}

/* Residents の盤面（padSet 列はまだ無い＝配信直後のシート） */
function resSheet(){return [['id','name','yomi','room','gender','active','hidden','laxNote','cfg','schedule'],
  [1,'入居者A','','101','女性',true,false,'','','[]'],
  [2,'入居者B','','102','男性',true,false,'','','']]}

head('1. GAS: savePadSet は padSet の列だけを書く');
(function(){
  const sh=resSheet();
  const ctx=makeGasCtx(GAS,sh,{writable:true});
  const ps={at:1000,day:[{n:'テープ式おむつ M',l:'外'},{n:'尿取りパッド 昼用300cc',l:'内'}],night:[{n:'尿取りパッド 夜用600cc',l:'内'}]};
  const r=post(ctx,{action:'savePadSet',id:1,padSet:ps});
  ok(r.ok===true,'書き込みが通る',r);
  const ci=sh[0].indexOf('padSet');
  ok(ci===10,'padSet の列が見出しの末尾に足される',sh[0]);
  const saved=JSON.parse(sh[1][ci]);
  ok(saved.day.length===2&&saved.night[0].n==='尿取りパッド 夜用600cc'&&saved.at===1000,'中身が JSON で入る',saved);
  ok(sh[1][9]==='[]'&&sh[1][1]==='入居者A','ほかの列（予定・氏名）は触らない');
  ok(sh[2][ci]===undefined||sh[2][ci]==='','ほかの入居者の行は触らない');
  /* 古い送信は書かない */
  const r2=post(ctx,{action:'savePadSet',id:1,padSet:{at:500,day:[],night:[]}});
  ok(r2.ok===true&&r2.stale===true&&JSON.parse(sh[1][ci]).day.length===2,'セルより古い at の送信は書かず ok で受け流す（未送信の古い再送で巻き戻さない）',r2);
  const r3=post(ctx,{action:'savePadSet',id:1,padSet:{at:2000,day:[],night:[]}});
  ok(r3.ok===true&&JSON.parse(sh[1][ci]).day.length===0,'新しい at なら空（全部外す）も書く＝空の明示');
  ok(post(ctx,{action:'savePadSet',id:99,padSet:{at:3000,day:[],night:[]}}).ok===false,'行が無い入居者は ok:false（再送で後から通る）');
  ok(post(ctx,{action:'savePadSet',id:1,padSet:'壊れた'}).ok===false,'形の違う値は断る');
  ok(post(ctx,{action:'savePadSet',id:1,padSet:{day:[]}}).ok===false,'at の無い値は断る');
  const r4=post(ctx,{action:'savePadSet',id:2,padSet:{at:10,day:[{n:'x'.repeat(80),l:'横'},null,{n:''}],night:'x'}});
  const s4=JSON.parse(sh[2][ci]);
  ok(r4.ok&&s4.day.length===1&&s4.day[0].n.length===40&&s4.day[0].l===''&&Array.isArray(s4.night)&&!s4.night.length,'受け取った値を整える（40字まで・位置は外/内だけ・空や壊れは捨てる）',s4);
})();

head('2. GAS: saveRes（行まるごとの上書き）は padSet のセルを残す');
(function(){
  const sh=resSheet();
  const ctx=makeGasCtx(GAS,sh,{writable:true});
  post(ctx,{action:'savePadSet',id:1,padSet:{at:1000,day:[{n:'テープ式おむつ M',l:'外'}],night:[]}});
  const ci=sh[0].indexOf('padSet');
  const before=sh[1][ci];
  post(ctx,{action:'saveRes',resident:{id:1,name:'入居者A',room:'103',active:true}});
  ok(sh[1][3]==='103','saveRes は居室を書く');
  ok(sh[1][ci]===before,'padSet を持たない（旧版の）saveRes でも padSet は消えない');
  post(ctx,{action:'saveRes',resident:{id:1,name:'入居者A',room:'103',active:true,padSet:{at:9,day:[],night:[]}}});
  ok(sh[1][ci]===before,'padSet を持つ saveRes でも書かない（書き手は savePadSet だけ）');
  post(ctx,{action:'saveRes',resident:{id:3,name:'入居者C',room:'104',active:true}});
  ok(sh[3]&&(sh[3][ci]===''||sh[3][ci]===undefined),'新しい入居者の行の padSet は空');
})();

head('3. GAS: 能力宣言');
(function(){
  ok((GAS.match(/padSetVer: 1/g)||[]).length===2,'全件・差分の応答と、日を指定した応答の両方で padSetVer:1 を返す');
  ok(/case 'savePadSet': return json\(flushBeforeRelease_\(savePadSet_\(body\)\)\)/.test(GAS),'savePadSet を受け付ける');
})();


/* ════════ アプリ側 ════════ */
function appSandbox(residents,opts){
  opts=opts||{};
  const store={};
  const sb={console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,RegExp,
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem(k,v){store[k]=String(v)},removeItem(k){delete store[k]}}};
  vm.createContext(sb);
  const fns=['parsePadSet','padSetFor','padSetLine','padSetMerge','padSetNoteSrv','padSetSrvOk','padScopeText','parsePads','padsText','padsTotal','padsSrvTag','padKinds','isStaffDayTime','hbNightAuto','padMineClick'];
  vm.runInContext([X.varDecl('PADSET_SRV_KEY'),X.varDecl('PAD_KINDS_DEF'),X.varDecl('STAFF_DAY_START_H'),X.varDecl('STAFF_DAY_END_H')].concat(fns.map(n=>X.fn(n))).join('\n'),sb);
  sb.D={residents:residents||[],cfg:{}};
  sb.apiUrl=opts.apiUrl||'';
  sb.ci={pads:{}};sb._padMine=[];sb._padOpen=false;
  sb.renderPadCard=()=>{};sb.updateSubmitGate=()=>{};
  return sb;
}
const at=(h,m)=>{const d=new Date();d.setHours(h,m||0,0,0);return d};

head('4. アプリ: padSet の読み取り（受け取った値を信じない）');
(function(){
  const sb=appSandbox();
  ok(sb.parsePadSet(null)===null&&sb.parsePadSet('')===null,'空のセル・値なしは null（手元を残す）');
  ok(sb.parsePadSet('{壊れ')===null&&sb.parsePadSet('[]')===null,'壊れた値・配列は null');
  ok(sb.parsePadSet({day:[{n:'a'}]})===null,'at の無い値は null');
  const p=sb.parsePadSet('{"at":5,"day":[{"n":" テープ式おむつ M ","l":"外"},{"n":"","l":"内"},{"n":"尿取りパッド","l":"上"}],"night":"x"}');
  ok(p&&p.day.length===2&&p.day[0].n==='テープ式おむつ M'&&p.day[1].l===''&&Array.isArray(p.night)&&!p.night.length,'文字列の JSON を読み、空の品目と知らない位置を整える',p);
  const e=sb.parsePadSet({at:9,day:[],night:[]});
  ok(e&&e.day.length===0,'全部外した値（空の配列＋at）は「空の明示」として残す');
})();

head('5. アプリ: 昼と夜');
(function(){
  const r={id:1,padSet:{at:1,day:[{n:'テープ式おむつ M',l:'外'},{n:'尿取りパッド 昼用',l:'内'}],night:[{n:'尿取りパッド 夜用600',l:'内'}]}};
  const sb=appSandbox([r]);
  ok(sb.padSetFor(r,at(10)).list[1].n==='尿取りパッド 昼用'&&sb.padSetFor(r,at(10)).night===false,'10時は昼の品目');
  ok(sb.padSetFor(r,at(22)).list[0].n==='尿取りパッド 夜用600'&&sb.padSetFor(r,at(22)).night===true,'22時は夜の品目');
  ok(sb.padSetFor(r,at(6,59)).night===true&&sb.padSetFor(r,at(7)).night===false,'夜は翌7時まで（6:59 は夜・7:00 は昼）');
  const r2={id:2,padSet:{at:1,day:[{n:'パンツ式おむつ L',l:''}],night:[]}};
  ok(sb.padSetFor(r2,at(23)).list[0].n==='パンツ式おむつ L','夜を決めていない方は夜も昼の品目');
  ok(sb.padSetFor({id:3},at(10)).list.length===0,'未設定の方は空');
  ok(sb.padSetFor(r,'2026-10-19T22:30').night===true,'記録の日時（入力欄の文字列）で決める');
})();

head('6. アプリ: 同期の取り込み（消失より復活・新しい方を採る）');
(function(){
  const sb=appSandbox();
  const loc={at:200,day:[{n:'A',l:''}],night:[]},srv={at:100,day:[{n:'B',l:''}],night:[]};
  ok(sb.padSetMerge(srv,loc,true).day[0].n==='A','その入居者の savePadSet が送信待ち → 手元を残す');
  ok(sb.padSetMerge(srv,loc,false).day[0].n==='B','送り終えていればサーバーの値（端末の時計の新旧では決めない）');
  ok(sb.padSetMerge({at:300,day:[{n:'C'}],night:[]},loc,false).day[0].n==='C','サーバーの値が新しい → サーバー');
  ok(sb.padSetMerge(undefined,loc).day[0].n==='A','サーバーに値が無い（旧GAS・空のセル）→ 手元を残す');
  ok(sb.padSetMerge('壊れ',loc).day[0].n==='A','サーバーの値が壊れている → 手元を残す');
  ok(sb.padSetMerge({at:300,day:[],night:[]},loc).day.length===0,'サーバーで全部外した（空の明示・新しい）→ 外す');
  ok(sb.padSetMerge(null,null)===null,'どちらにも無ければ無し');
  ok(/padSetMerge\(r\.padSet,lr\.padSet,padSetPending\(k\)\)/.test(SRC),'同期で手元の入居者と、送信待ちかどうかを見て突き合わせる');
  ok(/if\(_psm&&!_psSrvHas\)_psHealList\.push\(r\)/.test(SRC)&&/padSetHeal\(_psHealList\)/.test(SRC),'サーバーに値が無く手元にある分は、同期の後で送り直す');
  ok(/if\(r\.padSet!==undefined&&typeof parsePadSet==='function'\)\{var _pp=parsePadSet\(r\.padSet\);if\(_pp\)r\.padSet=_pp;else delete r\.padSet\}/.test(SRC),'サーバーの値は手元が無い入居者でも必ず正規化する');
  sb.apiUrl='https://example.invalid/a';
  sb.padSetNoteSrv({padSetVer:1});ok(sb.padSetSrvOk()===true,'padSetVer:1 を見たら対応済み');
  sb.apiUrl='https://example.invalid/b';ok(sb.padSetSrvOk()===false,'接続先を変えたら引き継がない');
  sb.padSetNoteSrv({});ok(sb.padSetSrvOk()===false,'旧GAS（宣言なし）は未対応');
})();

head('7. アプリ: 入居者の保存は padSet を消さない・変えた時だけ専用の送信');
(function(){
  const f=X.fn('saveRes');
  ok(/r\.cfg=cfgOv;else delete r\.cfg/.test(f)&&!/delete r\.padSet/.test(f),'しきい値の作り直しは cfg だけ（padSet には触らない）');
  ok(/if\(resObj&&_psChanged\)resObj\.padSet=\{at:Date\.now\(\),day:_psNew\.day,night:_psNew\.night\}/.test(f),'変えた時だけ at を付けて入れる');
  ok(/apiPush\('saveRes',\{resident:resObj\}\);\s*if\(resObj&&_psChanged\)\{apiPush\('savePadSet'/.test(f),'送る順は saveRes → savePadSet（新しい入居者は行ができてから通る）');
  ok(/psEditLoad\(r\);/.test(X.fn('editRes'))&&/psEditLoad\(null\);/.test(SRC),'編集・追加を開く時に読み込む');
  ok(/function editRes\(id\)\{if\(hbFieldDeny\(\)\)return;/.test(SRC),'現場用の端末では入居者の編集（品目の設定）を開かない');
})();

head('8. アプリ: その方の使用品をタップして記録・どこまで交換したか');
(function(){
  const res={id:1,padSet:{at:1,day:[{n:'テープ式おむつ M',l:'外'},{n:'尿取りパッド 昼用',l:'内'}],night:[]}};
  const sb=appSandbox([res]);
  sb._padMine=sb.padSetFor(res,at(10)).list;
  const btn=a=>({target:{closest:()=>({dataset:a})}});
  sb.padMineClick(btn({i:'1'}));
  ok(JSON.stringify(sb.ci.pads)==='{"尿取りパッド 昼用":1}','品目のボタンを押すと1枚として入る',sb.ci.pads);
  sb.padMineClick(btn({i:'1'}));
  ok(Object.keys(sb.ci.pads).length===0,'もう一度押すと外れる');
  sb.padMineClick(btn({q:'all'}));
  ok(sb.ci.pads['テープ式おむつ M']===1&&sb.ci.pads['尿取りパッド 昼用']===1,'全部交換');
  sb.padMineClick(btn({q:'in'}));
  ok(!sb.ci.pads['テープ式おむつ M']&&sb.ci.pads['尿取りパッド 昼用']===1,'内側だけ（外側は外す）');
  const d=(()=>{const x=at(10);const p=n=>('0'+n).slice(-2);return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate())})();
  const base={residentId:1,date:d,time:'10:00',datetime:d+'T10:00'};
  ok(sb.padScopeText(Object.assign({pads:'{"テープ式おむつ M":1,"尿取りパッド 昼用":1}'},base))==='全部交換（テープ式おむつ M 1枚・尿取りパッド 昼用 1枚）','全部の時は「全部交換」');
  ok(sb.padScopeText(Object.assign({pads:'{"尿取りパッド 昼用":1}'},base))==='内側だけ交換（尿取りパッド 昼用 1枚）','内側だけの時は「内側だけ交換」');
  ok(sb.padScopeText(Object.assign({pads:'{"フラット":2}'},base))==='フラット 2枚','ふだんと違う品目はそのまま');
  ok(sb.padScopeText(Object.assign({pads:''},base))==='','交換なしは空');
})();

head('8b. 送信の本文（apiPost）を通して実物の GAS へ（反証レビューの指摘・2026-10-19）');
(function(){
  const m=/body:JSON\.stringify\((\{action:action,[^}]*\})\)/.exec(X.fn('apiPost'));
  ok(!!m,'apiPost の本文の組み立て式を取り出せる');
  if(!m)return;
  const build=new Function('action','data','apiToken','return JSON.stringify('+m[1]+')');
  const sh=resSheet();
  const ctx=makeGasCtx(GAS,sh,{writable:true});
  const ps={at:1500,day:[{n:'テープ式おむつ M',l:'外'}],night:[]};
  const body=JSON.parse(build('savePadSet',{id:1,padSet:ps},'hb-aikotoba-kakuu'));
  ok(body.padSet&&body.padSet.day.length===1,'本文に padSet が載る',body);
  const r=JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).getContent());
  ok(r.ok===true&&JSON.parse(sh[1][sh[0].indexOf('padSet')]).day[0].n==='テープ式おむつ M','実際の送信の形で GAS に保存できる',r);
  /* 端末の時計が進んでいても、サーバーの時刻より先の at は付けない */
  const far=Date.now()+86400000*30;
  const b2=JSON.parse(build('savePadSet',{id:2,padSet:{at:far,day:[],night:[]}},'hb-aikotoba-kakuu'));
  JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(b2)}}).getContent());
  const s2=JSON.parse(sh[2][sh[0].indexOf('padSet')]);
  ok(s2.at<=Date.now()+1000,'進んだ時計の at はサーバーの時刻に下げて書く',s2.at);
  /* 見出しの大小が違っても端末には padSet で届く */
  const sh3=resSheet();sh3[0].push('PADSET');sh3[1][10]=JSON.stringify(ps);
  const ctx3=makeGasCtx(GAS,sh3,{writable:true});
  const rows=ctx3.readSheet_('Residents',ctx3.RES_DEFAULT_HEADERS||['id']);
  ok(rows[0].padSet===JSON.stringify(ps)&&rows[0].PADSET===undefined,'見出しが PADSET でもキーは padSet にそろえる',Object.keys(rows[0]));
})();

head('9. 画面の作法');
(function(){
  ok(/class="rt-pad" title="'\+escapeHtmlText\(tx\)\+'">🩲 /.test(X.fn('renderResTiles')),'タイルに使用品を1行で出す');
  ok(/padSetHistHtml\(rid\)\+stoolCalHtml/.test(SRC),'履歴の上部に使用品');
  ok(/escapeHtmlText\(padScopeText\(r\)\)/.test(SRC),'記録の詳細に「どこまで交換したか」');
  ok(/\.pm-b\{flex:1 1 200px;min-height:56px/.test(HTML)&&/\.ps-lay,\.ps-del\{min-width:48px;min-height:44px/.test(HTML),'ボタンは手袋でも押せる大きさ（56px・44px 以上）');
  ok(!/onclick=/.test(X.fn('renderPadCard')+X.fn('psEditRender')),'インラインのイベント属性を書かない（CSP）');
  ok(/html\.night \.ps-tab/.test(HTML)&&/html\.night \.pm-b\.on/.test(HTML),'夜間の配色');
  const pe=X.fn('psEditRender');
  ok(/escapeHtmlText\(x\.n\)/.test(pe)&&/escapeHtmlText\(k\)/.test(pe),'品目名はエスケープする');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
