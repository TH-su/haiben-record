/* ══════════════════════════════════════════════════════════════════════
   過去3ヶ月の平均間隔（排尿・排便・下剤）の検証ハーネス（2026-09-14）
   実行:  node tests/interval-stats.test.js
   ──────────────────────────────────────────────────────────────────────
   ★実物のソース（haiben-record.html）をそのまま評価する。
     判定ロジックをテスト側に写経しない（写経すると本体を直してもテストが緑のままになる）。
   ★入居者・記録はすべて合成データ。実在の氏名・居室・記録は一切使わない。
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
function ok(c,m){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m)}}
function head(t){console.log('\n─── '+t+' ───')}
function near(a,b,tol){return typeof a==='number'&&!isNaN(a)&&Math.abs(a-b)<=(tol||1e-6)}

/* ════════ 合成データの生成 ════════
   日付は「今日からの相対日数」で作る。窓（92日）は実行日基準で動くため、
   固定日付を書くとテストが特定の日にだけ落ちる。 */
function ymd(offsetDays){
  const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+offsetDays);
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
}
let _seq=0;
/* 記録1件。dayOff=今日からの日数（負が過去）、hm='HH:MM' */
function rec(dayOff,hm,type,extra){
  const date=ymd(dayOff), datetime=date+'T'+hm;
  const r={id:'r'+(++_seq),residentId:'R1',date:date,time:hm,datetime:datetime,
    tsUTC:new Date(datetime).getTime(),type:type};
  if(extra)Object.keys(extra).forEach(function(k){r[k]=extra[k]});
  return r;
}
/* 本体の契約どおり datetime 昇順に並べて返す（recsByRes と同じ順序） */
function sortRecs(arr){return arr.slice().sort(function(a,b){
  return(a.datetime||'').localeCompare(b.datetime||'')})}

/* ════════ 本体の関数を切り出して走らせる砂場 ════════
   recsByRes / D だけをスタブにし、集計ロジックは実物をそのまま動かす。 */
function makeSandbox(records,resident){
  const sb={console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat};
  vm.createContext(sb);
  const fns=['stoolResetSeries','hospOverlaps','intervalStats','fmtDur','lastR','dateOff','today','_keepCap','_localKeepDays'];
  vm.runInContext([X.varDecl('STATS_GAP_H'),X.varDecl('STOOL_SMALL_N'),X.varDecl('BAK_OFF_KEY')].concat(fns.map(function(n){return X.fn(n)})).join('\n'),sb);
  sb.D={records:records,residents:[resident||{id:'R1'}],cfg:{localKeepDays:180}};
  const sorted=sortRecs(records);
  sb.recsByRes=function(rid){return sorted.filter(function(r){return r.residentId===rid})};
  sb.recsByResDate=function(rid,d){return sb.recsByRes(rid).filter(function(r){return r.date===d})};
  sb.isUserRec=function(){return true};
  return sb;
}

/* ════════════════════════════════════════════════════════════════
   1. 平均排尿間隔 — 等間隔なら平均もその値
   ════════════════════════════════════════════════════════════════ */
head('1. 平均排尿間隔');
(function(){
  // 3日間、毎日 06:00 / 10:00 / 14:00 / 18:00（＝4時間間隔）
  const recs=[];
  [-3,-2,-1].forEach(function(d){
    ['06:00','10:00','14:00','18:00'].forEach(function(t){recs.push(rec(d,t,'urine'))});
  });
  const sb=makeSandbox(recs);
  const st=sb.intervalStats('R1');
  // 同日内の 4時間間隔が9本、日またぎ（18:00→翌06:00＝12時間）が2本 → 平均 (9*4+2*12)/11
  ok(st.urine.n===11,'間隔の本数が記録数-1（12件 → 11本）: '+st.urine.n);
  ok(near(st.urine.avgH,(9*4+2*12)/11,0.001),'平均が手計算と一致: '+st.urine.avgH);

  // 夜間を含めること（指示: 夜間も含める）— 日またぎの12時間が母数に入っている
  ok(st.urine.avgH>4,'夜間の日またぎ区間が除外されていない（平均が4時間より長い）');
})();

/* ════════════════════════════════════════════════════════════════
   2. both（排尿＋排便）は両方に数える
   ════════════════════════════════════════════════════════════════ */
head('2. both の二重計上');
(function(){
  const recs=[
    rec(-2,'08:00','urine'),
    rec(-2,'12:00','both',{stoolAmt:'中等量'}),
    rec(-2,'16:00','urine'),
    rec(-1,'12:00','both',{stoolAmt:'中等量'})
  ];
  const sb=makeSandbox(recs);
  const st=sb.intervalStats('R1');
  ok(st.urine.n===3,'排尿は both を含めて4件 → 間隔3本: '+st.urine.n);
  ok(st.stool.n===1,'排便は both のみ2件 → 間隔1本: '+st.stool.n);
  ok(near(st.stool.avgH,24,0.001),'排便の平均が24時間: '+st.stool.avgH);
})();

/* ════════════════════════════════════════════════════════════════
   3. 排便の「少量」ルール（画面の未排便アラートと同じ基準）
      少量のみは1回と数えず、最初の少量から48時間以内（経過時間）に3回続いた3回目を1回分とする
      （2026-10-16 変更: 旧 24時間・4回目）
   ════════════════════════════════════════════════════════════════ */
head('3. 少量ルール（stoolResetSeries）');
(function(){
  const sb=makeSandbox([]);
  const S=sb.stoolResetSeries;

  // 少量2回だけ → リセット点ゼロ
  const a=sortRecs([rec(-3,'08:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'12:00','stool',{stoolAmt:'少量'})]);
  ok(S(a).length===0,'少量2回ではリセット点にならない: '+S(a).length);

  // 少量3回（48時間以内）→ 3回目だけがリセット点
  const b=sortRecs(a.concat([rec(-3,'16:00','stool',{stoolAmt:'少量'})]));
  const rb=S(b);
  ok(rb.length===1&&rb[0].time==='16:00','少量3回目がリセット点になる: '+rb.length+'件');

  // 日付をまたいでも、最初の少量から48時間以内なら3回目で1回分（暦日ではなく経過時間）
  const g=sortRecs([rec(-5,'20:00','stool',{stoolAmt:'少量'}),
                    rec(-4,'14:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'19:00','stool',{stoolAmt:'少量'})]);   // 最初から47時間後
  const rg=S(g);
  ok(rg.length===1&&rg[0].time==='19:00','日付をまたいでも47時間後の3回目はリセット点: '+rg.length+'件');

  // 最初の少量から48時間ちょうどは含む・48時間を1分でも越えたらチェーンが切れる
  const h=sortRecs([rec(-5,'08:00','stool',{stoolAmt:'少量'}),
                    rec(-4,'08:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'08:00','stool',{stoolAmt:'少量'})]);   // ちょうど48時間
  ok(S(h).length===1,'48時間ちょうどの3回目はリセット点: '+S(h).length);
  const h2=sortRecs([rec(-5,'08:00','stool',{stoolAmt:'少量'}),
                     rec(-4,'08:00','stool',{stoolAmt:'少量'}),
                     rec(-3,'08:01','stool',{stoolAmt:'少量'})]);  // 48時間1分
  ok(S(h2).length===0,'48時間を越えた3回目はリセットしない（新しいチェーンの起点）: '+S(h2).length);

  // 中等量は1件でリセット
  const c=sortRecs([rec(-2,'09:00','stool',{stoolAmt:'中等量'})]);
  ok(S(c).length===1,'中等量は1件でリセット');

  // stoolAmt 空欄も従来どおりリセット扱い
  const d=sortRecs([rec(-2,'09:00','stool',{})]);
  ok(S(d).length===1,'stoolAmt 空欄はリセット扱い');

  // 少量が48時間を越えて散る → チェーンが切れてリセット点ゼロ
  const e=sortRecs([rec(-9,'08:00','stool',{stoolAmt:'少量'}),
                    rec(-7,'09:00','stool',{stoolAmt:'少量'}),
                    rec(-5,'10:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'11:00','stool',{stoolAmt:'少量'})]);
  ok(S(e).length===0,'少量が48時間を越えて散ればリセットしない: '+S(e).length);

  // 少量4回（48時間以内）→ 3回目でリセットし、4回目は新しいチェーンの起点
  const f=sortRecs([rec(-3,'06:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'09:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'12:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'15:00','stool',{stoolAmt:'少量'})]);
  const rf=S(f);
  ok(rf.length===1&&rf[0].time==='12:00','少量4回でもリセット点は3回目の1つだけ: '+rf.length+'件');

  // 少量6回（48時間以内）→ 3回目と6回目の2つ
  const k=sortRecs(f.concat([rec(-2,'06:00','stool',{stoolAmt:'少量'}),
                             rec(-2,'09:00','stool',{stoolAmt:'少量'})]));
  const rk=S(k);
  ok(rk.length===2&&rk[1].time==='09:00','少量6回はリセット点2つ（3回目・6回目）: '+rk.length+'件');

  // 少量の途中に中等量 → 中等量で1回分、チェーンは数え直し
  const m=sortRecs([rec(-3,'06:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'09:00','stool',{stoolAmt:'少量'}),
                    rec(-3,'12:00','stool',{stoolAmt:'中等量'}),
                    rec(-3,'15:00','stool',{stoolAmt:'少量'})]);
  const rm=S(m);
  ok(rm.length===1&&rm[0].time==='12:00','途中の中等量でリセットし、少量の数は0から数え直す: '+rm.length+'件');
})();

/* ════════════════════════════════════════════════════════════════
   4. lastR との一致（統合しても未排便アラートの答えが変わらない）
   ════════════════════════════════════════════════════════════════ */
head('4. lastR との一致');
(function(){
  const recs=sortRecs([
    rec(-9,'08:00','stool',{stoolAmt:'中等量'}),
    rec(-4,'07:00','stool',{stoolAmt:'少量'}),
    rec(-4,'11:00','stool',{stoolAmt:'少量'}),
    rec(-4,'15:00','stool',{stoolAmt:'少量'}),   // ← ここが3回目＝リセット点
    rec(-2,'09:00','stool',{stoolAmt:'少量'})    // 単発の少量（リセットしない）
  ]);
  const sb=makeSandbox(recs);
  const last=sb.lastR('R1','s');
  const series=sb.stoolResetSeries(sb.recsByRes('R1').filter(function(r){
    return r.type==='stool'||r.type==='both'}));
  ok(last&&last.time==='15:00','lastR が少量3回目を返す: '+(last?last.time:'null'));
  ok(series.length&&series[series.length-1].id===last.id,'lastR は stoolResetSeries の最終要素と一致する');

  // 平均排便間隔も同じリセット点から算出される（-9日 08:00 → -4日 15:00 = 127時間）
  const st=sb.intervalStats('R1');
  ok(st.stool.n===1&&near(st.stool.avgH,127,0.01),'平均排便間隔は少量3回目を1回分として算出: n='+st.stool.n+' avgH='+st.stool.avgH);
})();

/* ════════════════════════════════════════════════════════════════
   5. 窓の切り方 — 全期間で系列を作ってから窓で絞る
      （窓の直前に少量2回・直後に3回目、という並びで lastR とズレないこと）
   ════════════════════════════════════════════════════════════════ */
head('5. 窓境界と少量チェーンの相互作用');
(function(){
  // 92日境界をまたいで少量が3回並ぶ（-93日に2回、-92日に1回）
  const recs=sortRecs([
    rec(-93,'06:00','stool',{stoolAmt:'少量'}),
    rec(-93,'18:00','stool',{stoolAmt:'少量'}),
    rec(-92,'02:00','stool',{stoolAmt:'少量'}),  // ← 3回目（窓の内側）。全期間で見て初めてリセット点になる
    rec(-10,'09:00','stool',{stoolAmt:'中等量'})
  ]);
  const sb=makeSandbox(recs);
  const st=sb.intervalStats('R1');
  const series=sb.stoolResetSeries(sb.recsByRes('R1').filter(function(r){
    return r.type==='stool'||r.type==='both'}));
  ok(series.length===2,'全期間で系列を作れば、境界をまたぐ少量3回が1回分になる: '+series.length);
  ok(st.stool.n===1,'窓内のリセット点2つ → 間隔1本: '+st.stool.n);

  // 窓より古い記録だけ → 集計対象ゼロ
  const old=sortRecs([rec(-200,'09:00','urine'),rec(-199,'09:00','urine')]);
  const sb2=makeSandbox(old);
  const st2=sb2.intervalStats('R1');
  ok(st2.urine.n===0,'92日より古い記録は集計に入らない: '+st2.urine.n);
  ok(st2.urine.avgH===null||isNaN(st2.urine.avgH),'対象ゼロなら平均は null（—表示）');
})();

/* ════════════════════════════════════════════════════════════════
   6. 入院期間をまたぐ間隔の除外
   ════════════════════════════════════════════════════════════════ */
head('6. 入院区間の除外');
(function(){
  const recs=sortRecs([
    rec(-30,'08:00','urine'),
    rec(-30,'12:00','urine'),      // ここまで 4時間間隔
    rec(-10,'12:00','urine'),      // 入院を挟んだ20日後（この区間は捨てる）
    rec(-10,'16:00','urine')       // 4時間間隔
  ]);
  const res={id:'R1',hospitalizations:[{id:'h1',
    admissionAt:ymd(-29)+'T10:00',dischargeAt:ymd(-11)+'T10:00'}]};
  const sb=makeSandbox(recs,res);
  const st=sb.intervalStats('R1');
  ok(st.urine.n===2,'入院をまたぐ1区間が除外され、間隔は2本: '+st.urine.n);
  ok(near(st.urine.avgH,4,0.001),'平均が4時間のまま（20日の空白に引っ張られない）: '+st.urine.avgH);

  // 入院継続中（dischargeAt なし）
  const res2={id:'R1',hospitalizations:[{id:'h2',admissionAt:ymd(-20)+'T10:00',dischargeAt:null}]};
  const sb2=makeSandbox(recs,res2);
  const st2=sb2.intervalStats('R1');
  ok(st2.urine.n===1,'退院日時が無い（入院継続中）でも、またぐ区間が除外される: '+st2.urine.n);

  // 入院履歴が無い方でも、20日の空白は記録の空白（48時間以上）として除外される
  // ＝2026-09-14 に実データで見つかった形（入院期間が平均に混じっていた）
  const sb3=makeSandbox(recs,{id:'R1'});
  const st3=sb3.intervalStats('R1');
  ok(st3.urine.n===2,'入院履歴が未登録でも、記録が空いた区間は除外される: '+st3.urine.n);
  ok(st3.gaps.n===1,'その区間を記録の空白として数える: '+st3.gaps.n);
})();

/* ════════════════════════════════════════════════════════════════
   7. Δ≤0（同分の二重打ち・順序逆転）は数えない
   ════════════════════════════════════════════════════════════════ */
head('7. Δ≤0 の除外');
(function(){
  const recs=sortRecs([
    rec(-5,'08:00','urine'),
    rec(-5,'08:00','urine'),   // 二重打ち（別 id・同時刻）
    rec(-5,'12:00','urine')
  ]);
  const sb=makeSandbox(recs);
  const st=sb.intervalStats('R1');
  ok(st.urine.n===1,'同時刻の区間は数えない（3件 → 間隔1本）: '+st.urine.n);
  ok(near(st.urine.avgH,4,0.001),'平均が 0 に引き下げられていない: '+st.urine.avgH);
})();

/* ════════════════════════════════════════════════════════════════
   8. 間隔が取れない場合
   ════════════════════════════════════════════════════════════════ */
head('8. サンプル不足');
(function(){
  const sb=makeSandbox([rec(-3,'08:00','urine')]);
  const st=sb.intervalStats('R1');
  ok(st.urine.n===0,'記録1件なら間隔0本: '+st.urine.n);
  ok(st.urine.avgH===null||isNaN(st.urine.avgH),'平均は null（—表示）');

  const sb2=makeSandbox([]);
  const st2=sb2.intervalStats('R1');
  ok(st2&&st2.urine&&st2.stool&&st2.lax,'記録ゼロでも3種の枠を返す（画面が壊れない）');
})();

/* ════════════════════════════════════════════════════════════════
   9. 下剤の使用間隔
   ════════════════════════════════════════════════════════════════ */
head('9. 下剤使用間隔');
(function(){
  const recs=sortRecs([
    rec(-15,'20:00','laxative',{medicine:'テスト薬',tablets:'1'}),
    rec(-10,'20:00','laxative',{medicine:'テスト薬',tablets:'1'}),
    rec(-5,'20:00','laxative',{medicine:'テスト薬',tablets:'1'}),
    rec(-12,'09:00','urine')   // 排尿は下剤の母集団に混ざらない
  ]);
  const sb=makeSandbox(recs);
  const st=sb.intervalStats('R1');
  ok(st.lax.n===2,'下剤3件 → 間隔2本: '+st.lax.n);
  ok(near(st.lax.avgH,120,0.001),'平均が5日（120時間）: '+st.lax.avgH);
  ok(st.urine.n===0,'下剤が排尿に混ざっていない: '+st.urine.n);
})();

/* ════════════════════════════════════════════════════════════════
   10. fmtDur の整形
   ════════════════════════════════════════════════════════════════ */
head('10. fmtDur');
(function(){
  const sb=makeSandbox([]);
  const f=sb.fmtDur;
  ok(f(0.5)==='30分','0.5時間 → 30分: '+f(0.5));
  ok(f(1.999)==='2時間','1.999時間 → 2時間（「1時間60分」にならない）: '+f(1.999));
  ok(f(3+20/60)==='3時間20分','3時間20分: '+f(3+20/60));
  ok(f(52)==='2日4時間','52時間 → 2日4時間: '+f(52));
  ok(f(48)==='2日','48時間 → 2日: '+f(48));
  ok(f(null)==='—'||f(null)==='','null は —（または空）: '+f(null));
})();

/* ════════════════════════════════════════════════════════════════
   12. 記録が途切れた期間の除外（2026-09-14・実データで入院期間が混じったため）
       排尿が48時間以上空いた区間は、排尿・排便・下剤のすべてから除外する
   ════════════════════════════════════════════════════════════════ */
head('12. 記録の空白（48時間）の除外');
(function(){
  // 入院履歴は登録せず、記録だけが20日間途切れているケース（＝現場で起きた形）
  const recs=sortRecs([
    rec(-40,'08:00','urine'),rec(-40,'12:00','urine'),   // 4時間
    rec(-40,'10:00','stool',{stoolAmt:'中等量'}),
    rec(-40,'20:00','laxative',{medicine:'検証薬'}),
    // ── ここから20日間、何も記録がない ──
    rec(-20,'12:00','urine'),rec(-20,'16:00','urine'),   // 4時間
    rec(-20,'10:00','stool',{stoolAmt:'中等量'}),
    rec(-20,'20:00','laxative',{medicine:'検証薬'})
  ]);
  const sb=makeSandbox(recs,{id:'R1'});   // 入院履歴なし
  const st=sb.intervalStats('R1');
  ok(st.urine.n===2,'排尿は空白をまたぐ区間を除き2本: '+st.urine.n);
  ok(near(st.urine.avgH,4,0.001),'排尿の平均が4時間（20日の空白に引っ張られない）: '+st.urine.avgH);
  ok(st.stool.n===0,'排便は空白をまたぐ1本だけなので0本: '+st.stool.n);
  ok(st.lax.n===0,'下剤も空白をまたぐ1本だけなので0本: '+st.lax.n);
  ok(st.gaps&&st.gaps.n===1,'空白を1回として数える: '+(st.gaps?st.gaps.n:'なし'));
  ok(st.gaps&&st.gaps.days===20,'空白の日数が20日: '+(st.gaps?st.gaps.days:'なし'));

  // 境界: 48時間ちょうどは「以上」なので除外する
  const b48=sortRecs([rec(-10,'08:00','urine'),rec(-8,'08:00','urine'),rec(-8,'12:00','urine')]);
  const s48=makeSandbox(b48,{id:'R1'}).intervalStats('R1');
  ok(s48.urine.n===1&&near(s48.urine.avgH,4,0.001),'48時間ちょうどの空白は除外する: n='+s48.urine.n);
  ok(s48.gaps.n===1,'48時間ちょうどを空白として数える: '+s48.gaps.n);

  // 境界: 47時間は除外しない
  const b47=sortRecs([rec(-10,'09:00','urine'),rec(-8,'08:00','urine')]);
  const s47=makeSandbox(b47,{id:'R1'}).intervalStats('R1');
  ok(s47.urine.n===1&&near(s47.urine.avgH,47,0.001),'47時間の空白は除外しない: '+s47.urine.avgH);
  ok(s47.gaps.n===0,'47時間は空白として数えない: '+s47.gaps.n);

  // 空白の外側は従来どおり残る（空白があっても他の区間は生きる）
  const mix=sortRecs([
    rec(-30,'08:00','urine'),rec(-30,'12:00','urine'),
    rec(-5,'08:00','urine'),rec(-5,'12:00','urine'),rec(-5,'16:00','urine')
  ]);
  const sm=makeSandbox(mix,{id:'R1'}).intervalStats('R1');
  ok(sm.urine.n===3,'空白の前後の区間は残る（1+2本）: '+sm.urine.n);
  ok(near(sm.urine.avgH,4,0.001),'平均は4時間のまま: '+sm.urine.avgH);

  // 排尿の記録が無い方では空白を検出できない（排便だけの運用）— 従来どおり全区間を数える
  const so=sortRecs([rec(-40,'10:00','stool',{stoolAmt:'中等量'}),rec(-20,'10:00','stool',{stoolAmt:'中等量'})]);
  const ss=makeSandbox(so,{id:'R1'}).intervalStats('R1');
  ok(ss.stool.n===1,'排尿記録が無ければ空白は検出されず、排便の区間は残る: '+ss.stool.n);
  ok(ss.gaps.n===0,'空白は0回: '+ss.gaps.n);
})();

/* ════════════════════════════════════════════════════════════════
   11. 既存機能を壊していないか（表示側の最低限の確認）
   ════════════════════════════════════════════════════════════════ */
head('11. 実装の作法');
(function(){
  ok(/function\s+stoolResetSeries\s*\(/.test(SRC),'stoolResetSeries がトップレベル function 宣言');
  ok(/function\s+intervalStats\s*\(/.test(SRC),'intervalStats がトップレベル function 宣言');
  ok(/function\s+hospOverlaps\s*\(/.test(SRC),'hospOverlaps がトップレベル function 宣言');
  ok(/function\s+fmtDur\s*\(/.test(SRC),'fmtDur がトップレベル function 宣言');
  // lastR の少量判定は datetime 基準のまま（tsUTC に置き換えられていないこと）
  const series=X.fn('stoolResetSeries');
  ok(/datetime/.test(series)&&!/tsUTC/.test(series),
    '少量チェーンの24時間判定が datetime 基準のまま（tsUTC に「改善」されていない）');
  // 統計バーの挿入先
  ok(/mHistStats/.test(SRC),'#mHistStats を組み立てている');
  ok(/id="mHistStats"/.test(HTML)||/mHistStats/.test(SRC),'統計バーの器がある');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
