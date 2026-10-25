/* ══════════════════════════════════════════════════════════════════════
   見出しの時計（10秒ごと）を裏のタブで休ませる検証（2026-10-24・アプリ間連携の見直し 段1）
   実行:  node tests/clock-hidden.test.js
   ──────────────────────────────────────────────────────────────────────
   なぜ: 見出しの日付・時刻は10秒ごとに書き換えていた。画面が隠れている間（別のアプリ・タブを見ている間）も
   書き換え続け、タブレットの電池を使っていた。通信はしない処理なので、隠れている間は飛ばし、見えた時に1回書き換える。
   守ること:
     1. 見えている間は今までどおり10秒ごとに書き換える（タイマーは1本・10秒）
     2. 隠れている間はタイマーが来ても書き換えない
     3. 見えた時（visibilitychange）に1回書き換え、今の時刻になる。隠れた時は書き換えない
   ★実物のソース（haiben-record.html）の時計の行をそのまま評価する。判定ロジックを写経しない。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');

const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(process.env.HAIBEN_HTML||path.join(ROOT,'haiben-record.html'),'utf8');
const SRC=(function(){const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML);
  if(!m)throw new Error('script ブロックが見つかりません');return m[1]})();

let fail=0,pass=0;
function ok(c,m){if(c){pass++;console.log('  ✅ '+m)}else{fail++;console.log('  ❌ '+m)}}
function head(t){console.log('\n─── '+t+' ───')}

/* 時計の関数・起動・見えた時の受け口の3行（_initRest の中）を切り出す */
const CLOCK=(function(){
  const m=/\n  function tick\(\)\{[\s\S]*?\n  tick\(\);setInterval\(tick,1e4\);\n  document\.addEventListener\('visibilitychange',function\(\)\{if\(document\.visibilityState==='visible'\)tick\(\)\}\);/.exec(SRC);
  return m?m[0]:null;
})();

function makeSandbox(hidden){
  let now=new Date(2026,9,24,9,0,0).getTime();
  class FakeDate extends Date{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
  const el={hDate:{w:0,_t:''},hTime:{w:0,_t:''}};
  for(const k of Object.keys(el))Object.defineProperty(el[k],'textContent',{get(){return this._t},set(v){this.w++;this._t=String(v)}});
  const timers=[],listeners={};
  const doc={hidden:!!hidden,get visibilityState(){return this.hidden?'hidden':'visible'},
    addEventListener(ev,f){(listeners[ev]=listeners[ev]||[]).push(f)}};
  const sb={Date:FakeDate,document:doc,$:(id)=>el[id]||null,setInterval(f,ms){timers.push({f,ms});return timers.length}};
  vm.createContext(sb);
  vm.runInContext(CLOCK,sb);
  return{el,timers,
    advance(ms){now+=ms},
    interval(){timers.forEach(x=>x.f())},
    setHidden(h){doc.hidden=h;(listeners.visibilitychange||[]).forEach(f=>f())}};
}

head('0. 前提');
ok(!!CLOCK,'時計の関数・起動・見えた時の受け口の3行がそろっている');
if(!CLOCK){console.log('\n合計: '+pass+' 件成功 / '+(fail)+' 件失敗');process.exit(1)}

head('1. 見えている間は今までどおり');
(function(){
  const s=makeSandbox(false);
  ok(s.el.hDate.w===1&&s.el.hTime.w===1,'起動時に日付と時刻を1回書く');
  ok(s.el.hTime.textContent==='09:00','時刻は今の時刻（09:00）: '+s.el.hTime.textContent);
  ok(s.timers.length===1&&s.timers[0].ms===10000,'タイマーは1本・10秒（今までと同じ）');
  s.advance(60000);s.interval();
  ok(s.el.hTime.w===2&&s.el.hTime.textContent==='09:01','見えている間はタイマーで書き換える: '+s.el.hTime.textContent);
})();

head('2. 隠れている間は書き換えない');
(function(){
  const s=makeSandbox(false);
  s.setHidden(true);
  ok(s.el.hTime.w===1,'隠れた時には書き換えない');
  for(let i=0;i<6;i++){s.advance(10000);s.interval()}
  ok(s.el.hTime.w===1&&s.el.hDate.w===1,'★隠れている間はタイマーが6回来ても書き換えない: '+s.el.hTime.w);
})();

head('3. 見えた時に1回');
(function(){
  const s=makeSandbox(false);
  s.setHidden(true);
  s.advance(5*60000);s.interval();
  s.setHidden(false);
  ok(s.el.hTime.w===2&&s.el.hDate.w===2,'★見えた時に1回だけ書き換える: '+s.el.hTime.w);
  ok(s.el.hTime.textContent==='09:05','見えた時の時刻は今の時刻（09:05）: '+s.el.hTime.textContent);
  s.advance(10000);s.interval();
  ok(s.el.hTime.w===3,'見えた後はタイマーで書き換えを続ける');
})();
(function(){
  const s=makeSandbox(true);
  ok(s.el.hTime.w===0,'裏のタブで開いた時は、起動時にも書き換えない');
  s.advance(30000);s.setHidden(false);
  ok(s.el.hTime.w===1&&s.el.hTime.textContent==='09:00','見えた時に今の時刻で書く: '+s.el.hTime.textContent);
})();

head('4. 時計は通信しない');
ok(!/fetch\(|syncFromAPI|apiCall|XMLHttpRequest/.test(CLOCK),'時計の行に通信が無い');

console.log('\n合計: '+pass+' 件成功 / '+fail+' 件失敗');
process.exit(fail?1:0);
