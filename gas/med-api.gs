/***** 薬学管理 GAS Web App（med-api） *****
 * medication.html 専用。入居者マスタGAS(master.gs)とは別スプレッドシート・別デプロイ・別トークン(MED_TOKEN)。
 * 名簿の正本は入居者マスタ、本APIは薬データのみを扱う（su_residents_common は購読側で持つ）。
 * シート meds/events/dict は初回アクセス時に自動作成（ヘッダー行付き）＝手作業不要。
 * デプロイ: デプロイ→新しいデプロイ→ウェブアプリ→実行=自分 / アクセス=全員→ /exec URL を取得。
 * スクリプトプロパティ MED_TOKEN に任意の合言葉（入居者マスタの RMASTER_TOKEN とは別値）を設定。
 * エディタから seedDict() を1回実行してタグ辞書を初期投入する。
 *****/
var MEDS_SHEET = 'meds';
var EVENTS_SHEET = 'events';
var DICT_SHEET = 'dict';
var TOKEN_PROP = 'MED_TOKEN';
var MEDS_HEADERS = ['masterId','name','updatedAt','dataJson'];
var EVENTS_HEADERS = ['eventId','masterId','date','type','drugName','detail','reason','recordedAt'];
var DICT_HEADERS = ['tagId','label','order','active','updatedAt'];
var EVENT_TYPES = ['新規','増量','減量','中止','剤形変更','再開'];

function _sheet(name, headers){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(headers); }
  return sh;
}
function _token(e){
  var exp = PropertiesService.getScriptProperties().getProperty(TOKEN_PROP);
  var got = (e && e.parameter && e.parameter.token) || '';
  if(!got && e && e.postData){ try{ got = JSON.parse(e.postData.contents).token || ''; }catch(err){} }
  return exp && got === exp;
}
function _json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function _err(m){ return _json({error:m}); }
function _asIso(v){ return (v instanceof Date) ? v.toISOString() : (v==null ? '' : String(v)); }
function _asDate(v){ return (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : (v==null ? '' : String(v)); }
function _findRow(sh,id){
  var ids = sh.getRange(1,1,Math.max(sh.getLastRow(),1),1).getValues();
  for(var i=1;i<ids.length;i++){ if(String(ids[i][0])===String(id)) return i+1; }
  return -1;
}

function doGet(e){
  try{
    if(!_token(e)) return _err('unauthorized');
    var a = (e && e.parameter && e.parameter.action) || '';
    if(a==='ping') return _json({ok:true});
    if(a==='getAll') return _json({ok:true, serverTime:new Date().toISOString(), meds:_readMeds(), events:_readEvents(), dict:_readDict()});
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
}
function doPost(e){
  var lock = LockService.getScriptLock();
  try{
    lock.waitLock(10000);
    if(!_token(e)) return _err('unauthorized');
    var b = JSON.parse(e.postData.contents);
    if(b.action==='saveMeds') return saveMeds(b);
    if(b.action==='saveDict') return saveDict(b);
    if(b.action==='deleteEvent') return deleteEvent(b);
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
  finally{ try{ lock.releaseLock(); }catch(e2){} }
}

/* ---- 読み取り（getAll 用・全量返却） ---- */
function _readMeds(){
  var sh=_sheet(MEDS_SHEET, MEDS_HEADERS), v=sh.getDataRange().getValues(), out=[];
  for(var i=1;i<v.length;i++){ var r=v[i]; if(r[0]==='') continue;
    var cm=[]; try{ var d=JSON.parse(r[3]||'{}'); cm=Array.isArray(d.currentMeds)?d.currentMeds:[]; }catch(err){}
    out.push({ masterId:String(r[0]), name:r[1], updatedAt:_asIso(r[2]), currentMeds:cm });
  }
  return out;
}
function _readEvents(){
  var sh=_sheet(EVENTS_SHEET, EVENTS_HEADERS), v=sh.getDataRange().getValues(), out=[];
  for(var i=1;i<v.length;i++){ var r=v[i]; if(r[0]==='') continue;
    out.push({ eventId:String(r[0]), masterId:String(r[1]), date:_asDate(r[2]), type:r[3],
               drugName:r[4], detail:r[5], reason:r[6], recordedAt:_asIso(r[7]) });
  }
  return out;
}
function _readDict(){
  var sh=_sheet(DICT_SHEET, DICT_HEADERS), v=sh.getDataRange().getValues(), out=[];
  for(var i=1;i<v.length;i++){ var r=v[i]; if(r[0]==='') continue;
    out.push({ tagId:String(r[0]), label:r[1], order:Number(r[2])||0,
               active:(r[3]!==false && r[3]!=='false'), updatedAt:_asIso(r[4]) });
  }
  return out;
}

/* ---- 薬データ保存（イベント driven／一括登録 共通） ---- */
function _cleanMed(m){
  m = m||{}; var t = m.timing||{};
  return {
    id: m.id||'', name: m.name||'', dose: m.dose||'',
    timing: { slots: Array.isArray(t.slots)?t.slots:[], prn: t.prn===true, free: t.free||'' },
    tags: Array.isArray(m.tags)?m.tags:[], startDate: m.startDate||'', note: m.note||''
  };
}
function _appendEvents(events, defaultMasterId){
  if(!events.length) return;
  var sh=_sheet(EVENTS_SHEET, EVENTS_HEADERS), seen={};
  var ids=sh.getRange(1,1,Math.max(sh.getLastRow(),1),1).getValues();
  for(var i=1;i<ids.length;i++){ if(ids[i][0]!=='') seen[String(ids[i][0])]=true; }
  var rows=[];
  for(var j=0;j<events.length;j++){ var ev=events[j];
    var eid = (ev.eventId!=null && ev.eventId!=='') ? String(ev.eventId) : Utilities.getUuid();
    if(seen[eid]) continue; seen[eid]=true;
    rows.push([ eid, String(ev.masterId||defaultMasterId||''), ev.date||'', ev.type||'',
                ev.drugName||'', ev.detail||'', ev.reason||'', new Date().toISOString() ]);
  }
  if(rows.length){
    var startRow=sh.getLastRow()+1;
    // date 列（C）はテキスト書式に固定してから書く。Sheets が 'YYYY-MM-DD' を Date 化すると、
    // プロジェクトTZとシートTZの不一致で読み戻し時に1日ずれる（updatedAt 列と同じ往復破損対策）。
    sh.getRange(startRow,3,rows.length,1).setNumberFormat('@');
    sh.getRange(startRow,1,rows.length,EVENTS_HEADERS.length).setValues(rows);
  }
}
function saveMeds(b){
  var masterId = b.masterId;
  if(masterId==null || masterId==='') return _err('invalid');
  var record = b.record||{}, cm = record.currentMeds;
  if(!Array.isArray(cm)) return _err('invalid');
  var events = Array.isArray(b.events)?b.events:[];
  for(var i=0;i<events.length;i++){ if(EVENT_TYPES.indexOf(events[i].type)<0) return _err('invalid'); }

  var sh=_sheet(MEDS_SHEET, MEDS_HEADERS), row=_findRow(sh, masterId);
  var existingCm=[], existingUpdatedAt='';
  if(row>0){
    var rv=sh.getRange(row,1,1,MEDS_HEADERS.length).getValues()[0];
    existingUpdatedAt=_asIso(rv[2]);
    try{ var d=JSON.parse(rv[3]||'{}'); existingCm=Array.isArray(d.currentMeds)?d.currentMeds:[]; }catch(e){}
  }
  if(row>0 && String(b.baseUpdatedAt||'') !== String(existingUpdatedAt)) return _err('CONFLICT');
  if(cm.length===0 && existingCm.length>0 && b.confirmEmpty!==true) return _err('EMPTY_GUARD');

  var clean = cm.map(_cleanMed);
  var updatedAt = new Date().toISOString();
  var name = b.name||'';
  // 凍結仕様のステップ順（4. events append → 5. meds upsert）を厳守する。events は eventId 冪等
  // append なので、後段の meds 書込が失敗しても再試行時に events は重複スキップされ meds だけ再書込
  // される。逆順（meds 先）だと meds 書込成功後に events 書込が失敗した場合に updatedAt だけ進み、
  // 再試行が旧 baseUpdatedAt で偽 CONFLICT になって変更イベントが台帳から永久に欠落する。
  _appendEvents(events, masterId);
  var vals=[ String(masterId), name, updatedAt, JSON.stringify({currentMeds:clean}) ];
  var wRow = row>0 ? row : sh.getLastRow()+1;
  // updatedAt 列（C）はテキスト書式で固定してから書く。Sheets が ISO 文字列を Date 化して
  // ミリ秒を落とすと、保存応答の updatedAt と次回読み戻し値が食い違い、2回目以降の保存が
  // 偽 CONFLICT になる（楽観ロックは文字列完全一致）。テキスト固定で文字列を verbatim 保持する。
  sh.getRange(wRow,3,1,1).setNumberFormat('@');
  sh.getRange(wRow,1,1,MEDS_HEADERS.length).setValues([vals]);
  return _json({ok:true, record:{ masterId:String(masterId), name:name, updatedAt:updatedAt, currentMeds:clean }});
}

/* ---- タグ辞書 全置換 ---- */
function saveDict(b){
  var dict = Array.isArray(b.dict)?b.dict:[];
  var sh=_sheet(DICT_SHEET, DICT_HEADERS), existing=_readDict();
  if(dict.length===0 && existing.length>0 && b.confirmEmpty!==true) return _err('EMPTY_GUARD');
  var now=new Date().toISOString();
  var rows=dict.map(function(d){
    return [ String(d.tagId||Utilities.getUuid()), d.label||'', (d.order==null?0:Number(d.order)||0), d.active!==false, now ];
  });
  // 新行を先に上書き → 成功後に余剰の旧行だけを消す。clearContent 先行だと setValues 失敗時に
  // シートが空のまま残り「保存失敗が既存データ破壊」になる（読み書き失敗時は既存を残す安全側フォールバック）。
  var lastBefore=sh.getLastRow();
  if(rows.length) sh.getRange(2,1,rows.length,DICT_HEADERS.length).setValues(rows);
  var surplusFrom=2+rows.length; // 新件数より下に残る旧行の開始
  if(lastBefore>=surplusFrom) sh.getRange(surplusFrom,1,lastBefore-surplusFrom+1,DICT_HEADERS.length).clearContent();
  return _json({ok:true, dict:_readDict()});
}

/* ---- イベント削除（誤入力訂正用） ---- */
function deleteEvent(b){
  var eid=b.eventId;
  if(eid==null || eid==='') return _err('not_found');
  var sh=_sheet(EVENTS_SHEET, EVENTS_HEADERS), row=_findRow(sh, eid);
  if(row<0) return _err('not_found');
  sh.deleteRow(row);
  return _json({ok:true, eventId:String(eid)});
}

/* ---- 既定タグ投入（エディタから手動1回実行）。非空なら何もしない ---- */
function seedDict(){
  var sh=_sheet(DICT_SHEET, DICT_HEADERS);
  if(sh.getLastRow()>1) return;
  var labels=['鎮静','抗コリン','転倒リスク','食欲低下起因','便秘起因','出血リスク','低血糖リスク'];
  var now=new Date().toISOString();
  var rows=labels.map(function(l,i){ return [ Utilities.getUuid(), l, i+1, true, now ]; });
  sh.getRange(2,1,rows.length,DICT_HEADERS.length).setValues(rows);
}

/* ══════════════════════════════════════════════════════════════════
 * デモ用ヘルパー（本番APIには関与しない・doGet/doPostから到達不可）。
 * seedDemo() = 使い方確認用の架空データ8名を投入（masterIdは 'demo-' 接頭）。
 * clearDemo() = 'demo-' 接頭の行を meds/events から全削除（本運用前の掃除用）。
 * 実在の入居者データとは masterId 接頭辞で分離。エディタから手動実行する。
 * ══════════════════════════════════════════════════════════════════ */
function seedDemo(){
  var medsSh=_sheet(MEDS_SHEET, MEDS_HEADERS), evSh=_sheet(EVENTS_SHEET, EVENTS_HEADERS);
  var T={}; _readDict().forEach(function(d){ T[d.label]=d.tagId; });
  function tag(){ var a=[]; for(var i=0;i<arguments.length;i++){ if(T[arguments[i]]) a.push(T[arguments[i]]); } return a; }
  function iso(n){ var d=new Date(); d.setDate(d.getDate()-n); return d.toISOString(); }
  function ymd(n){ var d=new Date(); d.setDate(d.getDate()-n); return Utilities.formatDate(d, Session.getScriptTimeZone(),'yyyy-MM-dd'); }
  function M(id,name,dose,slots,prn,free,tags,note){ return {id:id,name:name,dose:dose,timing:{slots:slots||[],prn:!!prn,free:free||''},tags:tags||[],startDate:'',note:note||''}; }
  var R=[
    { mid:'demo-01', name:'デモ利用者01', up:2, meds:[
        M('d1a','アムロジピン','5mg',['朝'],false,'',tag('転倒リスク'),'降圧'),
        M('d1b','ゾルピデム','5mg',['眠前'],false,'',tag('転倒リスク','鎮静'),'不眠時の定時'),
        M('d1c','ランソプラゾール','15mg',['朝'],false,'',[],''),
        M('d1d','アトルバスタチン','10mg',['夕'],false,'',[],''),
        M('d1e','センノシド','12mg',['眠前'],false,'',tag('便秘起因'),''),
        M('d1f','カルベジロール','2.5mg',['朝','夕'],false,'',[],''),
        M('d1g','ロキソプロフェン','60mg',[],true,'疼痛時',[],'頓服') ],
      ev:[ {d:ymd(2),t:'増量',dr:'アムロジピン',de:'2.5mg→5mg',re:'血圧コントロール不良のため'},
           {d:ymd(20),t:'新規',dr:'ゾルピデム',de:'5mg 眠前 開始',re:'入眠困難の訴え'},
           {d:ymd(60),t:'剤形変更',dr:'アトルバスタチン',de:'錠→OD錠',re:'嚥下しづらさのため'} ] },
    { mid:'demo-02', name:'デモ利用者02', up:22, meds:[
        M('d2a','マグミット','330mg',['朝','昼','夕'],false,'',tag('便秘起因'),'緩下剤'),
        M('d2b','ドネペジル','5mg',['朝'],false,'',[],''),
        M('d2c','ピコスルファート','内用液',[],true,'排便なき時',[],'頓服') ],
      ev:[ {d:ymd(22),t:'中止',dr:'ブロチゾラム',de:'0.25mg 眠前 中止',re:'日中傾眠・ふらつきのため減薬'},
           {d:ymd(40),t:'減量',dr:'ドネペジル',de:'10mg→5mg',re:'食欲低下・消化器症状'} ] },
    { mid:'demo-03', name:'デモ利用者03', up:5, meds:[
        M('d3a','ワルファリン','2mg',['朝'],false,'',tag('出血リスク'),'PT-INR管理'),
        M('d3b','グリメピリド','1mg',['朝'],false,'',tag('低血糖リスク'),''),
        M('d3c','メトホルミン','250mg',['朝','夕'],false,'',tag('低血糖リスク'),''),
        M('d3d','ファモチジン','10mg',['朝'],false,'',[],''),
        M('d3e','酸化マグネシウム','250mg',['朝','夕'],false,'',tag('便秘起因'),'') ],
      ev:[ {d:ymd(5),t:'新規',dr:'グリメピリド',de:'1mg 朝 開始',re:'HbA1c上昇のため'},
           {d:ymd(35),t:'増量',dr:'メトホルミン',de:'250mg→500mg/日',re:'血糖コントロール'} ] },
    { mid:'demo-04', name:'デモ利用者04', up:8, meds:[
        M('d4a','ソリフェナシン','5mg',['朝'],false,'',tag('抗コリン'),'過活動膀胱'),
        M('d4b','エチゾラム','0.5mg',[],true,'不穏時',tag('鎮静','転倒リスク'),'頓服'),
        M('d4c','ビオフェルミン','錠',['朝','昼','夕'],false,'',[],'') ],
      ev:[ {d:ymd(90),t:'中止',dr:'ソリフェナシン',de:'口渇・便秘のため一旦中止',re:'抗コリン負荷の見直し'},
           {d:ymd(8),t:'再開',dr:'ソリフェナシン',de:'5mg 朝 再開',re:'頻尿再燃・水分管理で経過観察'} ] },
    { mid:'demo-05', name:'デモ利用者05', up:3, meds:[
        M('d5a','レボチロキシン','50μg',['朝'],false,'',[],'甲状腺'),
        M('d5b','カルシウム/VD','錠',['朝'],false,'',[],''),
        M('d5c','ロスバスタチン','2.5mg',['夕'],false,'',[],''),
        M('d5d','アセトアミノフェン','300mg',[],true,'発熱・疼痛時',[],'頓服') ],
      ev:[ {d:ymd(3),t:'新規',dr:'ロスバスタチン',de:'2.5mg 夕 開始',re:'脂質異常'},
           {d:ymd(50),t:'剤形変更',dr:'レボチロキシン',de:'一包化から別包へ',re:'吸着回避のため単剤化'} ] },
    { mid:'demo-06', name:'デモ利用者06', up:16, meds:[
        M('d6a','ニフェジピン','20mg',['朝','夕'],false,'',tag('転倒リスク'),'降圧'),
        M('d6b','クエチアピン','25mg',['眠前'],false,'',tag('鎮静','転倒リスク'),'BPSD'),
        M('d6c','トリヘキシフェニジル','2mg',['朝','夕'],false,'',tag('抗コリン'),''),
        M('d6d','グリクラジド','40mg',['朝'],false,'',tag('低血糖リスク'),''),
        M('d6e','フロセミド','20mg',['朝'],false,'',tag('転倒リスク'),'利尿'),
        M('d6f','ランソプラゾール','15mg',['朝'],false,'',[],''),
        M('d6g','センノシド','12mg',['眠前'],false,'',tag('便秘起因'),''),
        M('d6h','アムロジピン','5mg',['朝'],false,'',tag('転倒リスク'),'') ],
      ev:[ {d:ymd(16),t:'増量',dr:'クエチアピン',de:'12.5mg→25mg',re:'夜間不穏の増悪'},
           {d:ymd(30),t:'新規',dr:'フロセミド',de:'20mg 朝 開始',re:'下腿浮腫'},
           {d:ymd(70),t:'新規',dr:'トリヘキシフェニジル',de:'2mg 朝夕 開始',re:'錐体外路症状'},
           {d:ymd(100),t:'減量',dr:'ニフェジピン',de:'40mg→20mg/回',re:'起立性低血圧' } ] },
    { mid:'demo-08', name:'デモ利用者08', up:6, meds:[
        M('d8a','ジゴキシン','0.125mg',['朝'],false,'',tag('食欲低下起因'),'心不全・中毒に注意'),
        M('d8b','ビソプロロール','2.5mg',['朝'],false,'',[],''),
        M('d8c','スピロノラクトン','25mg',['朝'],false,'',[],'') ],
      ev:[ {d:ymd(6),t:'新規',dr:'ジゴキシン',de:'0.125mg 朝 開始',re:'心房細動レートコントロール'},
           {d:ymd(45),t:'中止',dr:'アスピリン',de:'100mg 中止',re:'消化管出血リスク・抗凝固へ一本化'} ] }
  ];
  var evRows=[];
  R.forEach(function(r){
    var row=_findRow(medsSh, r.mid);
    var vals=[ r.mid, r.name, iso(r.up), JSON.stringify({currentMeds:r.meds}) ];
    var wRow = row>0 ? row : medsSh.getLastRow()+1;
    medsSh.getRange(wRow,3,1,1).setNumberFormat('@');
    medsSh.getRange(wRow,1,1,MEDS_HEADERS.length).setValues([vals]);
    (r.ev||[]).forEach(function(e){
      evRows.push([ Utilities.getUuid(), r.mid, e.d, e.t, e.dr, e.de, e.re, new Date().toISOString() ]);
    });
  });
  if(evRows.length){
    var start=evSh.getLastRow()+1;
    evSh.getRange(start,3,evRows.length,1).setNumberFormat('@');
    evSh.getRange(start,1,evRows.length,EVENTS_HEADERS.length).setValues(evRows);
  }
}
function clearDemo(){
  [ [_sheet(MEDS_SHEET,MEDS_HEADERS),0], [_sheet(EVENTS_SHEET,EVENTS_HEADERS),1] ].forEach(function(p){
    var sh=p[0], midCol=p[1], v=sh.getDataRange().getValues();
    for(var i=v.length-1;i>=1;i--){ if(String(v[i][midCol]).indexOf('demo-')===0) sh.deleteRow(i+1); }
  });
}
