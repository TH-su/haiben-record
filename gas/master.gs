/***** 入居者マスタ GAS Web App *****
 * 「入居者情報」スプレッドシートにバインドして使用（拡張機能→Apps Script）。
 * 入居者マスタは 'master' タブに 1行=1名 で保存。
 * デプロイ: デプロイ→新しいデプロイ→ウェブアプリ→実行=自分 / アクセス=全員→ /exec URL を取得
 * スクリプトプロパティ RMASTER_TOKEN に任意の合言葉を設定（resident-master.html 側と一致させる）
 *****/
var MASTER_SHEET = 'master';
var TOKEN_PROP = 'RMASTER_TOKEN';
var HEADERS = ['id','name','kana','room','gender','careLevel','active','updatedAt','dataJson','targetApps'];

function _sheet(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MASTER_SHEET);
  if(!sh){ sh = ss.insertSheet(MASTER_SHEET); sh.appendRow(HEADERS); }
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
function _truthy(v){ return v!==false && v!=='false' && v!=='退去' && v!==''; }

function doGet(e){
  try{
    if(!_token(e)) return _err('認証エラー');
    var a = (e && e.parameter && e.parameter.action) || '';
    if(a==='ping') return _json({ok:true});
    if(a==='getRoster') return _json({roster:getRoster(e.parameter.since)});
    if(a==='getResident') return _json({record:getResident(e.parameter.id)});
    if(a==='getSection') return _json({section:getSection(e.parameter.id, e.parameter.section)});
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
}
function doPost(e){
  try{
    if(!_token(e)) return _err('認証エラー');
    var b = JSON.parse(e.postData.contents);
    if(b.action==='saveResident') return _json({record:saveResident(b.record)});
    return _err('不明なaction');
  }catch(err){ return _err(String(err)); }
}

function getRoster(since){
  var sh=_sheet(), v=sh.getDataRange().getValues(), out=[], s=since?new Date(since).getTime():0;
  for(var i=1;i<v.length;i++){ var r=v[i]; if(r[0]==='') continue;
    if(s){ var u=r[7]?new Date(r[7]).getTime():0; if(u<s) continue; }
    out.push({ id:r[0], name:r[1], kana:r[2], room:r[3], gender:r[4], careLevel:r[5],
               active:_truthy(r[6]), updatedAt:r[7], targetApps:String(r[9]||'') });
  }
  return out;
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
    basic:['gender','birthDate','phone','careLevel','careCertStart','careCertEnd','certDate','copayRate','welfare','insuredNo','insurer','medicalInsurance','disabilityCert','guardianship','admissionDate','dischargeDate','height','weight','adl','dementia'],
    careHistory:['careLevelHistory'],
    family:['family'],
    office:['careOffice','careManager','careOfficeTel','careOfficeFax','welfareEquip','welfareEquipStaff','welfareEquipTel','rhythm'],
    medical:['hospital','doctor','hospitalTel','hospitalFax','emergencyHospital','pharmacy','pharmacyTel','pharmacyFax','allergy','infections','bloodType','medicalCare','vaccinations','disclosure','currentDiseases','sideEffects','pastHistory','medsRegular','medsNotes','problemBehavior'],
    meds:['medMgmt','medAssist','highRiskMeds','formAdjust','medRefusal'],
    adl_detail:['swallow','water','excretion','bath','dress','mobility','transfer','bedriddenRank','pressureUlcer','vision','hearing'],
    cognitive:['dementiaType','cogScore','careHints','psychHistory'],
    comm:['preferredName','commMethod','commNotes'],
    meal:['mealStaple','mealSide','mealForm','thickener','denture','mealNote'],
    person:['personality','hobby','foodPref','lifePrefs','smoking','drinking'],
    history:['lifeHistory','values'],
    wishes:['complaint','wishSelf','wishFamily','goal','acp','dnar','strengths'],
    support:['supportLog'],
    medSupport:['medicalSupportLog'],
    // 現場タブレット(field)向け「安全情報のみ」。家族連絡先・経済・詳細病歴・服薬詳細は含めない。
    // facesheet.html の field 限定ビュー専用。resident-master.html の SAFE_FIELDS と一致させること。
    facesheet_safe:['kana','room','gender','preferredName','allergy','infections','medicalCare','formAdjust','careHints','mealForm','thickener','swallow','denture','mobility','problemBehavior']
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
