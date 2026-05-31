/***** 入居者情報（データ表） → 入居者マスタ 移行スクリプト *****
 * 「入居者情報」スプレッドシートにバインドして実行（master.gs と同じプロジェクトでOK）。
 * 安全運用の手順:
 *   ① DRY_RUN=true のまま runMigration() 実行 → 実行ログ（表示→ログ / Ctrl+Enter）で
 *      「検出シート・列マッピング・先頭3名の変換結果・対象人数」を確認
 *   ② 列マッピングが正しければ DRY_RUN=false にして再実行 → 'master_import' タブへ書込
 *   ③ master_import の中身を目視確認 → 既存 'master' と差し替え
 *      （master を残したい場合は master をリネーム退避してから master_import を master に改名）
 * ※ 元データ（入居者情報のデータ表）は読み取りのみ。書込みは master_import タブだけ。
 *****/
var DRY_RUN = true;                 // ①の確認が済むまで true のまま
var SOURCE_SHEET = '';              // 空=自動検出（"利用者No"と"入居者"を含むヘッダー行のシート）
var TARGET_SHEET = 'master_import'; // 書込先（安全のため複製先。確認後に master へ）
var DEFAULT_TARGET_APPS = ['excretion','weight','schedule']; // 取り込み時の対象アプリ既定（全ON）

function runMigration(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = SOURCE_SHEET ? ss.getSheetByName(SOURCE_SHEET) : _findDataSheet(ss);
  if(!src){ Logger.log('❌ データ表シートが見つかりません。SOURCE_SHEET にタブ名を指定してください'); return; }
  var values = src.getDataRange().getValues();
  var hRow = _findHeaderRow(values);
  if(hRow<0){ Logger.log('❌ ヘッダー行（利用者No/入居者）が見つかりません'); return; }
  var norm = values[hRow].map(function(h){ return String(h).replace(/\s+/g,''); });
  var col = _buildColMap(norm);
  Logger.log('検出シート: '+src.getName()+'  ヘッダー行: '+(hRow+1));
  Logger.log('列マッピング(0始まり列番号 / -1=未検出): '+JSON.stringify(col));

  var recs=[], id=1;
  for(var r=hRow+1; r<values.length; r++){
    var name=_s(values[r][col.name]);
    if(!name) continue;            // 氏名なしの行（区切り等）はスキップ
    recs.push(_toRecord(values[r], col, id++));
  }
  Logger.log('対象: '+recs.length+' 名（退去・逝去も含む）');
  for(var k=0;k<Math.min(3,recs.length);k++){ Logger.log('例'+(k+1)+': '+JSON.stringify(recs[k])); }

  if(DRY_RUN){ Logger.log('✅ DRY_RUN（書込なし）。上のマッピングと例を確認し、問題なければ DRY_RUN=false で再実行。'); return; }

  var tgt = ss.getSheetByName(TARGET_SHEET) || ss.insertSheet(TARGET_SHEET);
  tgt.clearContents();
  tgt.appendRow(['id','name','kana','room','gender','careLevel','active','updatedAt','dataJson','targetApps']);
  var rows = recs.map(function(rec){
    return [rec.id, rec.name, rec.kana||'', rec.room||'', rec.gender||'', rec.careLevel||'',
            rec.active!==false, rec.updatedAt, JSON.stringify(rec),
            (rec.targetApps||DEFAULT_TARGET_APPS).join(',')];
  });
  if(rows.length) tgt.getRange(2,1,rows.length,10).setValues(rows);
  Logger.log('✅ '+rows.length+'名を「'+TARGET_SHEET+'」へ書込み。内容確認後、master として使用してください。');
}

function _toRecord(row, col, id){
  function g(k){ var i=col[k]; return (i==null||i<0)?'':_s(row[i]); }
  var dis=g('dischargeDate'), death=g('deathDate');
  return {
    id:id, name:g('name'), kana:g('kana'), room:g('room'), gender:g('gender'),
    careLevel:g('careLevel'), active: !(dis||death), updatedAt:new Date().toISOString(),
    birthDate:_date(g('birthSeireki')||g('birthWareki')),
    admissionDate:_date(g('admissionDate')), dischargeDate:_date(dis),
    careCertEnd:_date(g('careCertEnd')), copayRate:_digit(g('copayRate')),
    height:_num(g('height')), weight:_num(g('weight')), adl:g('adl'),
    careOffice:g('careOffice'), careManager:g('careManager'), careOfficeTel:g('careOfficeTel'), careOfficeFax:g('careOfficeFax'),
    welfareEquip:g('welfareEquip'), welfareEquipStaff:g('welfareEquipStaff'), welfareEquipTel:g('welfareEquipTel'),
    hospital:g('hospital'), doctor:g('doctor'), hospitalTel:g('hospitalTel'), hospitalFax:g('hospitalFax'),
    pharmacy:g('pharmacy'), pharmacyTel:g('pharmacyTel'), pharmacyFax:g('pharmacyFax'),
    emergencyHospital:g('emergencyHospital'),
    allergy:g('allergy'), sideEffects:g('sideEffects'), currentDiseases:g('currentDiseases'), pastHistory:g('pastHistory'),
    preAdmission:g('preAdmission'), postDischarge:g('postDischarge')||g('postDischargeDest'),
    medsNotes:g('medsNotes'), mealStaple:g('mealStaple'), mealSide:g('mealSide'), mealNote:g('mealNote'),
    targetApps:['excretion','weight','schedule']
  };
}

/* 正規化済み（空白・改行除去）ヘッダー配列 h から、各フィールドの列番号を決定。
   重複する見出し（居宅×4 / 福祉用具×3 / かかりつけ病院×4 / かかりつけ薬局×3）は出現順で割当。 */
function _buildColMap(h){
  function nth(label, occ){ var c=0; for(var i=0;i<h.length;i++){ if(h[i]===label){ if(c===occ) return i; c++; } } return -1; }
  return {
    name:nth('入居者',0), kana:nth('読み',0), gender:nth('性別',0), room:nth('居室',0),
    admissionDate:nth('入居日',0), dischargeDate:nth('退去日',0),
    birthWareki:nth('生年月日和暦',0), birthSeireki:nth('西暦',0),
    careLevel:nth('介護度',0), careCertEnd:nth('認定期間',0), copayRate:nth('負担割合',0),
    height:nth('身長',0), weight:nth('体重',0),
    allergy:nth('アレルギー',0), sideEffects:nth('薬物・副作用・禁忌等',0),
    currentDiseases:nth('治療中の病気',0), pastHistory:nth('既往歴',0),
    preAdmission:nth('入居前',0), postDischarge:nth('退去後',0),
    emergencyHospital:nth('救急搬送先',0), adl:nth('日常生活自立度',0),
    deathDate:nth('ご逝去日',0), postDischargeDest:nth('退去先',0), medsNotes:nth('薬のセットについて',0),
    mealStaple:nth('食事/主食',0), mealSide:nth('食事/副食',0), mealNote:nth('食事/備考',0),
    careOffice:nth('居宅',0), careManager:nth('居宅',1), careOfficeTel:nth('居宅',2), careOfficeFax:nth('居宅',3),
    welfareEquip:nth('福祉用具',0), welfareEquipStaff:nth('福祉用具',1), welfareEquipTel:nth('福祉用具',2),
    hospital:nth('かかりつけ病院',0), doctor:nth('かかりつけ病院',1), hospitalTel:nth('かかりつけ病院',2), hospitalFax:nth('かかりつけ病院',3),
    pharmacy:nth('かかりつけ薬局',0), pharmacyTel:nth('かかりつけ薬局',1), pharmacyFax:nth('かかりつけ薬局',2)
  };
}

function _findDataSheet(ss){
  var sheets=ss.getSheets();
  for(var i=0;i<sheets.length;i++){
    if(_findHeaderRow(sheets[i].getDataRange().getValues())>=0) return sheets[i];
  }
  return null;
}
function _findHeaderRow(values){
  for(var i=0;i<Math.min(values.length,40);i++){
    var row=values[i].map(function(c){ return String(c).replace(/\s+/g,''); });
    if(row.indexOf('利用者No')>=0 && row.indexOf('入居者')>=0) return i;
  }
  return -1;
}
function _s(v){ if(v==null) return ''; if(v instanceof Date) return _date(v); return String(v).trim(); }
function _num(v){ var n=parseFloat(String(v).replace(/[^0-9.]/g,'')); return isNaN(n)?'':n; }
function _digit(v){ var m=String(v).match(/[0-9]/); return m?m[0]:''; }
function _date(v){
  if(!v) return '';
  if(v instanceof Date){ return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
  var m=String(v).trim().match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  return m ? (m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2)) : '';
}
