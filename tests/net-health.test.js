/* ══════════════════════════════════════════════════════════════════════
   通信が不調な時の見張り（A 即再送／B 警告帯／C 通信の記録）の検証ハーネス（2026-10-06）
   実行:  node tests/net-health.test.js
   ──────────────────────────────────────────────────────────────────────
   なぜ必要か: Wi-Fi の不調で記録が他の端末に届かない時、
     ①戻っても送り直しが次の tick まで待たされる ②送れていないことに職員が気づけない
     ③いつ・どの端末が通信できなかったか後から確かめられない、の3つを埋めた。
   ここが崩れる（帯が平常時に出る／出るべき時に出ない／記録に個人情報が入る）とこのテストが落ちる。

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

const MIN=60*1000;

/* ════════ 砂場 ════════
   DOM・送信・同期はスタブ。見張りの判定・記録・再送の呼び出しだけを実物で動かす。 */
function makeSandbox(opt){
  opt=opt||{};
  const store={};
  const calls={unsentPoll:0,syncPoll:[],render:0,toast:[]};
  const timers=[];
  const els={};
  function el(id){
    if(!els[id])els[id]={id,hidden:true,textContent:'',innerHTML:'',style:{},offsetHeight:48,
      attrs:{},setAttribute(k,v){this.attrs[k]=v},classList:{contains:()=>false},
      addEventListener(ev,fn){this['on'+ev]=fn}};
    return els[id];
  }
  const sb={
    console:{log(){},warn(){},error(){}},Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,Promise,RegExp,
    Date:class extends Date{static now(){return sb._now}},_now:Date.UTC(2026,9,6,3,0,0),
    setTimeout(fn,ms){timers.push({fn,ms});return timers.length},clearTimeout(){},setInterval(){return 1},
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}},
    navigator:{onLine:opt.onLine!==false},
    document:{visibilityState:'visible',body:{classList:{toggle(c,on){sb.__bodyOn=on}}},
      documentElement:{style:{setProperty(){}}},querySelector:()=>({offsetHeight:52}),addEventListener(){}},
    window:{addEventListener(){}},
    $:id=>(opt.noDom&&id!=='sc-cfg')?null:el(id),
    apiUrl:opt.apiUrl===undefined?'http://x/exec':opt.apiUrl,
    _locked:!!opt.locked,_autoLockBusy:false,
    _unsentCount:()=>sb.__unsent||0,
    _unsentPollTick:()=>{calls.unsentPoll++},
    _syncPollTick:f=>{calls.syncPoll.push(f)},
    _syncPollFails:3,
    showToast:m=>{calls.toast.push(m)},
    escapeHtmlText:null
  };
  sb.__unsent=0;
  vm.createContext(sb);
  vm.runInContext([
    (/function _lzFactory\(/.test(SRC)?X.fn('_lzFactory'):''),X.varDecl('LZString'),X.varDecl('COMPRESS_MAGIC'),X.fn('_storageSet'),X.fn('_storageGet'),X.fn('escapeHtmlText'),
    X.varDecl('NET_WARN_UNSENT_MS'),X.varDecl('NET_WARN_STALE_MS'),X.varDecl('NET_ONLINE_DELAY_MS'),
    X.varDecl('NET_LOG_KEY'),X.varDecl('NET_LOG_MAX'),X.varDecl('NET_LOG_SHOW'),X.varDecl('NET_LOG_MERGE_MS'),
    X.varDecl('NET_LOG_LABEL'),X.varDecl('NET_LOG_CLS'),
    X.fn('_netBannerState'),X.fn('_netObserveUnsent'),X.fn('_netEval'),X.fn('_netEvalSoon'),X.fn('_netLayout'),
    X.fn('_netOnStatus'),X.fn('_netClassify'),X.fn('_netLogLoad'),X.fn('_netLogAdd'),X.fn('_netRetryNow'),
    X.fn('_netOnOnline'),X.fn('_netOnOffline'),X.fn('_netFmtTime'),X.fn('_netFmtDur'),X.fn('renderNetLog'),
    X.fn('apiSetStatus')
  ].join('\n'),sb);
  sb._netOkAt=sb._now;sb._netOkReal=0;sb._netErAt=0;sb._netFailSince=0;sb._netUnsentSince=0;
  sb._netEvalTimer=null;sb._netOnlineTimer=null;sb._netBound=false;
  sb.__store=store;sb.__calls=calls;sb.__timers=timers;sb.__els=els;sb.__el=el;
  sb.__runTimers=function(){while(timers.length){const t=timers.shift();t.fn()}};
  sb.__log=function(){return sb._netLogLoad()};
  return sb;
}
/* _netBannerState に渡す既定値（平常時） */
function S(o){return Object.assign({now:100*MIN,apiUrl:'u',locked:false,offline:false,unsent:0,unsentSince:0,okAt:100*MIN,erAt:0},o)}

/* ════════════════════════════════════════════════════════════════
   1. 帯を出す条件（B）
   ════════════════════════════════════════════════════════════════ */
head('1. 帯の判定（_netBannerState）');
(function(){
  const sb=makeSandbox();
  const B=s=>sb._netBannerState(S(s));
  ok(B({})===null,'平常時（未送信なし・失敗なし）は出さない');
  ok(B({apiUrl:''})===null,'接続先が未設定なら出さない（オフライン運用の端末）');
  ok(B({apiUrl:'',offline:true,unsent:3,unsentSince:1})===null,'接続先が未設定なら Wi-Fi 切断でも出さない');
  ok(B({locked:true,offline:true})===null,'自動ロック中は出さない');

  const off=B({offline:true});
  ok(off&&off.kind==='offline'&&/Wi-Fi が切れています/.test(off.text),'ブラウザが offline を通知していれば即座に出す',off);
  const both=B({offline:true,unsent:2,unsentSince:1,now:100*MIN});
  ok(both&&both.kind==='offline','切断中は未送信より切断の文言を優先する',both);

  ok(B({unsent:1,unsentSince:100*MIN-(2*MIN-1)})===null,'未送信が残って 1分59秒 では出さない（境界の手前）');
  const un=B({unsent:3,unsentSince:100*MIN-2*MIN});
  ok(un&&un.kind==='unsent','未送信が残って 2分ちょうど で出す（境界）',un);
  ok(un&&/記録 3件/.test(un.text)&&/届いていません/.test(un.text),'件数を文言に入れる',un&&un.text);
  ok(B({unsent:3,unsentSince:0})===null,'残り始めた時刻が無ければ出さない（起動直後の取りこぼし防止）');

  ok(B({erAt:95*MIN,okAt:90*MIN+1,now:100*MIN})===null,'失敗していても最後の通信から 9分59秒 なら出さない（境界の手前）');
  const st=B({erAt:95*MIN,okAt:90*MIN,now:100*MIN});
  ok(st&&st.kind==='stale'&&/10分以上/.test(st.text),'失敗していて最後の通信から 10分ちょうど で出す（境界）',st);
  ok(B({erAt:0,okAt:30*MIN,now:100*MIN})===null,'失敗が無いまま70分経っただけ（画面を消していた・モーダルを開いたまま）なら出さない');
  ok(B({erAt:20*MIN,okAt:30*MIN,now:100*MIN})===null,'失敗のあとに通信できていれば出さない（復帰済み）');
  ok(sb.NET_WARN_UNSENT_MS===2*MIN&&sb.NET_WARN_STALE_MS===10*MIN,'しきい値は 2分・10分（定数1か所）');
})();

/* ════════════════════════════════════════════════════════════════
   2. 未送信が残り始めた時刻（0→1 から測る）
   ════════════════════════════════════════════════════════════════ */
head('2. 未送信の始まりと終わり');
(function(){
  const sb=makeSandbox();
  sb.__unsent=0;sb._netObserveUnsent();
  ok(sb._netUnsentSince===0,'未送信が無ければ時刻を持たない');
  sb.__unsent=1;const t0=sb._now;sb._netObserveUnsent();
  ok(sb._netUnsentSince===t0,'0→1 の瞬間の時刻を取る');
  sb._now+=MIN;sb.__unsent=4;sb._netObserveUnsent();
  ok(sb._netUnsentSince===t0,'件数が増えても始まりの時刻は動かさない（ずっと届いていない長さを測る）');
  sb.__unsent=0;sb._netObserveUnsent();
  ok(sb._netUnsentSince===0,'送り切ったら時刻を消す（次の未送信は改めて0から測る）');
})();

/* ════════════════════════════════════════════════════════════════
   3. 帯の表示と自動で消えること（実物の _netEval）
   ════════════════════════════════════════════════════════════════ */
head('3. 帯の出し入れ（_netEval）');
(function(){
  const sb=makeSandbox();
  const w=sb.__el('netWarn');
  sb._netEval();
  ok(w.hidden===true,'平常時は隠れたまま');
  sb.__unsent=2;sb._netEval();                      // 残り始め
  ok(w.hidden===true,'未送信が出た直後はまだ出さない');
  sb._now+=2*MIN;sb._netEval();
  ok(w.hidden===false&&w.attrs['data-kind']==='unsent','2分残ったら帯を出す',w.attrs);
  ok(/記録 2件/.test(sb.__el('netWarnMsg').textContent),'文言に件数が入る',sb.__el('netWarnMsg').textContent);
  ok(sb.__bodyOn===true,'表示中は本文の下余白を広げる（帯の下に本文が隠れない）');
  ok(w.style.bottom==='52px','帯は下部ナビの実際の高さの上に置く',w.style.bottom);
  sb.__unsent=0;sb._netEval();
  ok(w.hidden===true&&sb.__bodyOn===false,'送り切ったら自動で消える・余白も戻す');

  const off=makeSandbox({onLine:false});
  off._netEval();
  ok(off.__el('netWarn').hidden===false&&off.__el('netWarn').attrs['data-kind']==='offline','offline なら待たずに出す');
  off.document.visibilityState='hidden';off.navigator.onLine=true;off._netEval();
  ok(off.__el('netWarn').hidden===false,'画面が見えていない間は帯を動かさない（戻った時に判定し直す）');
  off.document.visibilityState='visible';off._netEval();
  ok(off.__el('netWarn').hidden===true,'画面に戻って通信が戻っていれば消える');

  const lk=makeSandbox({onLine:false,locked:true});
  lk._netEval();
  ok(lk.__el('netWarn').hidden===true,'自動ロック中は出さない');
})();

/* ════════════════════════════════════════════════════════════════
   4. 接続表示からの入口（apiSetStatus → _netOnStatus）
   ════════════════════════════════════════════════════════════════ */
head('4. 通信できた／できなかったの取り込み');
(function(){
  const sb=makeSandbox({noDom:true});              // ヘッダの表示要素が無くても見張りは動く
  const t0=sb._now;
  sb._now+=5*MIN;
  sb.apiSetStatus('ok');                            // 起動直後の表示合わせ（route なし）
  ok(sb._netOkAt===t0&&sb._netOkReal===0,'route の無い「接続中」表示は通信できた扱いにしない');
  sb.apiSetStatus('sy');
  ok(sb.__log().length===0,'同期中の表示は記録しない');

  sb.apiSetStatus('er','接続エラー: Failed to fetch','同期');
  let log=sb.__log();
  ok(log.length===1&&log[0].k==='fail'&&log[0].r==='同期'&&/通信不可/.test(log[0].m),'失敗を記録する（経路・定型の説明）',log[0]);
  ok(sb._netErAt===sb._now&&sb._netFailSince===sb._now,'失敗の時刻と、失敗が続き始めた時刻を持つ');
  const fs0=sb._netFailSince;

  sb._now+=7*MIN;
  sb.apiSetStatus('er','タイムアウト（30秒）','書き込み');
  ok(sb._netFailSince===fs0,'失敗が続く間は「続き始めた時刻」を動かさない');
  log=sb.__log();
  ok(log.length===2&&log[0].r==='書き込み'&&/タイムアウト/.test(log[0].m),'書き込みの失敗も経路つきで記録する',log[0]);

  sb._now+=8*MIN;
  sb.apiSetStatus('ok','最終同期: 12:00:00','同期');
  log=sb.__log();
  ok(log[0].k==='ok'&&log[0].d===15*MIN&&/約15分/.test(log[0].m),'復帰を記録し、失敗が続いた長さを残す（15分）',log[0]);
  ok(sb._netOkAt===sb._now&&sb._netOkReal===sb._now&&sb._netFailSince===0,'通信できた時刻を更新し、失敗中を解く');

  sb._now+=MIN;
  sb.apiSetStatus('ok','最終同期: 12:01:00','書き込み');
  ok(sb.__log().length===3,'失敗していない時の成功は記録しない（平常時に記録が増えない）',sb.__log().length);
})();

/* ════════════════════════════════════════════════════════════════
   5. 通信の記録（C）: 上限・まとめ・入れてはいけないもの
   ════════════════════════════════════════════════════════════════ */
head('5. 通信の記録');
(function(){
  const sb=makeSandbox();
  for(let i=0;i<250;i++){sb._now+=2*MIN;sb._netLogAdd('fail','同期','通信不可（サーバーに届かない）')}
  const log=sb.__log();
  ok(log.length===200,'最大200件で古いものから捨てる',log.length);
  ok(log[0].t>log[199].t,'新しい順に並ぶ');
  ok(sb.__store['hbcr_net_log']!==undefined,'保存先は hbcr_net_log');

  const mg=makeSandbox();
  mg._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  mg._now+=5*1000;mg._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  mg._now+=5*1000;mg._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  let l2=mg.__log();
  ok(l2.length===1&&l2[0].n===3,'同じ失敗が1分以内に続いたら1件にまとめて回数を数える（未送信が続けて失敗する時）',l2);
  mg._now+=2*MIN;mg._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  ok(mg.__log().length===2,'1分以上あいたら別の件として残す');
  mg._netLogAdd('fail','同期','通信不可（サーバーに届かない）');
  ok(mg.__log().length===3,'経路が違えばまとめない');

  // 入れてはいけないもの
  const c=s=>sb._netClassify(s);
  ok(/通信不可/.test(c('接続エラー: Failed to fetch')),'Chrome の通信不可を分類');
  ok(/通信不可/.test(c('Load failed')),'Safari（iPhone）の通信不可を分類');
  ok(/通信不可/.test(c('NetworkError when attempting to fetch resource.')),'Firefox の通信不可を分類');
  ok(/^タイムアウト/.test(c('接続エラー: タイムアウト（60秒）')),'タイムアウトを分類');
  ok(c('接続エラー: HTTP 502').indexOf('HTTP 502')===0,'HTTP の番号を残す');
  ok(/^書き込みエラー/.test(c('書き込みエラー')),'書き込みエラーを分類');
  ok(/^認証エラー/.test(c('接続エラー: unauthorized')),'合言葉の不一致を分類');
  const u=c('接続エラー: bad https://script.google.com/macros/s/AKfyEXAMPLE/exec?token=abc id 1726543210123');
  ok(!/https?:|script\.google|token=|1726543210123/.test(u),'分類できない文言でも URL・合言葉・長い数字（ID）は残さない',u);
  ok(c('x'.repeat(100))==='その他: '+'x'.repeat(40),'分類できない文言は40字で切る');

  const keys=new Set();sb.__log().concat(mg.__log()).forEach(e=>Object.keys(e).forEach(k=>keys.add(k)));
  ok([...keys].every(k=>['t','k','r','m','d','n','l'].includes(k)),'1件に持つのは 時刻・種類・経路・説明・長さ・回数 だけ',[...keys]);
})();

/* ════════════════════════════════════════════════════════════════
   6. 通信が戻った瞬間の送り直し（A）
   ════════════════════════════════════════════════════════════════ */
head('6. online で即再送');
(function(){
  const sb=makeSandbox();
  sb._syncPollFails=3;                              // 失敗続きで取得間隔を15分に落としている状態
  sb._netOnOnline();
  ok(sb.__log()[0].k==='online','通信が戻った通知を記録する');
  const t=sb.__timers.find(x=>x.ms===sb.NET_ONLINE_DELAY_MS);
  ok(!!t&&sb.NET_ONLINE_DELAY_MS===2000,'2秒待ってから送り直す（再接続の直後は届かないことがある）');
  ok(sb.__calls.unsentPoll===0&&sb.__calls.syncPoll.length===0,'待つ間はまだ送らない');
  sb.__runTimers();
  ok(sb._syncPollFails===0,'15分間隔への落とし込みを解く');
  ok(sb.__calls.unsentPoll===1,'未送信を送り直す（可視・ロックの抑止は既存の _unsentPollTick に任せる）');
  ok(sb.__calls.syncPoll.length===1&&sb.__calls.syncPoll[0]===true,'間隔を待たずに取りに行く（_syncPollTick(true)）');

  const off=makeSandbox();
  off._netOnOffline();
  ok(off.__log()[0].k==='offline','通信が切れた通知を記録する');
  ok(off.__calls.syncPoll.length===0,'切れた時は送り直さない');
})();

/* ════════════════════════════════════════════════════════════════
   7. 設定画面の表示（C）
   ════════════════════════════════════════════════════════════════ */
head('7. 設定画面の通信の記録');
(function(){
  const sb=makeSandbox();
  sb._netLogAdd('fail','同期','<b>x</b>');
  sb._now+=60*MIN;sb._netLogAdd('ok','同期','失敗が続いた時間 約60分',60*MIN);
  sb._now+=25*60*MIN;                               // 25時間後
  sb._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  sb._netLogAdd('fail','書き込み','通信不可（サーバーに届かない）');
  sb.renderNetLog();
  const sum=sb.__el('netLogSum').innerHTML, list=sb.__el('netLogList').innerHTML;
  ok(/直近24時間の失敗: 2回/.test(sum),'直近24時間の失敗回数（まとめた回数も数える・24時間より前は数えない）',sum);
  ok(/最長の不通: なし/.test(sum),'24時間より前の復帰は最長に入れない',sum);
  ok(/読み込み後まだ通信していません/.test(sum),'まだ通信していなければそう書く（起動時刻を最後の通信と偽らない）');
  ok(!/<b>x<\/b>/.test(list)&&/&lt;b&gt;x&lt;\/b&gt;/.test(list),'記録の文言はエスケープして出す');
  ok((list.match(/<li>/g)||[]).length===3,'一覧は新しい順（まとめた分は1行）',list);

  const on=makeSandbox();
  on._netFailSince=on._now-30*MIN;on._netOkReal=on._now-31*MIN;
  on.renderNetLog();
  ok(/約30分（いまも続いています）/.test(on.__el('netLogSum').innerHTML),'失敗がいま続いていれば、その長さも最長の候補に入れる',on.__el('netLogSum').innerHTML);
})();

/* ════════════════════════════════════════════════════════════════
   8. 配線（呼び出し元・消去の対象外）
   ════════════════════════════════════════════════════════════════ */
head('8. 配線');
(function(){
  const calls=SRC.match(/apiSetStatus\('(?:ok|er)'[^;]*\)/g)||[];
  const er=calls.filter(c=>/^apiSetStatus\('er'/.test(c));
  ok(er.length>=3&&er.every(c=>/,'(同期|書き込み)'\)$/.test(c)),'失敗の表示はすべて経路つきで呼ぶ（記録から漏れない）',er);
  const okc=calls.filter(c=>/^apiSetStatus\('ok','最終同期/.test(c));
  ok(okc.length>=3&&okc.every(c=>/,'(同期|書き込み)'\)$/.test(c)),'実際の成功の表示はすべて経路つきで呼ぶ（復帰を取りこぼさない）',okc);

  const wipe=X.fn('autoLockWipe');
  ok(!/hbcr_net_log|NET_LOG_KEY/.test(wipe),'自動ロックの消去対象に通信の記録を入れない');
  const clr=SRC.slice(SRC.indexOf("$('btnApiClear')"),SRC.indexOf("$('btnApiClear')")+600);
  ok(!/hbcr_net_log|NET_LOG_KEY/.test(clr),'連携解除でも通信の記録を消さない');

  ok(/_netEvalSoon\(\)/.test(X.fn('savePendingQueue')),'再送キューの件数が変わったら帯を判定し直す（送り切ったらすぐ消える）');
  ok(/_netEvalSoon\(\)/.test(X.fn('_wqPersist')),'送信本流の件数が変わったら帯を判定し直す');
  ok(/renderNetLog\(\)/.test(X.fn('renderCfg')),'設定画面を開くと通信の記録を描く');
  ok(/setupNetHealth\(\)/.test(SRC.slice(SRC.indexOf('function init('))),'起動時に見張りを登録する');
  const ui=X.fn('setupNetHealth');
  ok(/'online'/.test(ui)&&/'offline'/.test(ui),'online / offline を受ける');
  ok(/netWarnBtn/.test(ui)&&/_netRetryNow/.test(ui),'帯のボタンで今すぐ送り直す');
  ok(/role="alert"/.test(HTML.slice(HTML.indexOf('id="netWarn"')-80,HTML.indexOf('id="netWarn"')+120)),'帯は読み上げ（role="alert"）');
  ok(/@media print\{#netWarn\{display:none !important\}\}/.test(HTML),'印刷には出さない');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
