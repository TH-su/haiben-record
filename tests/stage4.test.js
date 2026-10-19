/* ══════════════════════════════════════════════════════════════════════
   第4段（2026-10-16）の検証ハーネス: 交換したもの（おむつ・パッド）・排便の経過の一枚もの・トイレの成功率と失禁率
   実行:  node tests/stage4.test.js
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
const p2=n=>('0'+n).slice(-2);
function ymdOf(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
function ymd(off){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+off);return ymdOf(d)}
let _seq=0;
function rec(date,time,type,extra){
  return Object.assign({id:'r'+(++_seq),residentId:1,date,time,datetime:date+'T'+time,tsUTC:new Date(date+'T'+time).getTime(),type},extra||{});
}
function makeSandbox(records,opts){
  opts=opts||{};
  const store={};
  const els={};
  const sb={console:{log(){},warn(){},error(){}},Date,Math,String,Number,Array,Object,JSON,isNaN,parseInt,parseFloat,RegExp,Set,
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem(k,v){store[k]=String(v)},removeItem(k){delete store[k]}},
    document:{activeElement:null}};
  sb.__store=store;
  vm.createContext(sb);
  const fns=['stoolResetSeries','fmtCons','fmtDur','fmtMD','today','dayDiff','escapeHtmlText','_evMs','laxReaction','toNum','dateOff',
    'padKinds','parsePads','padsStr','padsTotal','padsText','padsSrvTag','padsAvail','padsNoteSrv',
    'guideStats','gsPct','_ymdL','guideRateHtml','padUseHtml','_keepCap','_localKeepDays','_hbKeepFrom',
    'rpSpanDates','rpConsTxt','rpBowelOne','rpPadMonth','rpYMD','rpPad','rpMonthDates','rpWdCls','rpHead','rpFoot','roomToFloor','floorLabel','cfgSendPayload'];
  vm.runInContext([X.varDecl('STOOL_SMALL_N'),X.varDecl('LAX_REACT_H'),X.varDecl('BAK_OFF_KEY'),
    X.varDecl('PAD_KINDS_DEF'),X.varDecl('PAD_COL_KEY'),X.varDecl('CONS_BS'),X.varDecl('RP_WD'),X.varDecl('RP_ORG')]
    .concat(fns.map(n=>X.fn(n))).join('\n'),sb);
  const res=Object.assign({id:1,name:'入居者A',room:'101',cfg:{}},opts.resident||{});
  sb.D={records,residents:[res],cfg:Object.assign({urineWarnH:6,urineDangerH:8,stoolWarnD:2,stoolDangerD:3,localKeepDays:365},opts.cfg||{})};
  sb.apiUrl=opts.apiUrl||'';
  const sorted=records.slice().sort((a,b)=>(a.datetime||'').localeCompare(b.datetime||''));
  sb.recsByRes=rid=>sorted.filter(r=>r.residentId===rid);
  sb.recsByResDate=(rid,d)=>sorted.filter(r=>r.residentId===rid&&r.date===d);
  sb.isUserRec=r=>!!r;
  sb.isFullHospDay=(re,k)=>!!(opts.hosp&&opts.hosp.indexOf(k)>=0);
  sb.rpResidents=()=>sb.D.residents;
  sb.intervalStats=()=>({stool:{avgH:opts.avgH==null?null:opts.avgH,n:3}});
  sb.renderPadCard=()=>{sb.__rc=(sb.__rc||0)+1};sb.renderPadCfg=()=>{};
  sb.$=id=>els[id]||null;
  sb.__els=els;
  return sb;
}

head('1. 交換したもの: 値の読み書き（受け取った値を信じない）');
(function(){
  const sb=makeSandbox([]);
  ok(JSON.stringify(sb.parsePads('{"尿取りパッド":2,"テープ式おむつ":1}'))==='{"尿取りパッド":2,"テープ式おむつ":1}','JSON 文字列を読む');
  ok(Object.keys(sb.parsePads('壊れた{')).length===0,'壊れた文字列は空');
  ok(Object.keys(sb.parsePads('[1,2]')).length===0,'配列は空');
  ok(JSON.stringify(sb.parsePads({'尿取りパッド':'3','x':0,'y':-1,'z':150}))==='{"尿取りパッド":3}','0・負・100以上は捨て、数字の文字列は数にする');
  ok(sb.padsStr({})==='','何も無ければ空文字（列には空を書く）');
  ok(sb.padsStr({'夜用パッド':1})==='{"夜用パッド":1}','書く形は JSON 文字列');
  ok(sb.padsTotal('{"a":2,"b":3}')===5,'合計の枚数');
  ok(sb.padsText('{"尿取りパッド":2}')==='尿取りパッド 2枚','表示の文言');
  ok(sb.padKinds().join('|')==='テープ式おむつ|パンツ式おむつ|尿取りパッド|夜用パッド','品目の既定');
  sb.D.cfg.padKinds='フラット| 尿取りパッド |フラット||';
  ok(sb.padKinds().join('|')==='フラット|尿取りパッド','設定の品目（| 区切り・重複と空を除く）');
  sb.D.cfg.padKinds='';
  ok(sb.padKinds().length===4,'設定が空なら既定に戻る');
})();

head('2. サーバーに pads の列がある時だけ入力欄を出す');
(function(){
  const sb=makeSandbox([],{apiUrl:'https://example.invalid/exec'});
  ok(sb.padsAvail()===false,'接続先があり、まだ観測していない時は出さない');
  sb.padsNoteSrv([{id:'a',type:'urine'}]);
  ok(sb.padsAvail()===false,'列の無い記録を受け取った → 出さない');
  sb.padsNoteSrv([{id:'a',type:'urine',pads:''}]);
  ok(sb.padsAvail()===true,'pads の列（空でも）がある記録を受け取った → 出す');
  sb.padsNoteSrv([]);
  ok(sb.padsAvail()===true,'記録の来ない差分では前の値のまま');
  const sb2=makeSandbox([]);
  ok(sb2.padsAvail()===true,'接続先の無い端末はそのまま使える');
  ok(/if\(typeof padsNoteSrv==='function'\)padsNoteSrv\(apiRec\)/.test(SRC),'同期の受け取りで列の有無を観測する');
})();

head('3. 保存・修正・取り消し・CSV に pads が通る');
(function(){
  const sub=X.fn('submitRec');
  ok(/existing\.pads=padsStr\(ci\.pads\)/.test(sub),'修正の保存で pads を書く');
  ok(/pads:padsStr\(ci\.pads\),/.test(sub),'新しい記録に pads を書く');
  ok(/ci\.pads=parsePads\(r\.pads\)/.test(X.fn('editRec')),'修正を開くと pads を読み込む');
  ok(/ci=\{[^}]*pads:\{\}\}/.test(X.fn('resetForm')),'入力を消すと pads も消える');
  ok(/padsTotal\(ci\.pads\)>0/.test(X.fn('_inputDirty')),'交換だけ入れた状態も「保存していない入力」に数える');
  ok(/'交換したもの'\]/.test(X.fn('expCSV'))&&/padsText\(r\.pads\)\]/.test(X.fn('expCSV')),'全件の CSV の末尾に交換したもの');
  ok(/'修正の有無','交換したもの'\]/.test(X.fn('rpCsv'))&&/padsText\(r\.pads\)\]/.test(X.fn('rpCsv')),'帳票の CSV の末尾に交換したもの');
  ok(/JSON\.parse\(JSON\.stringify\(existing\)\)/.test(sub),'修正の取り消しは記録まるごとの写し（pads も戻る）');
})();

head('4. 品目の設定はサーバーへ。ほかの設定を消さない');
(function(){
  const sb=makeSandbox([],{cfg:{autoLockMin:15,padKinds:'A|B'}});
  const o=sb.cfgSendPayload();
  ok(o.urineWarnH===6&&o.stoolDangerD===3&&o.localKeepDays===365&&o.autoLockMin===15&&o.padKinds==='A|B','品目の保存でも、いつもの5項目と自動ロックを一緒に送る（Config は全行を書き直すため）',o);
  ok(/_send\.padKinds=/.test(SRC),'いつもの「設定を保存」でも品目を一緒に送る');
  ok(/html\.hb-field #cdPadKinds/.test(HTML),'現場用の端末では品目の設定を隠す');
  ok(/function savePadKinds\(\)\{\s*if\(hbFieldDeny\(\)\)return;/.test(SRC),'品目の保存は関数の入口でも現場用の端末を止める');
})();

head('5. トイレの成功率・失禁率');
(function(){
  const d=ymd(-1);
  const recs=[
    rec(d,'06:00','urine',{urineSrc:'self'}),           // トイレ
    rec(d,'08:00','urine',{urineSrc:'pad'}),            // 失禁
    rec(d,'10:00','urine',{urineSrc:'both'}),           // トイレ＋失禁
    rec(d,'12:00','none'),                              // 空振り
    rec(d,'13:00','none',{pads:'{"尿取りパッド":1}'}),  // 交換だけ → 空振りに数えない
    rec(d,'14:00','stool',{stoolSrc:'toilet'}),         // トイレ
    rec(d,'15:00','stool',{stoolSrc:'pad',pads:'{"テープ式おむつ":1,"尿取りパッド":1}'}),
    rec(d,'16:00','urine'),                             // 排尿元が空の古い記録 → 自尿
    rec(d,'17:00','both',{urineSrc:'pad',stoolSrc:'toilet'}), // 便がトイレなのでトイレで出た1件
    rec(d,'18:00','laxative'),rec(d,'19:00','water',{waterCC:100})
  ];
  const sb=makeSandbox(recs);
  const g=sb.guideStats(recs);
  ok(g.toilet===5,'トイレで出た記録＝5（自尿・自尿＋パッド・トイレ便・空の古い記録・両方の便トイレ）',g);
  ok(g.miss===1,'空振り＝1（交換を付けた「誘導・排泄なし」は数えない）',g);
  ok(Math.abs(g.succ-5/6)<1e-9,'成功率＝5/6');
  ok(g.uN===5&&g.uPad===3&&Math.abs(g.uInc-3/5)<1e-9,'排尿の失禁率＝3/5（パッド内・自尿＋パッド・両方の尿パッド）',g);
  ok(g.sN===3&&g.sPad===1,'排便の失禁率＝1/3',g);
  ok(g.pads===3,'交換の枚数の合計＝3');
  ok(sb.guideStats([]).succ===null&&sb.gsPct(null)==='—','記録が無ければ「—」');
  ok(sb.gsPct(0.75,3,4)==='75%（3/4）','表示は「75%（3/4）」');
  const h=sb.guideRateHtml(1);
  ok(/トイレの成功率・失禁率（週ごと・直近8週）/.test(h),'履歴に週ごとの表が出る');
  ok(/83%（5\/6）/.test(h)||/今週/.test(h),'該当の週に率が出る',h.slice(0,200));
  const body=h.split('<tbody>')[1]||'';
  ok((body.match(/<tr>/g)||[]).length===8,'8週分の行',(body.match(/<tr>/g)||[]).length);
  ok(makeSandbox([]).guideRateHtml(1)==='','記録が1件も無ければ表を出さない');
})();

head('6. 交換したもの: 履歴の月の枚数と、月次の帳票');
(function(){
  const t=ymd(0),ym=t.slice(0,7);
  const pm=(function(){const d=new Date(ym+'-01T00:00:00');d.setMonth(d.getMonth()-1);return ymdOf(d).slice(0,7)})();
  const recs=[rec(ym+'-01','09:00','urine',{urineSrc:'pad',pads:'{"尿取りパッド":2}'}),
              rec(ym+'-01','21:00','none',{pads:'{"夜用パッド":1,"フラット":1}'}),
              rec(pm+'-15','09:00','urine',{urineSrc:'pad',pads:'{"尿取りパッド":1}'})];
  const sb=makeSandbox(recs);
  const h=sb.padUseHtml(1);
  ok(/尿取りパッド 2枚・夜用パッド 1枚・フラット 1枚　計 4枚/.test(h),'今月の品目ごとの枚数と合計',h);
  ok(/先月[^<]*<\/b><\/span><span>尿取りパッド 1枚　計 1枚/.test(h),'先月の枚数');
  sb.__els.rpMonth={value:ym};
  const m=sb.rpPadMonth();
  ok(/<th>フラット<br>\(枚\)<\/th>/.test(m),'品目の一覧に無い品目（過去の記録の品目）も列に出す');
  ok(/<td><b>4<\/b><\/td>/.test(m),'入居者の交換の合計');
  ok(/成功率＝トイレで出た記録/.test(m),'数え方を紙面に書く');
  ok(/'padmonth'/.test(SRC)&&/padmonth:'A4 landscape'/.test(SRC),'月次は A4 横');
})();

head('7. 排便の経過（主治医・訪問看護への一枚もの）');
(function(){
  const end=ymd(0);
  const D0=n=>ymd(-n);
  const recs=[
    rec(D0(20),'09:00','stool',{stoolAmt:'中等量',consistency:'普通',stoolSrc:'toilet'}), // 期間の前の1回分
    rec(D0(10),'08:00','laxative',{medicine:'センノシド',tablets:'2'}),
    rec(D0(10),'20:00','stool',{stoolAmt:'多量',consistency:'柔らかめ',stoolSrc:'pad',notes:'腹部の張りあり'}),
    rec(D0(6),'09:00','stool',{stoolAmt:'少量',consistency:'硬便'}),
    rec(D0(5),'09:00','stool',{stoolAmt:'少量',consistency:'硬便'}),
    rec(D0(5),'20:00','stool',{stoolAmt:'少量',consistency:'硬め'}),   // 48時間以内の3回目 → 1回分
    rec(D0(3),'10:00','urine',{notes:'排尿の備考は載せない'}),
    rec(D0(3),'11:00','water',{waterCC:200}),
  ];
  const sb=makeSandbox(recs,{avgH:50});
  sb.__els.rpDate={value:end};sb.__els.rpSpan={value:'14'};sb.__els.rpRes={value:'all'};
  const ds=sb.rpSpanDates();
  ok(ds.length===14&&ds[13]===end&&ds[0]===D0(13),'2週間＝終わりの日を含めて14日',ds[0]+'..'+ds[13]);
  sb.__els.rpSpan={value:'28'};ok(sb.rpSpanDates().length===28,'4週間＝28日');
  sb.__els.rpSpan={value:'99'};ok(sb.rpSpanDates().length===28,'知らない値は4週間');
  sb.__els.rpSpan={value:'14'};
  const h=sb.rpBowelOne();
  ok(/期間中の排便 <b>4回<\/b>（うち少量 3回）/.test(h),'期間中の排便の回数と少量の回数',h.match(/期間中の排便[^]{0,60}/));
  ok(/排便1回分として数えた回数 <b>2回<\/b>/.test(h),'1回分に数えた回数（多量1＋少量3回で1）');
  ok(new RegExp('最長の日数 <b>9日</b>（'+sb.fmtMD(D0(20))+' の排便のあと）').test(h),'最長の「1回分なし」＝期間の前の1回分（20日前）から数えて11日前の時点で9日',h.match(/最長の日数[^]{0,60}/));
  ok(!/最長の日数 <b>1[0-9]日/.test(h),'6日前・5日前の少量（1回分の手前）では途切れず、5日前の3回目で途切れる');
  ok(/センノシド 2錠 → 12時間後に排便/.test(h),'下剤と反応時間');
  ok(/柔らかめ（ブリストル5） 多量 パッド内/.test(h),'性状にブリストル番号・量・パッド内');
  ok(/腹部の張りあり/.test(h)&&!/排尿の備考は載せない/.test(h),'備考は排便・下剤の分だけ');
  ok(/<td>200<\/td>/.test(h),'水分の合計');
  ok(/2日 2時間|50/.test(h)||/平均の排便間隔/.test(h),'平均の排便間隔は履歴と同じ関数（intervalStats）');
  ok(/'bowelone'/.test(SRC)&&/bowelone:'A4 portrait'/.test(SRC),'一枚ものは A4 縦');
  const sb2=makeSandbox(recs,{hosp:[D0(12)]});
  sb2.__els.rpDate={value:end};sb2.__els.rpSpan={value:'14'};sb2.__els.rpRes={value:'all'};
  const h2=sb2.rpBowelOne();
  ok(/>入院</.test(h2),'入院の日は「入院」');
  ok(/最長の日数 <b>7日<\/b>/.test(h2),'入院をまたぐ間は数えない（退院後は次の1回分から）',h2.match(/最長の日数[^]{0,40}/));
  const sb4=makeSandbox([rec(D0(20),'09:00','stool',{stoolAmt:'中等量'}),rec(D0(2),'09:00','stool',{stoolAmt:'中等量'})],{hosp:[D0(16),D0(15)]});
  sb4.__els.rpDate={value:end};sb4.__els.rpSpan={value:'14'};sb4.__els.rpRes={value:'all'};
  const h4=sb4.rpBowelOne();
  ok(new RegExp('最長の日数 <b>2日</b>（'+sb4.fmtMD(D0(2))+' の排便のあと）').test(h4),'期間より前の入院をまたいだ1回分からは数えない（critic 指摘1）',h4.match(/最長の日数[^]{0,40}/));
  ok(/json\.cfg\.padKinds==null[^]*apiPush\('saveCfg',\{cfg:cfgSendPayload\(\)\}\)/.test(SRC),'サーバーの設定から品目が消えていたら手元の品目で書き戻す（critic 指摘2）');
  const sb3=makeSandbox([Object.assign(rec(D0(1),'09:00','stool',{consistency:'<img src=x onerror=1>'}),{notes:'<script>x</script>'})]);
  sb3.__els.rpDate={value:end};sb3.__els.rpSpan={value:'14'};sb3.__els.rpRes={value:'all'};
  const h3=sb3.rpBowelOne();
  ok(!/<img|<script>/.test(h3),'性状・備考はエスケープする');
})();

head('8. 帳票の画面の作法');
(function(){
  const sc=X.fn('rpSyncCond');
  ok(/rpSpanWrap/.test(sc)&&/isOne/.test(sc),'一枚ものの時だけ期間を出す');
  ok(/RP_VIEW==='bowelone'\)\?rpBowelOne\(\)/.test(X.fn('rpBuildSheet')),'画面に出すで一枚ものを作る');
  ok(/RP_VIEW==='bowelone'\)\?\(rpSpanDates\(\)\[0\]/.test(X.fn('rpBuildSheet')),'端末に無い古い日を含む時の注意書きは、期間の始まりで判定');
  ok(/data-rp="bowelone"/.test(HTML)&&/data-rp="padmonth"/.test(HTML),'帳票のタブが2つ増える');
  ok(!/onclick=/.test(X.fn('renderPadCard')),'交換の欄にインラインのイベント属性を書かない（CSP）');
  ok(/html\.night \.pad-st/.test(HTML),'夜間の配色でも交換のボタンを暗くする');
  ok(/\.pad-st\{min-width:52px;min-height:48px/.test(HTML),'交換のボタンは 48px 以上（手袋でも押せる）');
})();

head('9. 履歴は欄と表を1つのスクロールにする（2026-10-16）');
(function(){
  ok(/<div id="mHistBody">\s*<div id="mHistExtra"><\/div>\s*<div id="mHistC"><\/div>\s*<\/div>/.test(HTML),'排便カレンダーなどの欄と表を同じ入れ物に入れる');
  ok(/#mHist #mHistBody\{flex:1;overflow-y:auto/.test(HTML)&&!/#mHist #mHistC\{[^}]*overflow-y:auto/.test(HTML),'スクロールは入れ物の1つだけ（表だけのスクロールは無い）');
  ok(/var mdc=\$\('mHistBody'\)/.test(SRC),'下まで送ると続きの記録を足す処理も、入れ物のスクロールで動く');
  ok(/<details class="hx-sec"><summary>📅 排便カレンダー/.test(SRC)&&/<details class="hx-sec"><summary>💊 下剤と反応/.test(SRC),'排便カレンダーと下剤と反応は閉じた状態で開く');
})();

head('10. 入力画面のタイルの便の日数は、時系列の「便-N」と同じ暦の日の差（2026-10-19）');
(function(){
  const f=X.fn('renderResTiles');
  ok(/'便'\+Math\.max\(0,dayDiff\(today\(\),String\(ls\.date\|\|ls\.datetime\|\|''\)\.slice\(0,10\)\)\)\+'日'/.test(f),'タイルの日数は 今日 − 最後の排便1回分の日付');
  ok(!/Math\.floor\(sh\/24\)/.test(f),'経過時間÷24 の切り捨ては使わない');
  ok(/var ls=lastR\(r\.id,'s'\)/.test(f)&&/var sDiff=ls\?dayDiff\(ls\.date,date\):null/.test(X.fn('renderTL')),'どちらも同じ「最後の排便1回分」（lastR・少量の決まり込み）から数える');
})();

console.log('\n══════════════════════════════════');
console.log('  ✅ '+pass+' 件  /  ❌ '+fail+' 件');
console.log('══════════════════════════════════');
process.exit(fail?1:0);
