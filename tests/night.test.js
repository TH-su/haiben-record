/* ══════════════════════════════════════════════════════════════════════
   夜間の配色（2026-10-16）の検証ハーネス
   実行:  node tests/night.test.js
   ★実物のソース（haiben-record.html）から関数を切り出して評価する。判定ロジックを写経しない。
   ★HAIBEN_HTML で差し替えられるのは変異テスト（壊した写しで落ちることの確認）用。
   確かめること:
     1. 自動の時間帯（20:59 昼／21:00 夜／6:59 夜／7:00 昼）
     2. 次の切替時刻（7:00 か 21:00）
     3. 手動の選択が次の切替時刻まで続き、過ぎたら自動に戻る
     4. 壊れた保存値・期限切れ・遠すぎる期限は自動扱い
     5. CSS: html.night の規則はすべて @media screen の中＝印刷には効かない（静的検査）
     6. 切替ボタン: インラインのイベント属性なし・aria-label/title あり・44×44
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const {makeExtractor}=require('./_extract');
const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();
const X=makeExtractor(SRC);

let fail=0,pass=0;
function ok(c,m,extra){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m+(extra!==undefined?'  → '+JSON.stringify(extra):''))}}
function head(t){console.log('\n─── '+t+' ───')}

/* 実物の関数を切り出して箱の中で評価する */
const sb={console:{log(){},warn(){},error(){}},Date,Math,Number,String,JSON,isFinite,Object};
vm.createContext(sb);
vm.runInContext([X.varDecl('STAFF_DAY_START_H'),X.varDecl('STAFF_DAY_END_H')]
  .concat(['isStaffDayTime','hbNightAuto','hbNightNextSwitch','hbNightParse','hbNightState','hbNightFlip'].map(n=>X.fn(n)))
  .concat(['this.F={isStaffDayTime,hbNightAuto,hbNightNextSwitch,hbNightParse,hbNightState,hbNightFlip};']).join('\n'),sb);
const F=sb.F;
/* 端末の時計（ローカル時刻）で 2026-10-16 の h:m を作る */
const at=(h,m,dayOff)=>new Date(2026,9,16+(dayOff||0),h,m||0,0,0);
const fmt=ms=>{const d=new Date(ms);return (d.getMonth()+1)+'/'+d.getDate()+' '+d.getHours()+':'+('0'+d.getMinutes()).slice(-2)};

head('1 自動の時間帯（記録者の自動クリアと同じ 21:00〜翌7:00）');
ok(F.hbNightAuto(at(20,59))===false,'20:59 は昼');
ok(F.hbNightAuto(at(21,0))===true,'21:00 は夜');
ok(F.hbNightAuto(at(6,59))===true,'6:59 は夜');
ok(F.hbNightAuto(at(7,0))===false,'7:00 は昼');
ok(F.hbNightAuto(at(0,0))===true&&F.hbNightAuto(at(12,0))===false,'0:00 は夜・12:00 は昼');
ok([0,3,6,7,12,20,21,23].every(h=>F.hbNightAuto(at(h,30))===!F.isStaffDayTime(at(h,30))),'記録者の自動クリアの判定（isStaffDayTime）と必ず逆になる');

head('2 次の切替時刻');
ok(fmt(F.hbNightNextSwitch(at(20,59)))==='10/16 21:00','20:59 → 同じ日の 21:00',fmt(F.hbNightNextSwitch(at(20,59))));
ok(fmt(F.hbNightNextSwitch(at(21,0)))==='10/17 7:00','21:00 → 翌日の 7:00',fmt(F.hbNightNextSwitch(at(21,0))));
ok(fmt(F.hbNightNextSwitch(at(23,30)))==='10/17 7:00','23:30 → 翌日の 7:00');
ok(fmt(F.hbNightNextSwitch(at(0,10)))==='10/16 7:00','0:10 → 同じ日の 7:00');
ok(fmt(F.hbNightNextSwitch(at(6,59)))==='10/16 7:00','6:59 → 同じ日の 7:00');
ok(fmt(F.hbNightNextSwitch(at(7,0)))==='10/16 21:00','7:00 → 同じ日の 21:00');

head('3 手動の選択は次の切替時刻まで続き、過ぎたら自動に戻る');
{
  // 夜 22:00 に押す → 昼の配色、翌 7:00 まで
  const raw=F.hbNightFlip(at(22,0),null);
  const o=JSON.parse(raw);
  ok(o.mode==='off'&&fmt(o.until)==='10/17 7:00','22:00（自動＝夜）に押すと「昼の配色・翌7:00まで」を保存',raw);
  ok(F.hbNightState(at(22,0),raw).on===false&&F.hbNightState(at(22,0),raw).manual===true,'押した直後は昼の配色（手動）');
  ok(F.hbNightState(at(6,59,1),raw).on===false,'翌 6:59 も昼の配色のまま（手動が続く）');
  const s7=F.hbNightState(at(7,0,1),raw);
  ok(s7.manual===false&&s7.on===false,'翌 7:00 で自動に戻る（自動＝昼）',s7);
  ok(F.hbNightState(at(21,0,1),raw).on===true&&F.hbNightState(at(21,0,1),raw).manual===false,'翌日の 21:00 は自動で夜（前夜の手動は残らない）');
}
{
  // 昼 10:00 に押す → 夜の配色、21:00 まで
  const raw=F.hbNightFlip(at(10,0),null);
  const o=JSON.parse(raw);
  ok(o.mode==='on'&&fmt(o.until)==='10/16 21:00','10:00（自動＝昼）に押すと「夜の配色・21:00まで」を保存',raw);
  ok(F.hbNightState(at(20,59),raw).on===true&&F.hbNightState(at(20,59),raw).manual===true,'20:59 まで夜の配色（手動）');
  const s21=F.hbNightState(at(21,0),raw);
  ok(s21.manual===false&&s21.on===true,'21:00 で自動に戻る（自動＝夜）',s21);
  ok(F.hbNightState(at(7,0,1),raw).on===false,'翌 7:00 は自動で昼');
  // もう一度押すと自動と同じになる → 保存値を消す（null）
  ok(F.hbNightFlip(at(11,0),raw)===null,'手動中にもう一度押すと自動に戻す（保存値を消す）');
}
ok(F.hbNightState(at(21,0),null).on===true&&F.hbNightState(at(7,0),null).on===false,'保存値なしは自動');

head('4 壊れた保存値・使えない値は自動扱い');
{
  const now=at(22,0),okUntil=at(7,0,1).getTime();
  const bad=[
    ['壊れた JSON','{mode:'],
    ['null の JSON','null'],
    ['文字列の JSON','"on"'],
    ['数の JSON','1'],
    ['未知の mode',JSON.stringify({mode:'dark',until:okUntil})],
    ['mode なし',JSON.stringify({until:okUntil})],
    ['until が数でない',JSON.stringify({mode:'off',until:'あした'})],
    ['until なし',JSON.stringify({mode:'off'})],
    ['期限切れ（過去）',JSON.stringify({mode:'off',until:at(21,0).getTime()})],
    ['期限が遠すぎる（時計の巻き戻し等・3日後）',JSON.stringify({mode:'off',until:now.getTime()+3*864e5})],
    ['空文字',''],
  ];
  bad.forEach(([lbl,raw])=>{const s=F.hbNightState(now,raw);ok(s.manual===false&&s.on===true,lbl+' → 自動（22:00 なので夜）',s)});
  ok(F.hbNightParse(undefined,now.getTime())===null&&F.hbNightParse(123,now.getTime())===null,'文字列でない値 → 自動');
  ok(F.hbNightState(now,JSON.stringify({mode:'off',until:okUntil})).manual===true,'正しい値は手動として効く（対照）');
}

head('5 CSS: 夜間の上書きは画面だけ（@media print には効かない）');
const CSS=(HTML.match(/<style[^>]*>[\s\S]*?<\/style>/g)||[]).map(s=>s.replace(/^<style[^>]*>|<\/style>$/g,'')).join('\n');
/* コメントと文字列を飛ばしながら { } の入れ子を追い、各規則の「外側の @ 規則」の並びを集める */
function cssRules(css){
  css=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const out=[],stack=[];let buf='',i=0;
  while(i<css.length){
    const c=css[i];
    if(c==='"'||c==="'"){const q=c;let j=i+1;while(j<css.length&&css[j]!==q){if(css[j]==='\\')j++;j++}buf+=css.slice(i,j+1);i=j+1;continue}
    if(c==='{'){const pre=buf.trim();buf='';stack.push(pre);out.push({prelude:pre,ctx:stack.slice(0,-1)});i++;continue}
    if(c==='}'){stack.pop();buf='';i++;continue}
    if(c===';'){buf='';i++;continue}
    buf+=c;i++;
  }
  if(stack.length)throw new Error('CSS の { } が閉じていません');
  return out;
}
const rules=cssRules(CSS);
const nightRules=rules.filter(r=>/html\.night/.test(r.prelude));
ok(nightRules.length>=50,'html.night の規則がある（'+nightRules.length+'件）');
const outside=nightRules.filter(r=>!r.ctx.some(p=>/^@media\s+screen\s*$/i.test(p)));
ok(outside.length===0,'html.night の規則はすべて @media screen の中',outside.slice(0,3).map(r=>r.prelude));
const inPrint=nightRules.filter(r=>r.ctx.some(p=>/print/i.test(p)));
ok(inPrint.length===0,'@media print の中に html.night の規則が無い');
const printRules=rules.filter(r=>r.ctx.some(p=>/^@media\s+print/i.test(p)));
ok(printRules.length>0&&printRules.every(r=>!/night/.test(r.prelude)),'既存の @media print の規則に夜間の指定が混ざっていない（'+printRules.length+'件）');
const rootRule=rules.find(r=>r.prelude===':root'&&r.ctx.length===0);
ok(!!rootRule,'既定の :root（昼の配色）は @ 規則の外にある＝印刷は昼の配色');
ok(/html\.night\{[^}]*color-scheme:dark/.test(CSS.replace(/\s+/g,'')),'夜間は color-scheme:dark（select の一覧・日付の入力も暗くする）');
ok(/html\.night\{[^}]*--g0:#[0-9a-f]{6}[^}]*--g9:#[0-9a-f]{6}/.test(CSS.replace(/\s+/g,'')),'夜間で地（--g0）と文字（--g9）の変数を上書きしている');

head('6 切替ボタン');
const btn=(HTML.match(/<button[^>]*id="btnNight"[^>]*>[^<]*<\/button>/)||[''])[0];
ok(!!btn,'ヘッダに btnNight がある');
ok(!/\son[a-z]+=/i.test(btn),'インラインのイベント属性（onclick 等）が無い（CSP）');
ok(/aria-label="[^"]+"/.test(btn)&&/title="[^"]+"/.test(btn),'aria-label と title がある');
ok(/type="button"/.test(btn),'type="button"');
const hdrPart=HTML.slice(HTML.indexOf('<header class="hdr">'),HTML.indexOf('</header>'));
ok(hdrPart.indexOf('id="btnNight"')>0&&hdrPart.indexOf('id="btnNight"')<hdrPart.indexOf('id="hTime"'),'ヘッダの右側・時刻の隣にある');
ok(/\.hb-night-btn\{[^}]*min-width:44px[^}]*min-height:44px/.test(CSS),'押せる大きさ 44×44 以上');
ok(/getElementById\('btnNight'\)[\s\S]{0,40}addEventListener\('click',hbNightToggle\)/.test(SRC),'addEventListener で押した時の処理を付けている');
ok(/var NIGHT_KEY='hbcr_[a-z_]+'/.test(SRC),'保存のキーは hbcr_ で始まる');
ok(/setInterval\(hbNightApply,60\*1000\)/.test(SRC),'1分ごとに判定し直す');
/* 保存するのは UI 状態だけ（mode と until 以外を入れない） */
{
  const raw=F.hbNightFlip(at(10,0),null);
  ok(Object.keys(JSON.parse(raw)).sort().join(',')==='mode,until','保存する中身は mode と until だけ（個人情報なし）',raw);
}

console.log('\n────────── 合計: '+pass+' 件成功 / '+fail+' 件失敗 ──────────');
process.exit(fail?1:0);
