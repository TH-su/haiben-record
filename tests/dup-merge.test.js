/* ══════════════════════════════════════════════════════════════════════
   同じ方が2行ある（重複）を1つにまとめる（2026-11-11）の検証ハーネス
   実行:  node tests/dup-merge.test.js
   ★実物のソース（haiben-record.html・gas/haiben-api.gs）をそのまま評価する。判定ロジックを写経しない。
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

function app(residents,records){
  const store={},pushed=[];
  const sb={console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,RegExp,
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem(k,v){store[k]=String(v)},removeItem(k){delete store[k]}}};
  vm.createContext(sb);
  const fns=['toNum','isValidRes','_normName','_normNameX','_isStaffRes','isUserRes','isUserRec',
    'hbMergedInto','hbMergeTarget','hbMergedHeal','hbDupGroups','_hbMergeBakRead','_hbMergeBakWrite','hbMergeDupRows','hbUnmergeRow'];
  const vars=['HB_MERGE_BAK_KEY','SYS_STAFF_ROOM','SYS_STAFF_ROOM_LEGACY','LEGACY_SYS_RID','LEGACY_SYS_NAME_PREFIX','SYS_STAFF_SNAPSHOT_ID','SYS_STAFF_SNAPSHOT_MARKER'];
  const nm=/var _NAMEX_MAP=\{[\s\S]*?\};/.exec(SRC)[0];
  vm.runInContext([nm].concat(vars.map(v=>X.varDecl(v))).concat(fns.map(n=>X.fn(n))).join('\n'),sb);
  sb.D={residents:residents,records:records||[],cfg:{}};
  sb._recIdx=null;sb._invalidateLinkIdx=()=>{};sb.save=()=>{sb._saved=(sb._saved||0)+1};
  sb.showToast=m=>{sb._toast=m};
  sb.apiPush=(a,d)=>pushed.push([a,JSON.parse(JSON.stringify(d))]);
  sb.pushed=pushed;sb.store=store;
  return sb;
}
function rec(id,rid,createdAt){return{id:id,residentId:rid,date:'2026-11-01',time:'10:00',type:'urine',createdAt:createdAt||'2026-11-01T01:00:00.000Z'}}
function base(){
  return [
    {id:10,name:'入居者 A',room:'201',active:true,hidden:false},
    {id:36,name:'入居者 B',room:'210',active:true,hidden:false},          // 記録0件・表示中
    {id:80,name:'入居者　B',room:'210',active:true,hidden:true},          // 記録あり・非表示（全角の空白）
    {id:34,name:'入居者 C',room:'208',active:true,hidden:true},
    {id:76,name:'入居者 C',room:'208',active:true,hidden:true,masterId:'M140'},
    {id:50,name:'入居者 D',room:'101',active:true,hidden:false},
    {id:51,name:'入居者 D',room:'102',active:true,hidden:false}            // 居室が違う
  ];
}
function recs(){return [rec('r1',80),rec('r2',80),rec('r3',80),rec('r4',10)]}

head('1. 重複の組を見つけ、残す行のおすすめを決める');
(function(){
  const sb=app(base(),recs());
  const gs=sb.hbDupGroups();
  ok(gs.length===3,'同じ氏名（空白の全角・半角の違いを含む）の組が3つ',gs.map(g=>g.rows.map(x=>x.r.id)));
  const b=gs.find(g=>g.rows.some(x=>x.r.id===80));
  ok(b&&b.rows[0].r.id===80&&b.rows[0].n===3,'記録の多い方（非表示でも）を残すおすすめにする',b&&b.rows.map(x=>[x.r.id,x.n]));
  const c=gs.find(g=>g.rows.some(x=>x.r.id===76));
  ok(c&&c.rows[0].r.id===76,'記録が同じなら入居者マスタと結ばれている方を残す');
  const d=gs.find(g=>g.rows.some(x=>x.r.id===50));
  ok(d&&d.sameRoom===false,'居室が違う組は印を付ける（おまとめの一括に入れない）');
  ok(!gs.some(g=>g.rows.some(x=>x.r.id===10)),'1行だけの方は出ない');
})();

head('2. まとめる: 記録を付け替え、もう一方は消さずに隠す');
(function(){
  const R=base(),sb=app(R,recs());
  const r=sb.hbMergeDupRows(80,[36]);
  ok(r===true,'まとめが通る');
  ok(sb.D.residents.length===7,'行は1つも消さない');
  const k=sb.D.residents.find(x=>x.id===80),d=sb.D.residents.find(x=>x.id===36);
  ok(k.hidden===false,'どちらかが表示中だったので、残す行を表示にする');
  ok(d.cfg.mergedInto===80&&d.active===false&&d.hidden===true,'もう一方に印を付け、在籍を外し非表示にする',d);
  ok(sb.isUserRes(d)===false&&sb.isUserRes(k)===true,'印のある行はどこにも出ない（isUserRes が外す）');
  ok(sb.D.records.filter(x=>x.residentId===80).length===3,'記録はそのまま残す行に（件数が変わらない）');
  ok(sb.pushed.some(p=>p[0]==='saveRes'&&p[1].resident.id===36&&p[1].resident.cfg.mergedInto===80)&&sb.pushed.some(p=>p[0]==='saveRes'&&p[1].resident.id===80),'両方の行をサーバーへ送る');
  const bak=JSON.parse(sb.store['hbcr_merge_bak']);
  ok(bak.length===1&&bak[0].dups[0].id===36&&bak[0].dups[0].hidden===false,'まとめる前の中身を控える',bak);
  ok(sb.hbDupGroups().every(g=>!g.rows.some(x=>x.r.id===80)),'まとめた後は重複の組に出ない');
})();

head('3. 記録のある行をまとめる側にした時は、記録を付け替えて送る');
(function(){
  const sb=app(base(),recs());
  sb.hbMergeDupRows(36,[80]);
  ok(sb.D.records.filter(x=>x.residentId===36).length===3&&!sb.D.records.some(x=>x.residentId===80),'3件とも残す行へ付け替える');
  ok(sb.pushed.filter(p=>p[0]==='saveRecord').length===3,'付け替えた記録を送る');
  ok(sb.D.records.length===4,'記録を1件も消さない');
})();

head('4. 入居者マスタとの紐づけは残す行へ移す');
(function(){
  const sb=app(base(),recs());
  sb.hbMergeDupRows(34,[76]);
  const k=sb.D.residents.find(x=>x.id===34),d=sb.D.residents.find(x=>x.id===76);
  ok(k.masterId==='M140'&&d.masterId===undefined,'紐づけを残す行へ移す',[k,d]);
  ok(k.hidden===true,'両方とも非表示だった時は、残す行も非表示のまま');
})();

head('5. ほかの端末（hbMergedHeal）: 紐づけを移し、まとめた後に付いた記録だけを付け替える');
(function(){
  const at=Date.parse('2026-11-11T09:00:00.000Z');
  const R=base();
  R.find(x=>x.id===36).cfg={mergedInto:80,mergedAt:at};R.find(x=>x.id===36).masterId='M142';
  const rs=[rec('old',36,'2026-11-10T00:00:00.000Z'),rec('new',36,'2026-11-11T10:00:00.000Z')];
  const sb=app(R,rs);
  ok(sb.hbMergedHeal()===true,'変えたことを返す');
  ok(sb.D.residents.find(x=>x.id===80).masterId==='M142'&&sb.D.residents.find(x=>x.id===36).masterId===undefined,'紐づけを残す行へ移す');
  ok(rs[1].residentId===80&&rs[0].residentId===36,'まとめた後に入った記録だけを付け替える（前の分はまとめた端末が送っている）');
  ok(sb.pushed.length===1&&sb.pushed[0][1].record.id==='new','付け替えた1件だけを送る');
  ok(sb.hbMergedHeal()===false,'2回目は何もしない');
})();

head('6. 印の輪・相手の無い印では何もしない');
(function(){
  const R=[{id:1,name:'X',room:'1',active:true,cfg:{mergedInto:2}},{id:2,name:'X',room:'1',active:true,cfg:{mergedInto:1}},{id:3,name:'Y',room:'2',active:true,cfg:{mergedInto:99},masterId:'M1'}];
  const sb=app(R,[rec('a',1,'2030-01-01T00:00:00.000Z')]);
  sb.hbMergedHeal();
  ok(sb.D.records[0].residentId===1&&R[2].masterId==='M1'&&!sb.pushed.length,'壊れた印では記録も紐づけも動かさない');
})();

head('7. 取り消す: 控えから元の2行に戻す');
(function(){
  const sb=app(base(),recs());
  sb.hbMergeDupRows(36,[80]);
  ok(sb.hbUnmergeRow(80)===true,'取り消しが通る');
  const d=sb.D.residents.find(x=>x.id===80),k=sb.D.residents.find(x=>x.id===36);
  ok(d.cfg===undefined&&d.active===true&&d.hidden===true,'印を外し、在籍・非表示を元に戻す',d);
  ok(sb.D.records.filter(x=>x.residentId===80).length===3,'付け替えた記録を元の行へ戻す');
  ok(k.hidden===false,'残した行の表示も元どおり');
})();

head('8. GAS: 印（cfg.mergedInto）がサーバーを往復しても残る');
(function(){
  const sh=[['id','name','yomi','room','gender','active','hidden','laxNote','cfg','schedule','padSet'],
    [36,'入居者 B','','210','女性',true,false,'','','','']];
  const ctx=makeGasCtx(GAS,sh,{writable:true});
  const post=b=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(b)}}).getContent());
  const r=post({action:'saveRes',resident:{id:36,name:'入居者 B',room:'210',active:false,hidden:true,cfg:{mergedInto:80,mergedAt:5}}});
  ok(r.ok===true,'書き込みが通る',r);
  ok(sh[1][5]===false&&sh[1][6]===true&&JSON.parse(sh[1][8]).mergedInto===80,'在籍・非表示・印が行に入る',sh[1]);
  ok(sh.length===2,'行は増えも減りもしない');
})();

console.log('\n合計: '+pass+' 件成功 / '+fail+' 件失敗');
process.exit(fail?1:0);
