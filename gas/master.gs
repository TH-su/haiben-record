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
    var role = _role(e);
    if(!role) return _err('認証エラー');
    var a = (e && e.parameter && e.parameter.action) || '';
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
    if(a==='getRoster') return _json({roster:getRoster(e.parameter.since)});
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
var ROSTER_EXTRA = ['birthDate','height'];

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
    // ★この19項目は resident-master.html / facesheet.html の SAFE_FIELDS と完全一致させること（3箇所契約）。
    facesheet_safe:['name','kana','room','gender','preferredName','allergy','infections','medicalCare','formAdjust','careHints','mealForm','thickener','swallow','denture','mobility','problemBehavior','medMgmt','medAssist','medRefusal']
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
