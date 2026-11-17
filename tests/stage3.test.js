/* ══════════════════════════════════════════════════════════════════════
   第3段（2026-10-16）の検証ハーネス: 下剤の反応・要注意だけ・排便カレンダー・時系列の全体表示
   実行:  node tests/stage3.test.js
   ★実物のソース（haiben-record.html）をそのまま評価する。判定ロジックを写経しない。
   ★記録はすべて合成データ。実在の氏名・記録は使わない。
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

function ymd(off){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+off);
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
/* 今からの相対時間（時間）で記録を作る */
let _seq=0;
function at(hoursAgo,type,extra){
  const t=new Date(Date.now()-hoursAgo*36e5);
  const p=n=>('0'+n).slice(-2);
  const date=t.getFullYear()+'-'+p(t.getMonth()+1)+'-'+p(t.getDate()), time=p(t.getHours())+':'+p(t.getMinutes());
  return Object.assign({id:'r'+(++_seq),residentId:1,date,time,datetime:date+'T'+time,tsUTC:new Date(date+'T'+time).getTime(),type},extra||{});
}
function makeSandbox(records,resident){
  const sb={console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,RegExp,
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
  vm.createContext(sb);
  const fns=['stoolResetSeries','lastR','elH','_freezeIfHosp','badgeCls','resCfg','fmtDur','fmtMD','fmtCons','today','dayDiff','escapeHtmlText',
    '_evMs','laxReaction','laxReactHtml','isAttnRes','stoolCalHtml','laxHistHtml','_keepCap','_localKeepDays','_hbKeepFrom','toNum'];
  vm.runInContext([X.varDecl('STOOL_SMALL_N'),X.varDecl('BAK_OFF_KEY'),X.varDecl('LAX_REACT_H'),X.varDecl('SC_COLOR')]
    .concat(fns.map(n=>X.fn(n))).join('\n'),sb);
  const res=Object.assign({id:1,name:'入居者A',room:'101',cfg:{}},resident||{});
  sb.D={records,residents:[res],cfg:{urineWarnH:6,urineDangerH:8,stoolWarnD:2,stoolDangerD:3,localKeepDays:180}};
  const sorted=records.slice().sort((a,b)=>(a.datetime||'').localeCompare(b.datetime||''));
  sb.recsByRes=rid=>sorted.filter(r=>r.residentId===rid);
  sb.isFullHospDay=()=>false;
  sb.tlOvdForRes=()=>sb.__ovd||[];
  sb._tlNowMin=()=>600;
  return sb;
}

head('1. 下剤の反応（24時間・少量も数える）');
(function(){
  const lx=at(30,'laxative',{medicine:'センノシド',tablets:'2'});
  const sb=makeSandbox([lx,at(20,'stool',{stoolAmt:'少量',consistency:'普通'})]);
  const x=sb.laxReaction(lx);
  ok(x.st==='ok'&&Math.abs(x.h-10)<0.05,'10時間後の少量の排便を反応とする',x);
  ok(/10時間後に排便/.test(sb.laxReactHtml(lx)),'表示は「10時間後に排便」',sb.laxReactHtml(lx));

  const lx2=at(30,'laxative');
  const sb2=makeSandbox([lx2,at(5,'stool',{stoolAmt:'中等量'})]);
  ok(sb2.laxReaction(lx2).st==='none','25時間後の排便は反応に数えない（24時間を過ぎたら反応なし）',sb2.laxReaction(lx2));

  const lx3=at(8,'laxative');
  const sb3=makeSandbox([lx3]);
  const x3=sb3.laxReaction(lx3);
  ok(x3.st==='wait'&&Math.abs(x3.h-8)<0.05,'24時間たっていなければ待機中（経過8時間）',x3);

  const lx4=at(10,'laxative');
  const sb4=makeSandbox([at(12,'stool',{stoolAmt:'多量'}),lx4]);
  ok(sb4.laxReaction(lx4).st==='wait','下剤より前の排便は反応に数えない');

  const lx5=at(30,'laxative');
  const sb5=makeSandbox([lx5,at(25,'both',{stoolAmt:'中等量'}),at(20,'stool',{})]);
  ok(Math.abs(sb5.laxReaction(lx5).h-5)<0.05,'排尿＋排便（both）も排便として数え、最初の1回を採る');
  ok(/<script>/.test(sb5.laxHistHtml(1))===false,'履歴の下剤欄にスクリプトが混ざらない');
  const sb6=makeSandbox([Object.assign(at(30,'laxative'),{medicine:'<img src=x onerror=alert(1)>'}),at(20,'stool',{})]);
  ok(!/<img/.test(sb6.laxHistHtml(1))&&/&lt;img/.test(sb6.laxHistHtml(1)),'薬名はエスケープする');
  ok(/1回中1回反応/.test(sb5.laxHistHtml(1)),'薬ごとのまとめ（1回中1回反応）',sb5.laxHistHtml(1).slice(0,300));
})();

head('2. 要注意だけ');
(function(){
  const okRes=makeSandbox([at(2,'urine'),at(10,'stool',{stoolAmt:'中等量'})]);
  ok(okRes.isAttnRes(okRes.D.residents[0],okRes.today())===false,'排尿2時間前・排便10時間前なら要注意ではない');
  const uW=makeSandbox([at(7,'urine'),at(10,'stool',{stoolAmt:'中等量'})]);
  ok(uW.isAttnRes(uW.D.residents[0],uW.today())===true,'排尿7時間（黄）なら要注意');
  const sNg=makeSandbox([at(1,'urine'),at(80,'stool',{stoolAmt:'中等量'})]);
  ok(sNg.isAttnRes(sNg.D.residents[0],sNg.today())===true,'排便3日以上（赤）なら要注意');
  const small=makeSandbox([at(1,'urine'),at(80,'stool',{stoolAmt:'中等量'}),at(30,'stool',{stoolAmt:'少量'}),at(20,'stool',{stoolAmt:'少量'}),at(10,'stool',{stoolAmt:'少量'})]);
  ok(small.isAttnRes(small.D.residents[0],small.today())===false,'少量3回（48時間以内）で1回分＝要注意から外れる');
  const ovd=makeSandbox([at(1,'urine'),at(10,'stool',{stoolAmt:'中等量'})]);ovd.__ovd=[{min:540}];
  ok(ovd.isAttnRes(ovd.D.residents[0],ovd.today())===true,'今日の予定を過ぎて未記録なら要注意');
  ok(ovd.isAttnRes(ovd.D.residents[0],ymd(-1))===false,'過去の日の表示では予定の超過で残さない');
})();

head('3. 排便カレンダー');
(function(){
  const recs=[at(24*10,'stool',{stoolAmt:'中等量',consistency:'普通',date:ymd(-10),datetime:ymd(-10)+'T09:00',tsUTC:undefined}),
              Object.assign(at(0,'laxative',{medicine:'センノシド'}),{date:ymd(0)})];
  const sb=makeSandbox(recs);
  const h=sb.stoolCalHtml(1);
  ok(/排便カレンダー/.test(h),'見出しが出る');
  ok((h.match(/class="sc-day sc-ng/g)||[]).length>=7,'排便1回分から3日以上の日は赤の地（10日前から今日まで）',(h.match(/sc-ng/g)||[]).length);
  ok(/sc-day sc-w/.test(h),'2日目は黄の地');
  ok(/💊/.test(h),'下剤の日に💊');
  ok(/sc-today/.test(h),'今日に印');
  ok(/#4caf50/.test(h),'普通の便は緑の点');
})();

head('4. 時系列の全体表示・実装の作法');
(function(){
  const fn=X.fn('renderTL');
  ok(/tlCompact\)\{h1\+='<th rowspan="2" class="hr-top">'/.test(fn),'全体表示の見出しは時ごとの th.hr-top（現在時刻の線の位置合わせがそのまま効く）');
  ok(/data-hour="'\+h\+'"/.test(fn),'全体表示のセルは時（data-hour）を持つ');
  ok(/hourMode\?\(h===parseInt\(td\.dataset\.hour\)\)/.test(fn),'押した時は、その時台の記録をまとめて開く');
  ok(/TL_COMPACT_KEY='hbcr_tl_compact'/.test(SRC)&&/ONLY_ATTN_KEY='hbcr_only_attn'/.test(SRC),'切替の状態は端末に覚える（UI状態だけ）');
  ok((SRC.match(/&&\(!onlyAttn\|\|isAttnRes\(r,date\)\)/g)||[]).length===2,'一覧と時系列の両方で要注意だけに絞れる');
  const rf=X.fn('tlOvdRefresh');
  ok(/set\[hh\*2\]\|\|set\[hh\*2\+1\]/.test(rf),'1分ごとの更新は、全体表示のセルを時台の2枠で判定する（:30 の「未」が消えない）');
  ok(/onlyAttn&&isToday/.test(rf)&&/tlRenderKeepScroll\(\)/.test(rf),'要注意だけの時、新しく予定を過ぎた人が居れば描き直す');
  ok(/openSlot=\(!schSet\[a\]&&schSet\[b\]\)\?b:a/.test(fn),'予定が :30 だけの空の枠は :30 で開く');
  ok(/\.tl-t\.tl-compact \.tl-c\.sched::before\{width:18px;height:18px/.test(HTML),'全体表示では予定の輪を細い列に収める');
  ok(/if\(td\.dataset\.adm\)return;/.test(rf)&&(fn.match(/data-adm="1"/g)||[]).length===2,'入院のコマには1分ごとの更新でも「未」を付けない');
  ok(/@media screen and \(max-width:599\.98px\)\{#btnNight\{display:none\}\}/.test(HTML)&&/id="btnNightNav"/.test(HTML),'スマホ幅では夜間の切替をヘッダに置かない（ヘッダの高さを変えない）');
  ok(/\$\$\('\.bnav button\[data-sc\]'\)/.test(SRC),'下部ナビの画面切替は data-sc のあるボタンだけ（夜間の切替で画面が変わらない）');
})();

head('5. 全体表示の直近24時間の並び（2026-11-17 本人指示・代表者の決定「直近24時間に変える」）');
(function(){
  const sb={escapeHtmlText:s=>String(s),fmtMD:d=>d};vm.createContext(sb);
  vm.runInContext(['var TL_ROLL_BEFORE=16;',X.fn('tlRollStart'),X.fn('tlRollCols'),X.fn('_tlAddDay'),X.fn('tlHdLab')].join('\n'),sb);
  const T='2026-03-01';
  ok(sb.tlRollStart(false,T,T,18,false)===null,'30分の表示では並べ替えない');
  ok(sb.tlRollStart(true,'2026-02-28',T,18,false)===null,'今日以外の日付は0〜23時のまま');
  ok(sb.tlRollStart(true,T,T,18,true)===null,'印刷の間は0〜23時のまま');
  [0,5,15,16,18,23].forEach(function(H){
    const st=sb.tlRollStart(true,T,T,H,false),c=sb.tlRollCols(T,st);
    const k=c.findIndex(function(x){return x.d===T&&x.h===H});
    const cont=c.every(function(x,i){if(!i)return true;const p=c[i-1];return (p.h+1)%24===x.h&&(x.h===0?x.d!==p.d:x.d===p.d)});
    ok(c.length===24&&k===16&&cont,H+'時: 今の時は左から17列目・24列が1時間ずつ続き、日付は0時で変わる',{k:k,first:c[0],last:c[23]});
  });
  const c0=sb.tlRollCols(T,sb.tlRollStart(true,T,T,0,false));
  ok(c0[0].d==='2026-02-28'&&c0[0].h===8&&c0[0].off===-1&&c0[23].d===T&&c0[23].h===7,'0時: 前日8時〜今日7時（月末をまたいでも前日の日付）',[c0[0],c0[23]]);
  const c23=sb.tlRollCols(T,sb.tlRollStart(true,T,T,23,false));
  ok(c23[0].d===T&&c23[0].h===7&&c23[23].d==='2026-03-02'&&c23[23].h===6&&c23[23].off===1,'23時: 今日7時〜翌日6時',[c23[0],c23[23]]);
  const c18=sb.tlRollCols(T,null);
  ok(c18.every(function(x,i){return x.d===T&&x.h===i&&x.off===0}),'並べ替えない時は今までどおり今日の0〜23時');
  ok(/class="hr-mid"/.test(sb.tlHdLab(c23,17))&&/翌日/.test(sb.tlHdLab(c23,17))&&!/翌日|前日|hr-mid/.test(sb.tlHdLab(c23,16)),'日付の切れ目の列にだけ切れ目の印と「翌日」の札を付ける');
  ok(/前日/.test(sb.tlHdLab(c0,0))&&!/前日/.test(sb.tlHdLab(c0,1))&&!/hr-mid/.test(sb.tlHdLab(c0,0)),'前日の列の始まりにだけ「前日」の札（左端に切れ目の印は付けない）');
  ok(/今日/.test(sb.tlHdLab(c0,16))&&/hr-mid/.test(sb.tlHdLab(c0,16))&&!/今日/.test(sb.tlHdLab(c23,0))&&!/今日|前日|翌日/.test(sb.tlHdLab(c18,0)),'前日の後の今日の0時にだけ「今日」の札（今日から始まる並び・並べ替えない時は札なし）');
  const fn=X.fn('renderTL'),rf=X.fn('tlOvdRefresh'),np=X.fn('tlNowPlace');
  ok(/var oOn=!cc\.off&&/.test(fn)&&/if\(td\.dataset\.date\)return;/.test(rf),'前日・翌日の列には描画でも1分ごとの更新でも「未」を付けない');
  ok(/isSlotInHospPeriod\(re,cd,a\)/.test(fn)&&/getHospEventsOnDate\(re,d\)/.test(fn)&&/recsByResDate\(re\.id,d\)/.test(fn),'前日・翌日の列はその日の記録と入院で描く');
  ok(/td\.dataset\.date\|\|\$\('tlDate'\)/.test(fn)&&/openSchedCellModal\(rid,slot,td\.dataset\.date\?\{date:td\.dataset\.date\}/.test(fn),'押した時は、その列の日付の記録・予定を開く');
  ok(/data-roll/.test(np)&&/n\.getHours\(\)-rs/.test(np),'現在時刻の線は描いた並び（data-roll）から列を決める');
  ok(/Math\.floor\(o\.min\/60\)<tlRs\)tlOvdHid\+\+/.test(fn)&&/Math\.floor\(o\.min\/60\)<rs\)hid\+\+/.test(rf)&&/tlOvdSummary\(isToday,n,hid\)/.test(rf),'表の左から外れた今日の超過は件数に残し、外れた数を数える（反証レビュー）');
  const sm=X.fn('tlOvdSummary');
  ok(/表の左の外/.test(sm)&&/'⚠️ 予定を過ぎて未記録 '\+n\+'件'/.test(sm),'要約は今日1日分の件数のまま、外れた分を書き添える');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
