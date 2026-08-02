/***** 入居者マスタ GAS Web App *****
 * 「入居者情報」スプレッドシートにバインドして使用（拡張機能→Apps Script）。
 * 入居者マスタは 'master' タブに 1行=1名 で保存。
 * デプロイ: デプロイ→新しいデプロイ→ウェブアプリ→実行=自分 / アクセス=全員→ /exec URL を取得
 *
 * ── スクリプトプロパティ（合言葉）──
 *   RMASTER_TOKEN       … 事務所用。全機能（閲覧・保存）
 *   RMASTER_TOKEN_FIELD … 現場タブレット用。**安全項目の閲覧のみ**（任意。設定しなければ現場配布なし）
 *
 * ★重要: 端末の用途(su_device_role)はブラウザ側の値なので詐称できる。
 *   したがって現場端末の制限は「現場用トークンでは安全項目しか返さない」というサーバ側の判定で担保する。
 *   現場タブレットには RMASTER_TOKEN_FIELD だけを配り、RMASTER_TOKEN は絶対に配らないこと。
 *****/
var MASTER_SHEET = 'master';
var TOKEN_PROP = 'RMASTER_TOKEN';
var TOKEN_PROP_FIELD = 'RMASTER_TOKEN_FIELD';
var FIELD_SECTION = 'facesheet_safe';   // 現場トークンで参照を許す唯一のセクション
var HEADERS = ['id','name','kana','room','gender','careLevel','active','updatedAt','dataJson','targetApps'];

/* ═══════════ 状態（入院中）の版数まわり ═══════════ 2026-08-02 追加
 * 背景: 入居者マスタ画面の「入院にする／退院」は action=setState を呼ぶが、
 *       この GAS に未実装で `不明なaction` を返していた（＝ボタンが動いていなかった）。
 *       また購読側（マスタ・週間計画・体重）は ?action=stateRev で版数を見張って
 *       名簿を取り直す設計だが、これも未実装で常に失敗していた。
 *
 * 版数は2本立て:
 *   rev  … この GAS 自身の状態版数。setState のたびに +1（スクリプトプロパティ）。
 *   srev … 排泄記録GAS が meta!A1 に刻む更新時刻(エポックms)。**こちらは読むだけ**。
 *          書き手を1つに限ることで、2つの GAS が同じセルを奪い合う事故を防ぐ。
 * 購読側は「rev と srev のどちらかが動いたら取り直す」ため、どちらの経路の
 * 変更も 60〜90 秒で全アプリに伝わる。 */
var STATE_REV_PROP = 'RMASTER_STATE_REV';
var META_SHEET     = 'meta';            // 排泄記録GAS 側の MASTER_META_SHEET_NAME と同じ
var STATE_LOG_MAX  = 50;                // stateLog は先頭追記・最大50件（排泄記録GAS と同じ）

/* 現在の rev。未設定・壊れた値は 0 として扱う（版数が読めない＝購読側は取り直す側に倒れる） */
function _stateRev(){
  var v = PropertiesService.getScriptProperties().getProperty(STATE_REV_PROP);
  var n = parseInt(v, 10);
  return (isNaN(n) || n < 0) ? 0 : n;
}
/* rev を1つ進める。失敗しても状態更新そのものは成功扱いにする（伝播が遅れるだけ） */
function _bumpStateRev(){
  try{
    var n = _stateRev() + 1;
    PropertiesService.getScriptProperties().setProperty(STATE_REV_PROP, String(n));
    return n;
  }catch(err){ console.error('bumpStateRev skipped: ' + err); return _stateRev(); }
}
/* meta!A1（排泄記録GAS が刻む時刻）を読む。無ければ 0。**書かない**。 */
function _metaSrev(){
  try{
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(META_SHEET);
    if(!sh) return 0;
    var n = Number(sh.getRange(1,1).getValue());
    return (isFinite(n) && n >= 0) ? n : 0;
  }catch(err){ return 0; }
}

function _sheet(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MASTER_SHEET);
  if(!sh){ sh = ss.insertSheet(MASTER_SHEET); sh.appendRow(HEADERS); }
  return sh;
}
/* 合言葉から権限を判定して返す。'full' | 'field' | '' (不正) */
function _role(e){
  var p = PropertiesService.getScriptProperties();
  var full = p.getProperty(TOKEN_PROP);
  var field = p.getProperty(TOKEN_PROP_FIELD);
  var got = (e && e.parameter && e.parameter.token) || '';
  if(!got && e && e.postData){ try{ got = JSON.parse(e.postData.contents).token || ''; }catch(err){} }
  if(!got) return '';
  if(full && got === full) return 'full';
  if(field && got === field) return 'field';
  return '';
}
function _json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function _err(m){ return _json({error:m}); }
function _truthy(v){ return v!==false && v!=='false' && v!=='退去' && v!==''; }

function doGet(e){
  try{
    var a0 = (e && e.parameter && e.parameter.action) || '';
    /* ── 版数だけの照会は合言葉なしで通す（2026-08-02 追加）──
       購読側は数十秒おきにこれを叩く。返すのは数値2つだけで、
       氏名も件数も返さない＝個人情報ゼロ。シートは meta の1セルしか触らない。
       ★認証の前に置くのは意図的。合言葉を配れない経路（週間計画・体重の
         端末設定違い）からも版数だけは見えるようにするため。 */
    if(a0==='stateRev') return _json({ok:true, rev:_stateRev(), srev:_metaSrev()});

    var role = _role(e);
    if(!role) return _err('認証エラー');
    var a = a0;
    if(a==='ping') return _json({ok:true, role:role});

    // ── 現場トークン: 安全項目の参照のみ許可（名簿・個人フル・保存は不可）──
    if(role==='field'){
      if(a==='getSection' && e.parameter.section===FIELD_SECTION){
        // 退去者は現場に出さない（id総当たりで退去者を読まれるのを防ぐ）
        var rec = getResident(e.parameter.id);
        if(!rec || rec.active===false) return _json({section:null});
        return _json({section:getSection(e.parameter.id, FIELD_SECTION)});
      }
      if(a==='getRoster') return _json({roster:getRosterSafe()});
      return _err('この端末では参照できません（現場用の合言葉です）');
    }

    // ── 事務所トークン: 全機能 ──
    /* 名簿にも版数2つを同梱する（2026-08-02 追加）。
       購読側は取得と同時に基準を最新化でき、直後の再照会が1回減る。 */
    if(a==='getRoster') return _json({roster:getRoster(e.parameter.since), stateRev:_stateRev(), srev:_metaSrev()});
    if(a==='getResident') return _json({record:getResident(e.parameter.id)});
    if(a==='getSection') return _json({section:getSection(e.parameter.id, e.parameter.section)});
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
}
function doPost(e){
  try{
    var role = _role(e);
    if(!role) return _err('認証エラー');
    if(role!=='full') return _err('この端末では保存できません（現場用の合言葉です）');
    var b = JSON.parse(e.postData.contents);
    if(b.action==='saveResident') return _json({record:saveResident(b.record)});
    if(b.action==='setState')     return _json(setState(b));   // 入院/退院の部分更新（2026-08-02 追加）
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
}
/* 現場向けの名簿（在籍者の識別項目のみ。退去者・更新日時・対象アプリは返さない） */
function getRosterSafe(){
  /* 拡張項目は捨てるので parse させない（現場タブレットの名簿取得を重くしない） */
  return getRoster(null,true).filter(function(r){ return r.active!==false; })
    .map(function(r){ return {id:r.id, name:r.name, kana:r.kana, room:r.room, gender:r.gender, careLevel:r.careLevel, active:true}; });
}

/* 一覧に出すために dataJson から取り出す項目。
   ★ここに増やしてよいのは「事務所の一覧画面に出す非機微項目」だけ。
     現場端末には getRosterSafe() が明示フィールドだけを組み直して返すので流れない。
     病名・処方・家族連絡先など要配慮情報は絶対に足さないこと（一覧APIは端末キャッシュに載る）。 */
/* 2026-08-02 追加分:
   ・dischargeDate … 共有名簿へ配信するつもりの実装（resident-master の normRosterRow/
     writeCommonRoster）が既にあるのに、ここに無いため常に空が配られていた。
     結果、体重管理の退去日が「同期した日」に化けていた。
   ・doctor / visitDay / hospital … 訪問診療アプリが取込のたびに全員分 getResident を
     1件ずつ直列で叩いていた（100名で15秒超）。一覧に載せれば getRoster 1発で済む。
   ★いずれも非機微。病名・処方・家族連絡先などの要配慮情報は絶対に足さないこと（上の注記）。
   ★値は String() で文字列に寄せられる（下の実装）。真偽値を足す場合はここではなく
     hospitalized と同じく個別処理にすること。 */
var ROSTER_EXTRA = ['birthDate','height','dischargeDate','doctor','visitDay','hospital'];

function getRoster(since, skipExtra){
  var sh=_sheet(), v=sh.getDataRange().getValues(), out=[], s=since?new Date(since).getTime():0;
  for(var i=1;i<v.length;i++){ var r=v[i]; if(r[0]==='') continue;
    if(s){ var u=r[7]?new Date(r[7]).getTime():0; if(u<s) continue; }
    var e={ id:r[0], name:r[1], kana:r[2], room:r[3], gender:r[4], careLevel:r[5],
            active:_truthy(r[6]), updatedAt:r[7], targetApps:String(r[9]||'') };
    /* dataJson（H列）は既に読み込み済みなので追加のシート読み取りは発生しない。
       壊れた JSON があっても一覧全体を落とさない（その人だけ空欄になる）。 */
    if(!skipExtra){
      var d=null; try{ d=JSON.parse(r[8]||'{}'); }catch(err){ d=null; }
      /* ── 入院中（2026-08-02 追加）──
         ★ROSTER_EXTRA には入れない。あちらは値を String() で文字列に寄せるため、
           false が文字列 "false"（＝真）になって全員入院中になってしまう。
           真偽のまま返す必要があるので、ここで個別に扱う。
         ★dataJson にキーが**在る時だけ**載せる。無い人に false を捏造すると、
           消費側の「マスタ常勝」が現場の入院フラグを一括で倒す（デプロイ順の事故）。
         ★これが無いために、入院状態は共有名簿にも各アプリにも一切配信されておらず、
           排泄ケア記録・入居者マスタで入院にしても他アプリに反映されなかった。 */
      if(d && Object.prototype.hasOwnProperty.call(d,'hospitalized')){
        e.hospitalized = (d.hospitalized === true || d.hospitalized === 'true');
      }
      for(var k=0;k<ROSTER_EXTRA.length;k++){
        var key=ROSTER_EXTRA[k];
        if(e[key]!==undefined) continue;                 // シート列の値を dataJson で上書きしない
        var val=(d && d[key]!=null) ? d[key] : '';
        /* 数値やオブジェクトが入っていても画面が壊れないよう文字列に寄せる
           （オブジェクトは値を持たないものとして扱う） */
        e[key]=(typeof val==='object') ? '' : String(val);
      }
    }
    out.push(e);
  }
  return out;
}

/* 一覧APIの拡張が効いているかを確認する（読み取りのみ・値は出さない）。
   GASエディタで直接実行して使う。件数と充足率だけを出し、生年月日そのものはログに残さない
   （実行ログは Cloud Logging に残り、後から回収できないため）。 */
function verifyRoster(){
  var all=getRoster();
  Logger.log('■ getRoster: '+all.length+'名');
  var cnt={};
  ROSTER_EXTRA.forEach(function(k){ cnt[k]=0; });
  all.forEach(function(r){ ROSTER_EXTRA.forEach(function(k){ if(String(r[k]||'')!=='') cnt[k]++; }); });
  ROSTER_EXTRA.forEach(function(k){
    Logger.log('   '+k+': 入力済 '+cnt[k]+'/'+all.length+'名'+(cnt[k]?'':'  ⚠️ 0件。dataJson に値が無いか項目名が違う'));
  });
  /* ★現場端末に漏れないことの機械確認。getRosterSafe は明示フィールドだけを組み直す実装なので
     ROSTER_EXTRA が1つでも混じっていたら実装が壊れている。 */
  var safe=getRosterSafe();
  var leak=[];
  if(safe.length){
    ROSTER_EXTRA.forEach(function(k){ if(k in safe[0]) leak.push(k); });
  }
  Logger.log(leak.length
    ? '❌ 現場用の名簿に '+leak.join(',')+' が含まれています。getRosterSafe を確認してください'
    : '✅ 現場用の名簿には拡張項目が含まれていません（現場端末へ漏れない）');
  Logger.log('   現場用の名簿: '+safe.length+'名（在籍者のみ）／返すキー: '+(safe.length?Object.keys(safe[0]).join(','):'—'));
}
function _findRow(sh,id){
  var ids=sh.getRange(1,1,Math.max(sh.getLastRow(),1),1).getValues();
  for(var i=1;i<ids.length;i++){ if(String(ids[i][0])===String(id)) return i+1; }
  return -1;
}
function getResident(id){
  var sh=_sheet(), row=_findRow(sh,id); if(row<0) return null;
  var v=sh.getRange(row,1,1,HEADERS.length).getValues()[0], data={};
  try{ data=JSON.parse(v[8]||'{}'); }catch(e){}
  data.id=v[0]; data.name=v[1]; data.kana=v[2]; data.room=v[3]; data.gender=v[4];
  data.careLevel=v[5]; data.active=_truthy(v[6]); data.updatedAt=v[7];
  if(v[9]) data.targetApps=String(v[9]).split(',').map(function(x){return x.trim();}).filter(String);
  return data;
}
function getSection(id, section){
  var rec=getResident(id); if(!rec) return null;
  var map={
    basic:['gender','birthDate','phone','careLevel','careCertStart','careCertEnd','certDate','copayRate','welfare','insuredNo','insurer','medicalInsurance','disabilityCert','guardianship','admissionDate','dischargeDate','deathDate','height','weight','adl','dementia'],
    careHistory:['careLevelHistory'],
    note:['preAdmission','postDischarge','dischargeTo'],
    family:['family'],
    consents:['consents'],
    office:['careOffice','careManager','careOfficeTel','careOfficeFax','welfareEquip','welfareEquipStaff','welfareEquipTel','serviceManager','prevCareOffice','prevCareManager','dayUse','rhythm'],
    medical:['hospital','doctor','hospitalTel','hospitalFax','emergencyHospital','emergencyHospitalTel','visitDay','pharmacy','pharmacyTel','pharmacyFax','allergy','infections','bloodType','medicalCare','vaccinations','disclosure','currentDiseases','sideEffects','pastHistory','medsRegular','medsNotes','problemBehavior'],
    meds:['medMgmt','medAssist','highRiskMeds','formAdjust','medRefusal','medsPrn','medsPastLog'],
    adl_detail:['swallow','water','excretion','bath','dress','mobility','transfer','bedriddenRank','pressureUlcer','vision','hearing'],
    cognitive:['dementiaType','cogScore','careHints','psychHistory'],
    comm:['preferredName','commMethod','commNotes'],
    meal:['mealStaple','mealSide','mealForm','thickener','denture','mealNote'],
    person:['personality','hobby','foodPref','lifePrefs','smoking','drinking'],
    history:['lifeHistory','values'],
    wishes:['complaint','wishSelf','wishFamily','goal','acp','dnar','strengths'],
    support:['supportLog'],
    medSupport:['medicalSupportLog'],
    // 現場タブレット(field)向け「安全情報のみ」。家族連絡先・経済・詳細病歴・服薬の薬剤名は含めない。
    // ★この20項目は resident-master.html / facesheet.html の SAFE_FIELDS と完全一致させること（3箇所契約）。
    // 2026-08-02: hospitalized を追加。クライアント2箇所は20項目なのにここだけ19項目で、
    //   契約が破れていた。そのため現場タブレットのフェイスシートに「🏥 入院中」チップが
    //   永久に出ていなかった（事務所ロールは getResident で dataJson 全体が返るので出ていた）。
    facesheet_safe:['name','kana','room','gender','preferredName','allergy','infections','medicalCare','formAdjust','careHints','mealForm','thickener','swallow','denture','mobility','problemBehavior','medMgmt','medAssist','medRefusal','hospitalized']
  };
  var keys=map[section]; if(!keys) return null;
  var out={id:rec.id,name:rec.name}; keys.forEach(function(k){ out[k]=rec[k]; }); return out;
}
function saveResident(rec){
  var sh=_sheet();
  if(rec.id==null||rec.id===''){
    var ids=sh.getRange(1,1,Math.max(sh.getLastRow(),1),1).getValues(), max=0;
    for(var i=1;i<ids.length;i++){ var n=parseInt(ids[i][0],10); if(!isNaN(n)&&n>max) max=n; }
    rec.id=max+1;
  }
  rec.updatedAt = rec.updatedAt || new Date().toISOString();
  var vals=[rec.id, rec.name||'', rec.kana||'', rec.room||'', rec.gender||'', rec.careLevel||'',
            rec.active!==false, rec.updatedAt, JSON.stringify(rec),
            Array.isArray(rec.targetApps)?rec.targetApps.join(','):''];
  var row=_findRow(sh,rec.id);
  if(row<0) sh.appendRow(vals); else sh.getRange(row,1,1,HEADERS.length).setValues([vals]);
  return rec;
}

/* ═══════════ setState: 入院/退院だけの部分更新 ═══════════ 2026-08-02 追加
 * body = {action:'setState', id, hospitalized, src, token}
 * 応答 = {ok:true, hospitalized:bool, hospitalizedAt:ISO}
 *
 * 設計は排泄記録GAS の setMasterState_ と揃える（同じ dataJson を2つのGASが触るため）:
 *   ・dataJson の hospitalized / hospitalizedAt / stateLog の**3キーだけ**を書き換える。
 *     氏名・医療情報など他のキーは読み書きせずそのまま温存する（部分更新）。
 *   ・dataJson が JSON として読めない時は **1文字も書かずに中止**する。
 *     壊れた値を上書きして既存データを失わない（dev-principles 原則4）。
 *   ・stateLog は先頭追記・最大50件。src は呼び出し元（'master'）をそのまま記録する。
 *
 * 排泄記録GAS との違い:
 *   ・meta!A1 は**触らない**。あちらが唯一の書き手＝書き込み衝突を起こさない。
 *     こちらは代わりに自分の rev を進める。購読側は rev と srev の両方を見ている。
 *   ・updatedAt（G列）は更新しない。あちらも更新しないため挙動を揃える。
 *     購読側の取り直しは rev/srev で起きるので、これで伝播に支障はない。
 */
function setState(body){
  if(!body || body.id==null || body.id==='') return {ok:false, error:'IDがありません'};
  var hz = (body.hospitalized === true || body.hospitalized === 'true');
  var src = String(body.src || 'master').slice(0, 20);

  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(err){ return {ok:false, error:'混み合っています。少し待って再度お試しください'}; }
  try{
    var sh = _sheet();
    var row = _findRow(sh, body.id);
    if(row < 0) return {ok:false, error:'該当する方が見つかりません'};

    var cell = sh.getRange(row, 9);           // dataJson は9列目（HEADERS の並び）
    var raw  = cell.getValue();
    var obj  = {};
    if(raw !== '' && raw != null){
      var s = String(raw).trim();
      if(s.charAt(0) !== '{') return {ok:false, error:'保存データの形式が不正です'};   // 書かずに中止
      try{
        var p = JSON.parse(s);
        if(!p || typeof p !== 'object') return {ok:false, error:'保存データの形式が不正です'};
        obj = p;
      }catch(err2){
        return {ok:false, error:'保存データを解釈できません'};   // 壊れたJSONを上書きしない
      }
    }

    var at = new Date().toISOString();
    obj.hospitalized   = hz;
    obj.hospitalizedAt = at;
    var log = Array.isArray(obj.stateLog) ? obj.stateLog : [];
    log.unshift({ts:at, src:src, field:'hospitalized', val:hz});
    obj.stateLog = log.slice(0, STATE_LOG_MAX);

    cell.setValue(JSON.stringify(obj));
    _bumpStateRev();                          // 購読側に「変わった」と知らせる
    return {ok:true, hospitalized:hz, hospitalizedAt:at};
  }catch(err){
    /* 個人情報保護: body の中身はログに出さない（実行ログは後から回収できない） */
    console.error('setState error: ' + err);
    return {ok:false, error:String(err)};
  }finally{
    try{ lock.releaseLock(); }catch(e){}
  }
}

/* 診断用: 追加した2機能が動くかをエディタから点検する（読み取りのみ・氏名は出さない）。
   Apps Script の関数プルダウンで verifyState を選び「実行」。ウェブアプリからは到達しない。 */
function verifyState(){
  Logger.log('■ rev  = ' + _stateRev()  + '（setState のたびに +1）');
  Logger.log('■ srev = ' + _metaSrev() + '（排泄記録GASが meta!A1 に刻む時刻。0なら未刻印）');
  var all = getRoster();
  var hz = 0;
  all.forEach(function(r){ /* 一覧に hospitalized は載らないので dataJson から数える */ });
  var sh = _sheet(), v = sh.getDataRange().getValues(), n = 0;
  for(var i=1;i<v.length;i++){
    if(v[i][0]==='') continue;
    try{ var d = JSON.parse(v[i][8]||'{}'); if(d && d.hospitalized === true) n++; }catch(e){}
  }
  Logger.log('■ 入院中: ' + n + '名 / 全 ' + all.length + '名');
  Logger.log(n>=0 ? '✅ 読み取りは正常です' : '');
}
