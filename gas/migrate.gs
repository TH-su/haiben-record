/***** 入居者情報（データ表） → 入居者マスタ 移行スクリプト v2 *****
 * 「入居者情報」スプレッドシートにバインドして実行（master.gs と同じプロジェクトでOK）。
 *
 * ── 安全運用の手順 ──
 *   ① DRY_RUN=true のまま runMigration() を実行
 *      → 実行ログ（表示→ログ / Ctrl+Enter）で次の3つを必ず確認する
 *         (a) 「未検出フィールド」が空であること（空でなければ下の LABELS を直す）
 *         (b) 「全見出し一覧」と実際のシートが一致していること
 *         (c) 先頭3名の変換結果に化けや欠落が無いこと
 *   ② 問題なければ DRY_RUN=false にして再実行 → 'master_import' タブへ書込
 *   ③ master_import を目視確認 → 既存 'master' をリネーム退避してから master_import を master に改名
 *
 * ── 設計上の約束 ──
 *   - 元データ（3タブ）は読み取りのみ。書込みは master_import タブだけ。
 *   - 値が読めない・変換できない場合は「空にする」のではなく原文のまま入れてログに出す（データを消さない）。
 *   - id は必ずスプレッドシートの「利用者No」を使う。連番で振り直さない。
 *     （id は他アプリが masterId として参照する連携キー。ずれると全アプリの紐付けが壊れる）
 *
 * ── v2 での修正点（v1 の欠陥）──
 *   1. 見出しが2行構成（グループ見出し＋サブ見出し、グループは横方向に結合）なのに1行しか見ていなかった。
 *      → グループ見出しを前方補完し「グループ/サブ」で連結してから照合する。
 *   2. id を 1 からの連番で振り直していた → 利用者No を採用。
 *   3. 認定期間は4列結合の1列目（＝開始日）を careCertEnd に入れていた → 開始/終了/認定日を分離。
 *   4. 介護度の数値表記・負担割合の生活保護表記を正規化していなかった。
 *   5. 家族情報タブ・薬情報タブを一切取り込んでいなかった → family[] / 薬関連を実装。
 *****/

var DRY_RUN = true;                    // ①の確認が済むまで true のまま
/* ★致命（❌）が1件でも残っていたら書き込まない。
   ❌は「入居者が丸ごと載らない」「別人の電話番号が紐づく」等の実害を指すもので、
   件数だけ表示して書込を通すと、手順③の目視（＝載ったレコードしか見えない）では
   取りこぼしに気づけない。承知のうえで進める時だけ true にする。 */
var ALLOW_FATAL = false;
/* 元シートに存在しないことを確認済みで、空でも構わない主タブの項目。
   ここに入れた項目だけ「未検出」の❌を出さない（＝黙って空になるのを許可する）。 */
/* 2026-07-19 管理者確認: 自立度の列は BG（列58）の1列のみ。
   ログ上の列59は結合セルのグループ見出しが前方補完されただけの空列で、
   認知症高齢者の日常生活自立度に相当する列は元シートに存在しない。
   → dementia は移行対象外（マスタ側で新規入力する項目とする）。 */
var ACK_MISSING = ['dementia'];
/* 2026-07-19 管理者確認: 薬タブの No138〜141 は番号を採番しただけで未入居。
   主タブに無いのは正常なので❌にしない（注意として残す）。 */
var ACK_NO_MAIN = [138,139,140,141];
/* 2026-07-19 管理者確認: 主タブ141行目は未入居のため氏名が空。正常なので❌にしない。 */
/* ★行番号ではなく利用者Noで指定する（行が増減しても別人を誤って許可しないため）。
   主タブ141行目＝データ4行目起点の138行目で、そこに入っているのは未入居の No138。
   未入居者の番号は ACK_NO_MAIN と同じ集合なのでそれを流用する。 */
var ACK_EMPTY_NO = ACK_NO_MAIN.slice();   // 参照共有すると片方の意図で編集したつもりが両方に効く
/* 認定期間欄に日付が1つしか無い場合の扱い。'start'（開始日）/'end'（満了日）/'cert'（認定日）/''（未設定＝❌で停止）。
   2026-07-19 管理者確認: 「入居後に認定日が訪れた場合に記載しているが、記載漏れがあるため
   現状の状態」。＝元データ側の記載が不揃いで、単一日付に統一的な意味は無い。
   ★2026-07-19 実測で確定（推測ではない）。46件の「日」の分布:
       1日=0件 / 28日以降=46件 / その他=0件  ＝ 月末に100%集中。
     ・期間開始日なら月初(1日)に偏るはず → 0件なので違う
     ・認定日なら保険者の決裁日で任意日に散るはず → 46/46が月末で散っていないので違う
     ・認定有効期間は月末で終わるのが標準 → これは「有効期間の満了日」
     偶然この分布になる確率は無いため 'end' で確定する。
   ★元データに記載漏れがあることは管理者も認識済み。新マスタ側での整備が前提。 */
var CERT_SINGLE_DATE_AS = 'end';
/* 家族情報タブ側の同様の許可リスト。
   2026-07-19: 元シート27列を全て確認したところ「続柄」の列は存在しなかった。
   続柄は家族欄の本文に含まれている可能性が高い（例「長女 ○○」）。
   ❌を出し続けても解消できないため、確認済みとして許可する。 */
var ACK_MISSING_FAMILY = ['relation'];
/* 介護度欄が数字だけ（例「3」）のときに何とみなすか。
   2026-07-19 管理者確認: 「要介護しかいない。他アプリに存在する要支援者はここに含めない」。
   → 裸の数字は要介護として確定（警告不要）。'' にすると従来どおり警告付きで要介護に倒す。 */
var BARE_NUMBER_CARE_LEVEL = '要介護';
/* 家族の電話の紐付きを目視確認済みの利用者No（❌を出さない）。 */
var ACK_FAMILY_PHONE = [];
/* 薬タブ2列目の退避ラベル。verifyImport が件数を数えるのに使うので文面を変えたら両方直す。 */
var MEDS_EXTRA_TAG = '内服(定期薬)欄の2列目';
var TARGET_SHEET = 'master_import';    // 書込先（安全のため複製先。確認後に master へ）
/* runMigration の書込先として master を指定することは禁止（ガードで停止する）。
   master へ直接書くのは addReservedIds だけで、これは予約行の追記専用＝
   既存行は変更せず・登録済みidはスキップする。ただし DRY_RUN の対象外で即時書き込む。 */
var MASTER_SHEET_NAME = 'master';
var DEFAULT_TARGET_APPS = ['excretion','weight','schedule'];

/* タブ名。空なら自動検出するが、同系統のタブが複数あるため
   DRY_RUN のログでシート名を確認して明示指定することを強く推奨する。 */
/* 2026-07-19 listSheets() の実行結果（全51タブ）で確定。gidはURLの #gid=… と一致を確認済み。
   ★自動検出に戻さないこと。「薬」を含むタブが他に2枚（病歴・薬 / 年末年始薬）あり、
     自動検出は先に条件に合ったタブを掴むため、別タブを読む事故が起きる。 */
var SHEET_MAIN   = '全入居者・ＣＭ表';   // gid=199289339  141行×71列（退去・逝去を含む全入居者）
var SHEET_FAMILY = '家族情報';            // gid=109625994  140行×27列
var SHEET_MEDS   = '薬';                  // gid=1912671980 144行×11列

/* 見出しの候補（別名）。DRY_RUN の「未検出フィールド」に出た項目は、
   ログの「全見出し一覧」から実際の文字列を拾ってここに足す。 */
var LABELS = {
  no:            ['利用者No'],
  name:          ['入居者','氏名'],
  kana:          ['読み','ふりがな','フリガナ'],
  gender:        ['性別'],
  room:          ['居室','部屋番号'],
  admissionDate: ['入居日'],
  dischargeDate: ['退去日'],
  deathDate:     ['ご逝去日','逝去日'],
  dischargeTo:   ['退去先'],
  postDischarge: ['退去後'],
  birthWareki:   ['生年月日和暦','生年月日'],
  birthSeireki:  ['西暦','生年月日/西暦'],
  careLevel:     ['介護度','要介護度'],
  careCert:      ['認定期間'],          // 4列結合。出現順に 開始/終了/認定日 を割当
  copayRate:     ['負担割合'],
  height:        ['身長'],
  weight:        ['体重'],
  adl:           ['日常生活自立度','生活自立度'],
  /* 「認知症高齢者の日常生活自立度」は表記ゆれが大きい。2行見出しの場合は
     「日常生活自立度/認知症高齢者」のような連結形になるため両方を候補に入れる。 */
  dementia:      ['認知症自立度','認知症高齢者の日常生活自立度','認知症高齢者日常生活自立度',
                  '日常生活自立度/認知症高齢者','日常生活自立度/認知症','生活自立度/認知症高齢者',
                  '生活自立度/認知症','自立度/認知症','認知度'],
  visitDay:      ['診察日','往診日'],
  serviceManager:['サービス提供責任者','サ責'],
  careOffice:    ['居宅'],              // 4列（事業所/担当/TEL/FAX）
  welfareEquip:  ['福祉用具'],          // 3列（事業所/担当/TEL）
  hospital:      ['かかりつけ病院'],    // 4列（機関/医師/TEL/FAX）
  pharmacy:      ['かかりつけ薬局'],    // 3列（薬局/TEL/FAX）
  emergencyHospital:['救急搬送先'],
  allergy:       ['アレルギー'],
  sideEffects:   ['薬物・副作用・禁忌等','副作用','禁忌'],
  currentDiseases:['治療中の病気','現病'],
  pastHistory:   ['既往歴'],
  preAdmission:  ['入居前'],
  medsNotes:     ['薬のセットについて','薬備考'],
  mealStaple:    ['食事/主食','主食'],
  mealSide:      ['食事/副食','副食'],
  mealNote:      ['食事/備考','食事備考'],
  supportLog:    ['支援経過'],
  note:          ['備考'],
  dayUseMon:     ['デイ利用日/月'], dayUseTue:['デイ利用日/火'], dayUseWed:['デイ利用日/水'],
  dayUseThu:     ['デイ利用日/木'], dayUseFri:['デイ利用日/金'], dayUseSat:['デイ利用日/土']
};

/* 家族情報タブ・薬情報タブの見出し候補 */
var LABELS_FAMILY = {
  no:['利用者No'], name:['入居者','氏名'],
  family:['家族'], relation:['続柄'], phone:['電話'], address:['住所'],
  emergency:['緊急連絡先'], emergencyPhone:['電話(緊急用)','緊急連絡先電話']
};
/* 家族情報タブ 列16〜23 → フェイスシートの consents 8項目（1対1で完全一致）。
   ★見出しは元シートの原文のまま（「健子管理」等の表記も勝手に直さない）。 */
var CONSENT_MAP = [
  ['photo',      '同意・確認書/写真使用'],
  ['supplies',   '同意・確認書/消耗品提供'],
  ['moneyMgmt',  '同意・確認書/金銭管理同意'],
  ['mailOpen',   '同意・確認書/郵便物渡し開封'],
  ['visitPolicy','同意・確認書/面会同意'],
  ['doctorMed',  '同意・確認書/主治医薬管理'],
  ['healthFood', '同意・確認書/健子管理・差し入れ同意'],
  ['nightCheck', '同意・確認書/夜間安否']
];
/* マスタに対応項目が無いが捨てたくない家族情報タブの列。原文を unmappedRaw へ退避する。 */
var FAMILY_EXTRA = ['住所/電話以外の連絡手段','介護保険症(期限)','負担割合証(期限)',
                    '医療保険症(期限)','その他預かり(期限)','寝具リース'];

var LABELS_MEDS = {
  no:['利用者No'], name:['入居者','氏名'],
  medsRegular:['内服（定期薬）','内服(定期薬)','内服'],
  effect:['効能','内服(定期薬)/効能','内服（定期薬）/効能','内服/効能'],
  medsPrn:['頓服・外用等','頓服','外用'],
  medsPast:['過去の臨時薬','臨時薬'],
  emergencyHospital:['急変・ご逝去時対応/医療機関','急変・ご逝去時対応'],
  emergencyTel:['急変・ご逝去時対応/連絡先','連絡先']
};

/* 移行しない列（表計算の途中計算・作業用の列）。見出しがこれらに一致する列は無視する。 */
var EXCLUDE_LABELS = ['作業用セル','退去作業セル','退去順作業セル','現・作業セル','滞在期間(日)','年齢','BMI'];

var _warn = [];
var _certDays = [];   // 認定期間が単一日付だった件の「日」だけ集める（集計のみ・個人情報ではない）
function _w(msg){ _warn.push(msg); }

var SCRIPT_VERSION = '2026-07-20a（予約番号の確保を追加）';   // ログ先頭に出す。貼り付け漏れの判別用

function runMigration(){
  _warn = []; _certDays = [];
  /* ★版数だけだと「版数行だけ新しく本体が旧い」部分貼り付けを見逃す。
     新版でしか存在しない関数の有無を実体で確認して併記する。 */
  Logger.log('■ migrate.gs 版: '+SCRIPT_VERSION+
    ' / 診断関数 _headDump='+(typeof _headDump==='function'?'有':'無')+
    ' _looksLikeData='+(typeof _looksLikeData==='function'?'有':'無')+
    ' _report='+(typeof _report==='function'?'有':'無'));
  Logger.log('■ タブ指定: main「'+SHEET_MAIN+'」 family「'+SHEET_FAMILY+'」 meds「'+SHEET_MEDS+'」'+
    (SHEET_MAIN&&SHEET_FAMILY&&SHEET_MEDS?'':'  ⚠️ 空欄あり＝自動検出に戻っています'));
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── 主タブ ──
  var src = SHEET_MAIN ? ss.getSheetByName(SHEET_MAIN) : _findSheetBy(ss, ['利用者No','入居者'], 40);
  if(!src){ Logger.log('❌ 入居者情報タブが見つかりません。SHEET_MAIN にタブ名を指定してください'); return; }
  var H = _headers(src);
  if(!H){ Logger.log('❌ ヘッダー行が特定できません'); return; }
  Logger.log('■ 検出シート: '+_tabLabel(src.getName())+'  グループ見出し行: '+(H.gRow+1)+'  サブ見出し行: '+(H.sRow<0?'なし':(H.sRow+1))+'  データ開始行: '+(H.dRow+1));
  _logJoin('■ 全見出し一覧 全'+H.combined.length+'列:', _headDump(H.combined), 12);

  var col = _mapCols(H.combined, LABELS);
  var missing = Object.keys(col).filter(function(k){ return col[k]<0; });
  Logger.log('■ 列マッピング: '+JSON.stringify(col));
  /* ★未検出＝その項目が全137名分そろって空になる、という実害。
     ⚠️ で表示するだけだと ALLOW_FATAL ガードを素通りし「✅正常完了」で欠落マスタができる。
     家族タブ側は同じ失敗モードを❌にしているので、主タブも揃える。
     欠けていて構わない列が判明したら ACK_MISSING に追記して黙らせる。 */
  if(missing.length){
    Logger.log('⚠️ 未検出フィールド（LABELS に実際の見出しを追記してください）: '+missing.join(', '));
    missing.forEach(function(k){
      if(ACK_MISSING.indexOf(k)>=0) return;
      _w('❌ 主タブ: 「'+k+'」の列が未検出→この項目は全員分が空になります。LABELS に実際の見出しを追記してください');
    });
  }
  else Logger.log('✅ 未検出フィールドなし');
  /* ★_mapCols はキー間の重複割当を検査しない。グループ名フォールバックが働くと
     例えば adl と dementia が同じ列（自立度グループの先頭）を掴み、
     片方に別データが入り、もう片方が無警告で欠落する。ここで必ず可視化する。 */
  var dup={};
  Object.keys(col).forEach(function(k){ if(col[k]>=0){ (dup[col[k]]=dup[col[k]]||[]).push(k); } });
  var dupHit=Object.keys(dup).filter(function(i){ return dup[i].length>1; });
  if(dupHit.length){
    dupHit.forEach(function(i){
      Logger.log('⚠️ 列'+i+'（'+_headLabel(H.combined[i])+'）に複数フィールドが割当: '+dup[i].join(',')+' → 片方は誤マッピングの可能性');
    });
  } else Logger.log('✅ 列の重複割当なし');
  _logGroups(H.combined, col);
  _logUnused(H.combined, col, '主タブ');

  // ── レコード生成 ──
  var values = src.getDataRange().getValues();
  var recs = [], seen = {}, dataRows = 0;
  for(var r=H.dRow; r<values.length; r++){
    var row = values[r];
    var nm = _s(row[col.name]);
    var noRaw = _s(row[col.no]);
    if(!nm && !noRaw) continue;                 // 空行
    dataRows++;                                 // 末尾空行を除いた実データ行数（取込漏れの突合に使う）
    /* ★「入居者が1名まるごと移行されない」経路は全て❌にする。
       手順③の master_import 目視は“載ったレコード”しか見えないため、
       載らなかった行はここで拾わないと二度と気づけない。 */
    if(!nm){
      if(ACK_EMPTY_NO.indexOf(_int(noRaw))>=0) _w('利用者No'+_int(noRaw)+'（行'+(r+1)+'）: 未入居のため氏名が空（確認済み）→スキップ');
      else _w('❌ 行'+(r+1)+': 氏名が空のためスキップ（利用者No列の原文長'+noRaw.length+'字）→ 空テンプレート行か要確認');
      continue;
    }
    var no = _int(noRaw);
    if(no===''){ _w('❌ 行'+(r+1)+': 利用者Noが数値でない（原文長'+noRaw.length+'字）→ この行はスキップ。要目視'); continue; }
    if(seen[no]){ _w('❌ 利用者No重複: '+no+'（行'+(r+1)+'）→ 後の行をスキップ'); continue; }
    seen[no]=true;
    recs.push(_toRecord(row, col, no, H.combined));
  }
  Logger.log('■ 主タブ取込: '+recs.length+' 名（退去・逝去を含む）');

  var byNo = {}; recs.forEach(function(x){ byNo[x.id]=x; });

  // ── 家族情報タブ ──
  var fsh = SHEET_FAMILY ? ss.getSheetByName(SHEET_FAMILY) : _findSheetBy(ss, ['利用者No','家族'], 40);
  /* ★タブ名を明示指定したため、失敗モードが「別タブを読む」から「タブが無い」に変わった。
     注意止まりだと家族データゼロのまま書込が正常完了してしまうので❌にして書込も止める。 */
  var famOK=false;
  if(fsh){ _mergeFamily(fsh, byNo); famOK=true; }
  else { _w('❌ 家族情報タブ「'+SHEET_FAMILY+'」が見つかりません（タブ名の変更・末尾スペースを確認）'); }

  // ── 薬情報タブ ──
  var msh = SHEET_MEDS ? ss.getSheetByName(SHEET_MEDS) : _findSheetBy(ss, ['利用者No','内服'], 40);
  var medOK=false;
  if(msh){ _mergeMeds(msh, byNo); medOK=true; }
  else { _w('❌ 薬情報タブ「'+SHEET_MEDS+'」が見つかりません（タブ名の変更・末尾スペースを確認）'); }

  // ── 確認出力 ──
  /* ★実行ログに要配慮個人情報（病歴・家族連絡先・薬剤）を出さない。
     Apps Scriptの実行ログはCloud Loggingに残り、スクリプト編集権を持つ全員が閲覧できる。
     中身の確認は master_import を目視する手順③で行う。ここでは充足度だけ見る。 */
  for(var k=0;k<Math.min(3,recs.length);k++){
    var s=recs[k];
    var filled=Object.keys(s).filter(function(kk){
      var v=s[kk]; return v!=='' && v!=null && !(Array.isArray(v)&&!v.length) && !(typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).length);
    }).length;
    Logger.log('例'+(k+1)+': id='+s.id+' 氏名='+String(s.name||'').charAt(0)+'○ 在籍='+s.active+
      ' 介護度='+(s.careLevel?'有':'無')+' 家族='+(s.family||[]).length+'件 経過='+(s.supportLog||[]).length+'件'+
      ' 入力済項目='+filled+'/'+Object.keys(s).length);
  }
  /* ★警告は「種類ごとに集計」して出す。
     同じ構造ミスは全員分（141件超）同じ文面で出るため、全件並べるとログの上限で
     途中が切れ、種類の少ない重要な警告が見えなくなる。件数の多い順に種類を出す。 */
  /* ★認定期間が単一日付だった件の「日」の分布。
     更新認定の有効期間開始日は前期間満了（月末）の翌日＝1日に偏る。
     認定日は保険者の決裁日なので任意日に散る。これで推測せずに判定できる。 */
  if(_certDays.length){
    var d1=0, dLate=0, dOther=0;
    _certDays.forEach(function(d){ if(d===1) d1++; else if(d>=28) dLate++; else dOther++; });
    Logger.log('■ 認定期間の単一日付'+_certDays.length+'件の「日」分布: 1日='+d1+'件 / 28日以降='+dLate+'件 / その他='+dOther+'件'+
      '  → 1日に強く偏るなら期間開始日(CERT_SINGLE_DATE_AS=start)、散っているなら認定日(cert)。現在の設定='+CERT_SINGLE_DATE_AS);
  }
  var fatal=_warn.filter(function(m){return m.indexOf('❌')>=0});
  var notice=_warn.filter(function(m){return m.indexOf('❌')<0});
  Logger.log('■ 致命的な警告: '+fatal.length+'件 / 注意: '+notice.length+'件');
  /* 例文は出さない。可変部は既に「原文長N字」等に伏せてあり digest だけで形が分かるため、
     例を出すと行数が倍増して実行ログからのコピーが困難になる（26種類×3行＝78行）。 */
  _report('致命（❌）の内訳', fatal, 0, Infinity);   // 落ちた入居者を1名も見逃さないため全件
  _report('注意の内訳', notice, 0, Infinity);   // 整備対象の利用者Noを追えるよう全件

  if(DRY_RUN){ Logger.log('✅ DRY_RUN（書込なし）。未検出フィールドと致命的な警告を潰してから DRY_RUN=false で再実行。'); return; }

  // ── 書込ガード（データを消さない） ──
  if(TARGET_SHEET===MASTER_SHEET_NAME){ Logger.log('❌ TARGET_SHEET に master は指定できません。手順③でリネームしてください'); return; }
  // 家族・薬が丸ごと欠けたマスタを「正常完了」で作らない
  if(!famOK||!medOK){ Logger.log('❌ '+(!famOK?'家族情報':'')+(!famOK&&!medOK?'と':'')+(!medOK?'薬情報':'')+'タブを読めていないため書込を中止しました（既存の'+TARGET_SHEET+'は変更していません）'); return; }
  if(fatal.length && !ALLOW_FATAL){
    Logger.log('❌ 致命的な警告が'+fatal.length+'件あるため書込を中止しました（既存の'+TARGET_SHEET+'は変更していません）。'+
      '上の「致命（❌）の内訳」を解消するか、内容を承知のうえで進める場合のみ ALLOW_FATAL=true にしてください');
    return;
  }
  var rows = recs.map(function(rec){
    return [rec.id, rec.name, rec.kana||'', rec.room||'', rec.gender||'', rec.careLevel||'',
            rec.active!==false, rec.updatedAt, JSON.stringify(rec),
            (rec.targetApps||DEFAULT_TARGET_APPS).join(',')];
  });
  if(!rows.length){ Logger.log('❌ 取込0件のため書込を中止しました（既存の'+TARGET_SHEET+'は変更していません）'); return; }
  /* ★固定値100との比較では実データ137名で発火せず、1名の取りこぼしを拾えなかった。
     主タブの実データ行数と突き合わせ、差が出たら件数を明示する。 */
  var srcRows = dataRows;   // ★getDataRange は末尾空行も拾う。空行を数えると差分警告が常時点灯し本物と区別できない
  if(rows.length < srcRows)
    Logger.log('⚠️ 主タブのデータ行'+srcRows+'行に対し取込'+rows.length+'名（差'+(srcRows-rows.length)+'行）。'+
               '空行以外が落ちていないか「致命（❌）の内訳」で確認してください');
  /* ★支援経過を11列連結するようにした結果、dataJson が肥大化しうる。
     Sheets のセル上限は5万字で、超えると setValues が例外を投げる。
     その時点では既に clearContents 済みでヘッダだけの空シートが残るため、
     他のガードと同じく「書込前に return」で揃える。 */
  var CELL_LIMIT=45000, tooBig=[];
  rows.forEach(function(r){ var L=String(r[8]).length; if(L>CELL_LIMIT) tooBig.push('No'+r[0]+'('+L+'字)'); });
  if(tooBig.length){
    Logger.log('❌ dataJson がセル上限(5万字)に近い利用者がいるため書込を中止しました（既存の'+TARGET_SHEET+'は変更していません）: '+tooBig.join(','));
    return;
  }
  var tgt = ss.getSheetByName(TARGET_SHEET);
  if(tgt){   // 既存の取込結果は消す前に複製して残す
    tgt.copyTo(ss).setName(TARGET_SHEET+'_bak_'+Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd_HHmmss'));
  }else{
    tgt = ss.insertSheet(TARGET_SHEET);
  }
  tgt.clearContents();
  tgt.appendRow(['id','name','kana','room','gender','careLevel','active','updatedAt','dataJson','targetApps']);
  tgt.getRange(2,1,rows.length,10).setValues(rows);
  Logger.log('✅ '+rows.length+'名を「'+TARGET_SHEET+'」へ書込み。内容確認後、master として使用してください。');
}

/* ═══════════ 予約番号の確保（master に予約行を追加する） ═══════════ */

/* 元シートで採番済みだが未入居の利用者No（ACK_NO_MAIN）を、master に「予約行」として入れる。
   ★master.gs の saveResident は id 未指定時に max+1 を振る。移行後の max は137なので、
     次の新規登録が id=138 になり、元シートで別人に予約されている No138 と衝突する。
     masterId は全アプリの連携キーなので、衝突すると後から直すのが非常に困難。
   ★予約行は active=false なので getRosterSafe（現場端末）には出ない。
   ★既に存在する id は追加しない（何度実行しても安全）。 */
function addReservedIds(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var sh=ss.getSheetByName(MASTER_SHEET_NAME);
  if(!sh){ Logger.log('❌ 「'+MASTER_SHEET_NAME+'」がありません。先に promoteImport を実行してください'); return; }
  var v=sh.getDataRange().getValues();
  if(v.length<2){ Logger.log('❌ 「'+MASTER_SHEET_NAME+'」にデータ行がありません。昇格が済んでいるか確認してください'); return; }

  var have={}, max=0;
  for(var i=1;i<v.length;i++){
    var id=v[i][0]; if(id==='') continue;
    have[String(id)]=true;
    var n=parseInt(id,10); if(!isNaN(n)&&n>max) max=n;
  }
  Logger.log('■ 現在の「'+MASTER_SHEET_NAME+'」: '+(v.length-1)+'名 / 最大id='+max);
  Logger.log('■ 予約したい利用者No: '+ACK_NO_MAIN.join(','));

  var add=[], skip=[];
  ACK_NO_MAIN.forEach(function(no){
    if(have[String(no)]){ skip.push('No'+no); return; }
    // dataJson は最小限。氏名は空のまま（実際に入居した時に上書きされる）
    add.push([no,'','','','','',false,new Date().toISOString(),
              JSON.stringify({id:no, reserved:true, note:'元シートで採番済み・未入居のため番号のみ確保'}),'']);
  });
  if(skip.length) Logger.log('■ 既にあるため追加しない: '+skip.join(','));
  if(!add.length){ Logger.log('✅ 追加する予約行はありません（すべて登録済み）'); return; }

  sh.getRange(sh.getLastRow()+1, 1, add.length, 10).setValues(add);
  var after=sh.getDataRange().getValues();
  var newMax=0;
  for(var j=1;j<after.length;j++){ var m2=parseInt(after[j][0],10); if(!isNaN(m2)&&m2>newMax) newMax=m2; }
  Logger.log('✅ 予約行を'+add.length+'件追加しました（'+add.map(function(a){return 'No'+a[0]}).join(',')+'）');
  Logger.log('   最大id: '+max+' → '+newMax+' ／ 次の新規登録は id='+(newMax+1)+' になります');
  Logger.log('   予約行は active=FALSE のため現場端末の名簿には出ません');
  Logger.log('   → その方が実際に入居したら、事務所側で該当のidを開いて氏名等を入力してください');
}

/* ═══════════ 名簿が出ない時の切り分け（読み取りのみ） ═══════════ */

/* アプリに名簿が出ない原因を特定する。master 系タブの状態と、
   実際に getRoster() が何件返すかを突き合わせる。
   ★master タブが存在しない場合は getRoster() を呼ばない。
     master.gs の _sheet() は master が無いと空タブを自動生成してしまうため、
     診断のつもりで状態を変えてしまう。 */
function whereIsMaster(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var sheets=ss.getSheets(), hit=[], hasMaster=false;
  sheets.forEach(function(sh){
    var n=sh.getName();
    if(/master|import/i.test(n)){
      hit.push(n+' → '+sh.getLastRow()+'行×'+sh.getLastColumn()+'列');
      if(n===MASTER_SHEET_NAME) hasMaster=true;
    }
  });
  Logger.log('■ master/import を含むタブ（全'+sheets.length+'枚中）:');
  hit.length ? _logJoin('   ', hit, 1) : Logger.log('   該当なし');

  if(!hasMaster){
    Logger.log('❌ 「'+MASTER_SHEET_NAME+'」タブがありません。→ アプリは名簿を取得できません');
    Logger.log('   promoteImport を実行して master_import を昇格させてください');
    return;
  }
  var m=ss.getSheetByName(MASTER_SHEET_NAME);
  var rows=Math.max(0, m.getLastRow()-1);
  if(rows===0){
    Logger.log('❌ 「'+MASTER_SHEET_NAME+'」は見出しだけでデータ行が0です。→ 名簿が空になるのはこれが原因');
    Logger.log('   promoteImport を実行してください（master_import が残っていれば昇格できます）');
    return;
  }
  Logger.log('✅ 「'+MASTER_SHEET_NAME+'」に '+rows+' 行のデータがあります');

  if(typeof getRoster!=='function'){
    Logger.log('❌ getRoster() が見つかりません。→ master.gs が同じプロジェクトに貼られていない可能性');
    Logger.log('   Apps Script の左のファイル一覧に「master」があるか確認してください');
    return;
  }
  try{
    var r=getRoster();
    Logger.log('■ getRoster() の返却件数: '+r.length+'件');
    if(r.length===rows) Logger.log('✅ シートの行数と一致。サーバ側は正常です');
    else Logger.log('⚠️ シート'+rows+'行に対し'+r.length+'件。id列が空の行が混じっている可能性');
    if(r.length){
      var act=r.filter(function(x){return x.active!==false}).length;
      Logger.log('   在籍 '+act+'名 / 退去・逝去 '+(r.length-act)+'名');
    }
    Logger.log('→ ここまで正常なら原因はアプリ側（デプロイが古い／URLが別プロジェクトを指している）です');
  }catch(e){ Logger.log('❌ getRoster() でエラー: '+e); }
}

/* ═══════════ master への昇格（改名のみ・データは書き換えない） ═══════════ */

/* master_import を master へ昇格させる。
   ★手作業だと (a) 52枚のタブから探す (b) 改名の途中でアプリのアクセスが入ると
     master.gs が空の master を自動生成して改名が失敗する、の2つの事故が起きる。
     1回の実行にまとめることで、その隙間をほぼゼロにする。
   ★安全のため、既存 master に master_import へ含まれていない入居者がいたら中止する。 */
function promoteImport(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var imp=ss.getSheetByName(TARGET_SHEET);
  if(!imp){ Logger.log('❌ 「'+TARGET_SHEET+'」がありません。先に runMigration（DRY_RUN=false）を実行してください'); return; }
  var iv=imp.getDataRange().getValues();
  if(iv.length<2){ Logger.log('❌ 「'+TARGET_SHEET+'」にデータ行がありません（'+iv.length+'行）。昇格を中止しました'); return; }
  var impIds={}; for(var i=1;i<iv.length;i++){ if(iv[i][0]!=='') impIds[String(iv[i][0])]=true; }
  Logger.log('■ 昇格前チェック: '+TARGET_SHEET+' は '+(iv.length-1)+'名');

  var cur=ss.getSheetByName(MASTER_SHEET_NAME);
  if(cur){
    var cv=cur.getDataRange().getValues();
    var curRows=Math.max(0, cv.length-1);
    Logger.log('■ 既存の「'+MASTER_SHEET_NAME+'」: '+curRows+'名');
    if(curRows>0){
      /* ★既存 master にしか居ない入居者がいると、昇格でその人が消える。
         退避タブに残るとはいえ、アプリからは見えなくなるので必ず止める。 */
      var lost=[];
      for(var r=1;r<cv.length;r++){
        var id=cv[r][0]; if(id==='') continue;
        if(!impIds[String(id)]) lost.push('No'+id);
      }
      if(lost.length){
        Logger.log('❌ 既存の「'+MASTER_SHEET_NAME+'」にいるのに「'+TARGET_SHEET+'」に無い入居者 '+lost.length+'名: '+lost.slice(0,60).join(','));
        Logger.log('   このまま昇格するとアプリからこの方々が見えなくなります。昇格を中止しました。');
        Logger.log('   → 既存 master の内容を確認し、必要なら移行対象に含めてから再実行してください。');
        return;
      }
      Logger.log('✅ 既存 master の入居者は全員 '+TARGET_SHEET+' に含まれています');
    }
  }else Logger.log('■ 既存の「'+MASTER_SHEET_NAME+'」はありません（新規作成になります）');

  // 保険のコピーを先に作る（失敗しても元に戻せるように）
  var stamp=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd_HHmmss');
  var bak=imp.copyTo(ss).setName(TARGET_SHEET+'_promote_bak_'+stamp);
  Logger.log('■ 保険のコピーを作成: '+bak.getName());

  // 改名（ここが最短になるよう、前後に他の処理を挟まない）
  var oldName='';
  try{
    if(cur){ oldName=MASTER_SHEET_NAME+'_old_'+stamp; cur.setName(oldName); }
    imp.setName(MASTER_SHEET_NAME);
  }catch(e){
    Logger.log('❌ 改名に失敗しました: '+e);
    Logger.log('   同名タブが既にある可能性があります（アプリのアクセスで空の master が自動生成された等）。');
    Logger.log('   → 空の「'+MASTER_SHEET_NAME+'」を削除してから promoteImport を再実行してください。');
    return;
  }

  // 結果確認
  var now=ss.getSheetByName(MASTER_SHEET_NAME);
  var n=now?Math.max(0,now.getLastRow()-1):0;
  if(n===iv.length-1){
    Logger.log('✅ 昇格完了。「'+MASTER_SHEET_NAME+'」= '+n+'名');
    if(oldName) Logger.log('   旧マスタは「'+oldName+'」に退避しました（消さないでください）');
    Logger.log('   保険のコピー: '+bak.getName());
    Logger.log('   → 次は resident-master.html を開いて名簿が'+n+'名出ることを確認してください');
  }else{
    Logger.log('❌ 昇格後の件数が合いません（期待'+(iv.length-1)+'名 / 実際'+n+'名）。'+bak.getName()+' から復旧できます');
  }
}

/* ═══════════ 移行結果の検証（読み取り専用・書込は一切しない） ═══════════ */

/* master_import を機械的に検証する。
   ★目視は「載ったレコード」しか見えないため、落ちた入居者・壊れた紐付けを発見できない。
     元シートと突合して件数・キー・構造を機械的に照合する。
   ★出力は件数・利用者No・構造のみ。氏名/電話/住所/薬剤名は一切出さない。 */
function verifyImport(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var tgt=ss.getSheetByName(TARGET_SHEET);
  if(!tgt){ Logger.log('❌ 「'+TARGET_SHEET+'」タブがありません。先に runMigration を DRY_RUN=false で実行してください'); return; }
  var v=tgt.getDataRange().getValues();
  /* ok=自動判定で合格 / todo=人が目視すべき実測値 / ng=昇格前に直すべき問題
     ★実測値の表示を「合格」に混ぜると、最後の「昇格して問題ありません」が嘘になる。 */
  var ok=[], todo=[], ng=[];
  function OK(m){ ok.push(m); } function TODO(m){ todo.push(m); } function NG(m){ ng.push(m); }
  Logger.log('■ master_import 検証（読み取りのみ）  版: '+SCRIPT_VERSION);

  // ── 1. ヘッダと行数 ──
  var H=['id','name','kana','room','gender','careLevel','active','updatedAt','dataJson','targetApps'];
  var hdrBad=[];
  for(var c=0;c<H.length;c++){ if(String(v[0][c])!==H[c]) hdrBad.push('列'+c+'(期待「'+H[c]+'」/実際'+String(v[0][c]).length+'字)'); }
  // ★不一致時の v[0] は「1行目がデータ行」の可能性が高く、氏名・居室がそのまま出る。中身は出さない。
  hdrBad.length ? NG('ヘッダ不一致: '+hdrBad.join(' ')) : OK('ヘッダ10列が正しい');
  var rows=v.length-1;
  OK('データ行数: '+rows+'名');

  // ── 2. 元シート（主タブ）の利用者No・氏名と突合 ──
  var srcNos={}, srcName={}, srcCount=0, joined=false;
  var src=SHEET_MAIN?ss.getSheetByName(SHEET_MAIN):null;
  if(!src) NG('主タブ「'+SHEET_MAIN+'」を開けないため元シートとの突合を実施できませんでした');
  else{
    var sh=_headers(src);
    if(!sh) NG('主タブのヘッダー行を特定できず、元シートとの突合を実施できませんでした');
    else{
      var sc=_mapCols(sh.combined, LABELS), sv=src.getDataRange().getValues();
      if(sc.no<0||sc.name<0) NG('主タブの利用者No/氏名の列を特定できず突合不能（no='+sc.no+' name='+sc.name+'）');
      else{
        joined=true;
        OK('突合に使った列: 利用者No=列'+sc.no+' 氏名=列'+sc.name+'（runMigration のログと同じか確認）');
        for(var r=sh.dRow;r<sv.length;r++){
          var nm=_s(sv[r][sc.name]), nr=_int(_s(sv[r][sc.no]));
          if(!nm||nr==='') continue;
          srcNos[nr]=true; srcName[nr]=_norm(nm); srcCount++;
        }
        var impNos={}, dup=[], nonNum=[], nameNg=[];
        for(var i=1;i<v.length;i++){
          var id=v[i][0];
          if(typeof id!=='number' && !/^\d+$/.test(String(id))) nonNum.push('行'+(i+1));
          if(impNos[id]) dup.push('No'+id);
          impNos[id]=true;
          // ★集合が一致していても「Noと人物の対応がずれている」可能性がある。氏名は出さず不一致Noだけ報告する
          if(srcName[id]!==undefined && _norm(String(v[i][1]||''))!==srcName[id]) nameNg.push('No'+id);
        }
        var missing=[]; for(var k in srcNos){ if(!impNos[k]) missing.push('No'+k); }
        var extra=[];   for(var k2 in impNos){ if(!srcNos[k2]) extra.push('No'+k2); }
        missing.length ? NG('元シートにあるのに master_import に無い入居者 '+missing.length+'名: '+missing.slice(0,60).join(',')) : OK('元シートの入居者が全員そろっている（'+srcCount+'名）');
        extra.length   ? NG('元シートに無い利用者Noが混入: '+extra.slice(0,60).join(',')) : OK('余分な利用者Noなし');
        dup.length     ? NG('利用者Noの重複: '+dup.join(',')) : OK('利用者Noの重複なし');
        nonNum.length  ? NG('id が数値でない行: '+nonNum.join(',')) : OK('id は全て数値（連番振り直しでない）');
        nameNg.length  ? NG('利用者Noと氏名の対応が元シートと違う '+nameNg.length+'名: '+nameNg.slice(0,40).join(',')+'（行ズレの疑い）') : OK('利用者Noと氏名の対応が元シートと一致');
      }
    }
  }

  // ── 3. dataJson の構造検証 ──
  var emptyJson=[], badJson=[], noName=[], badPhone=[], certEndOnly=[], certNotMonthEnd=[], certNotIso=[],
      careLv={}, lvEmpty=[], consentN=0, srcTags={}, unmapLabels={}, medsNoteN=0,
      maxLen=0, maxNo='', famTotal=0, telTotal=0, logMax=0, hasFam={}, hasMed={}, idMismatch=[];
  for(var i2=1;i2<v.length;i2++){
    var id2=v[i2][0], js=String(v[i2][8]||'');
    if(!js){ emptyJson.push('No'+id2); continue; }
    if(js.length>maxLen){ maxLen=js.length; maxNo='No'+id2; }
    var d; try{ d=JSON.parse(js); }catch(e){ badJson.push('No'+id2); continue; }
    if(String(d.id)!==String(id2)) idMismatch.push('No'+id2);
    var lv=String(d.careLevel||'');
    if(!lv) lvEmpty.push('No'+id2); else careLv[lv]=(careLv[lv]||0)+1;
    if(d.careCertEnd && !d.careCertStart){
      certEndOnly.push('No'+id2);
      var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(d.careCertEnd);
      if(!m) certNotIso.push('No'+id2);
      else{
        // 「翌月の0日＝当月末日」。うるう年も正しく求まる
        var last=new Date(parseInt(m[1],10), parseInt(m[2],10), 0).getDate();
        if(parseInt(m[3],10)!==last) certNotMonthEnd.push('No'+id2);
      }
    }
    if((d.family||[]).length) hasFam[id2]=true;
    (d.family||[]).forEach(function(f){
      famTotal++;
      if(f.phone) telTotal++;
      if(!f.name && (f.phone||f.address)) noName.push('No'+id2);
      var ph=String(f.phone||'');
      if(/^\s*\/|\/\s*\/|\/\s*$/.test(ph)) badPhone.push('No'+id2);
    });
    if(String(d.medsRegular||'')) hasMed[id2]=true;
    if(d.consents && Object.keys(d.consents).length) consentN++;
    (d.supportLog||[]).forEach(function(s2){ if(s2.src) srcTags[_headLabel(s2.src)]=(srcTags[_headLabel(s2.src)]||0)+1; });
    if((d.supportLog||[]).length>logMax) logMax=(d.supportLog||[]).length;
    (d.unmappedRaw||[]).forEach(function(u){ var L=_headLabel(u.label); unmapLabels[L]=(unmapLabels[L]||0)+1; });
    if(String(d.medsNotes||'').indexOf(MEDS_EXTRA_TAG)>=0) medsNoteN++;
  }
  emptyJson.length ? NG('dataJson が空の行: '+emptyJson.join(',')) : OK('dataJson は全行に入っている');
  badJson.length   ? NG('dataJson が壊れている: '+badJson.join(',')) : OK('dataJson は全行が正しいJSON');
  idMismatch.length? NG('A列のidと dataJson.id が不一致: '+idMismatch.join(',')) : OK('A列のidと dataJson.id が一致');
  noName.length    ? NG('氏名が空なのに電話/住所がある家族: '+noName.join(',')) : OK('氏名なしの家族レコードなし');
  badPhone.length  ? NG('電話に空要素の連結（" / " の重複等）: '+badPhone.join(',')) : OK('電話の連結が壊れていない');
  certNotIso.length? NG('満了日が日付として解釈できない: '+certNotIso.join(',')) : OK('満了日は全てISO日付');
  /* ★1件でも月末でなければ❌、という判定は厳しすぎた。
     認定有効期間は原則として月末で終わるが、新規認定・区分変更申請では申請日起算のため
     月末以外の満了日が正当にありうる。少数の外れ値で全体の解釈は覆らない。
     大半が月末でなければ解釈ミスを疑い、少数なら個別確認（目視）に回す。 */
  if(!certEndOnly.length) OK('満了日のみの入居者なし');
  else if(!certNotMonthEnd.length) OK('満了日のみの分は全て月末（CERT_SINGLE_DATE_AS=end の裏付け）');
  else if(certNotMonthEnd.length/certEndOnly.length > 0.2)
    NG('満了日が月末でない: '+certNotMonthEnd.length+'/'+certEndOnly.length+'名（'+certNotMonthEnd.slice(0,40).join(',')+'）'+
       '→過半に近いので単一日付の解釈(CERT_SINGLE_DATE_AS)自体を要再検討');
  else
    TODO('満了日が月末でない: '+certNotMonthEnd.join(',')+'（'+certNotMonthEnd.length+'/'+certEndOnly.length+'名）'+
         '→新規認定・区分変更なら月末以外も正当。元シートの認定期間欄を確認してください');
  var badLv=[]; for(var kk in careLv){ if(!/^(要介護[1-5]|要支援[12]|自立)$/.test(kk)) badLv.push(_shape(kk)); }
  // ★_careLevel は変換不能時に原文を保持する。原文が自由記述なら個人情報になりうるので形だけ出す
  badLv.length ? NG('想定外の介護度表記(形): '+badLv.join(',')+' → 週間計画の単位計算が狂います') : OK('介護度は全て正規表記');
  lvEmpty.length ? TODO('介護度が空: '+lvEmpty.length+'名 '+lvEmpty.slice(0,40).join(',')+' → 週間計画で限度額チェックが効きません') : OK('介護度が空の入居者なし');
  maxLen>45000 ? NG('dataJson が5万字に近い: '+maxNo+' '+maxLen+'字') : OK('dataJson 最大長 '+maxLen+'字（'+maxNo+'）上限に余裕あり');

  // ── 4. 家族・薬タブとの突合（主タブだけでは「家族が付かなかった人」を見つけられない）──
  [[SHEET_FAMILY,'家族',LABELS_FAMILY,'family',hasFam],[SHEET_MEDS,'薬',LABELS_MEDS,'medsRegular',hasMed]].forEach(function(t){
    var s3=ss.getSheetByName(t[0]); if(!s3){ NG(t[1]+'タブ「'+t[0]+'」を開けず突合できません'); return; }
    var h3=_headers(s3); if(!h3){ NG(t[1]+'タブのヘッダー行を特定できず突合できません'); return; }
    var c3=_mapCols(h3.combined, t[2]), v3=s3.getDataRange().getValues();
    if(c3.no<0||c3[t[3]]<0){ NG(t[1]+'タブの利用者No/'+t[3]+' 列を特定できず突合できません'); return; }
    var want=[], n3=0;
    for(var r3=h3.dRow;r3<v3.length;r3++){
      var no3=_int(_s(v3[r3][c3.no])); if(no3==='') continue;
      if(!_s(v3[r3][c3[t[3]]])) continue;          // 元シート側が空なら期待しない
      if(ACK_NO_MAIN.indexOf(no3)>=0) continue;    // 未入居は対象外
      n3++;
      if(!t[4][no3]) want.push('No'+no3);
    }
    want.length ? NG(t[1]+'タブに記載があるのに master_import に入っていない入居者 '+want.length+'名: '+want.slice(0,60).join(','))
                : OK(t[1]+'タブの記載者が全員 master_import に反映されている（'+n3+'名）');
  });

  // ── 5. 実測値（人が突き合わせる）──
  TODO('家族の総数 '+famTotal+'件 / うち電話あり '+telTotal+'件');
  TODO('認定期間が満了日のみ: '+certEndOnly.length+'名（DRY_RUN実測は46名）');
  TODO('介護度の内訳: '+(function(){var a=[];for(var q in careLv)a.push(q+'='+careLv[q]+'名');return a.join(' / ')})());
  TODO('同意・確認書がある入居者: '+consentN+'名');
  TODO('支援経過の出所タグ: '+(function(){var a=[];for(var q2 in srcTags)a.push(q2+'='+srcTags[q2]+'件');return a.length?a.join(' / '):'なし'})()+' / 1人最大 '+logMax+'件');
  TODO('退避データの内訳: '+(function(){var a=[];for(var q3 in unmapLabels)a.push(q3+'='+unmapLabels[q3]+'名');return a.length?a.join(' / '):'なし'})());
  TODO('薬備考へ退避: '+medsNoteN+'名（DRY_RUN実測は48名）');
  var act=0; for(var i3=1;i3<v.length;i3++){ if(_truthyImp(v[i3][6])) act++; }
  TODO('在籍(active)='+act+'名 / 退去・逝去='+(rows-act)+'名 → 実際の入居者数と突き合わせてください');

  // ── 6. 元3タブの形状（改変検知ではなく「移行後に元シートが更新されたか」の目安）──
  [[SHEET_MAIN,141,71],[SHEET_FAMILY,140,27],[SHEET_MEDS,144,11]].forEach(function(t){
    var s4=ss.getSheetByName(t[0]); if(!s4){ NG('元タブ「'+t[0]+'」が見つからない'); return; }
    var R=s4.getLastRow(), C=s4.getLastColumn();
    // ★元シートは現役の業務シート。1名追加でも形が変わるので、これは NG ではなく目視項目にする
    (R===t[1]&&C===t[2]) ? OK('元タブ「'+t[0]+'」'+R+'行×'+C+'列（移行時と同じ）')
                         : TODO('元タブ「'+t[0]+'」が '+R+'行×'+C+'列（移行時は'+t[1]+'行×'+t[2]+'列）→移行後に更新された可能性。再移行の要否を判断してください');
  });

  Logger.log('■ 自動判定 合格: '+ok.length+'件');
  _logJoin('  ✅', ok, 1);
  if(todo.length){ Logger.log('■ 目視で確認する項目: '+todo.length+'件'); _logJoin('  👁', todo, 1); }
  if(ng.length){
    Logger.log('■ 要対応: '+ng.length+'件 → 解消するまで master へ昇格しないでください');
    _logJoin('  ❌', ng, 1);
  }else{
    Logger.log('■ 要対応: 0件 ✅ 自動判定は通過。上の「目視で確認する項目」'+todo.length+'件を確認してから昇格してください'+
      (joined?'':'  ⚠️ ただし元シートとの突合は実施できていません'));
  }
}
function _truthyImp(x){ return !(x===false||x===''||x==='false'||x==='FALSE'||x==='退去'); }

/* ═══════════ 診断出力（DRY_RUN の原因特定用・書込には影響しない） ═══════════ */

/* 全タブ名と gid を一覧する。読み取りのみで、シートは一切変更しない。
   スプレッドシートURLの末尾 #gid=… と突き合わせて
   SHEET_MAIN / SHEET_FAMILY / SHEET_MEDS を確定するために使う。
   （同系統のタブが多数あり、自動検出が意図と違うタブを掴むことがあるため） */
/* ★タブが入居者ごとに作られている場合、タブ名＝氏名になる。
   実行ログはCloud Loggingに残り、シートのACLを後から締めても回収できないため、
   「構造を表す語を含まない名前は伏せる」fail-safe にする（未知は伏せる側に倒す）。
   目的（3タブの特定）には構造タブの名前だけあれば足り、伏せた分も gid で特定できる。 */
var SAFE_TAB_WORDS = ['入居者','利用者','家族','薬','マスタ','master','import','一覧','様式','テンプレ','設定'];
function _tabLabel(nm){
  var s = String(nm==null?'':nm);
  for(var i=0;i<SAFE_TAB_WORDS.length;i++){ if(s.indexOf(SAFE_TAB_WORDS[i])>=0) return '「'+s+'」'; }
  return '（伏せ字・'+s.length+'字）';   // 氏名の可能性があるため1文字も出さない
}
function listSheets(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss){ Logger.log('❌ スプレッドシートにバインドされていません'); return; }
  var sheets = ss.getSheets();
  Logger.log('■ タブ一覧（'+sheets.length+'枚） … gid / データ範囲 / タブ名');
  sheets.forEach(function(sh,i){
    Logger.log('  '+(i+1)+'. gid='+sh.getSheetId()+'  '+sh.getLastRow()+'行×'+sh.getLastColumn()+'列  '+_tabLabel(sh.getName()));
  });
  Logger.log('※ URLの #gid=… と照合して、入居者情報／家族情報／薬情報のタブ名を確定してください。');
  Logger.log('※「（伏せ字・N字）」は氏名の可能性がある名前です。必要ならgidでシートを開いて確認してください。');
}

/* ★見出しダンプ用のマスク。_headers がサブ見出し行を誤検出すると、
   実データ行（家族氏名・電話番号・薬剤名）が「見出し」としてログに出てしまう。
   実行ログはCloud Loggingに残り回収できないため、見出しらしくない値は伏せる。
   （_tabLabel と同じ「未知は伏せる側に倒す」方針） */
function _headLabel(h){
  var s=String(h==null?'':h);
  if(s.length>24) return '(伏せ・'+s.length+'字)';                      // 見出しに24字超は稀。長文＝データ
  if(/\d{2,4}-\d{2,4}-\d{3,4}/.test(s)) return '(伏せ・電話形式)';
  if(/\d+\s*(mg|ml|µg|mcg|錠|包|カプセル)/i.test(s)) return '(伏せ・用量形式)';
  if(/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(s)) return '(伏せ・日付形式)';
  return s;
}
/* 見出し配列をマスクしつつ「列番号:見出し」の形に整える */
function _headDump(comb){
  return comb.map(function(h,i){ return i+':'+_headLabel(h); });
}
/* 長い配列をper件ずつ折り返してログに出す（1行が長すぎて読めなくなるのを防ぐ） */
function _logChunks(arr, per){
  per = (typeof per==='number' && per>0) ? Math.floor(per) : 12;   // 0/負数/未指定での無限ループを防ぐ
  for(var i=0;i<arr.length;i+=per){
    Logger.log('   '+arr.slice(i,i+per).join(' | '));
  }
}
/* ★診断ブロックを「1ブロック＝1ログエントリ」で出す。
   見出し行とインデントされた明細行に分けると、実行ログから明細だけが
   コピーされずに落ちる事象が3回続いたため（2026-07-19）。
   1エントリなら行をクリック／ドラッグするだけで全体が選択できる。 */
var LOG_COMPACT = true;
var LOG_BUDGET = 2500;   // 1エントリの目安字数。超えたら (n/m) に分割する
function _logJoin(title, arr, per){
  if(!arr || !arr.length){ Logger.log(title+' なし'); return; }
  if(!LOG_COMPACT){ Logger.log(title); _logChunks(arr, per||12); return; }
  /* ★1エントリが長すぎると表示側で無警告に切り詰められ、末尾の種類
     （＝件数が少なく見落としやすい重要な警告）から順に消える。
     字数バジェットで分割し、各エントリに実字数を併記して切り詰めを検知できるようにする。 */
  var parts=[], buf=[], len=0, i;
  for(i=0;i<arr.length;i++){
    if(len && len+arr[i].length>LOG_BUDGET){ parts.push(buf.join(' ¶ ')); buf=[]; len=0; }
    buf.push(arr[i]); len+=arr[i].length+3;
  }
  if(buf.length) parts.push(buf.join(' ¶ '));
  for(i=0;i<parts.length;i++){
    Logger.log(title+(parts.length>1?(' ('+(i+1)+'/'+parts.length+')'):'')+' '+parts[i]+'  ※'+parts[i].length+'字');
  }
}

/* 複数列を1グループで読む項目について、実際に何列あるかを出す。
   gAt() の「グループの外」警告が大量に出た時、どのオフセットが行き過ぎか一目で分かる。 */
function _logGroups(comb, col){
  var keys=['careCert','careOffice','welfareEquip','hospital','pharmacy'];
  var need=GAT_SPAN;   // ★_logUnused と同じ定義を使う。二重定義だと片方だけ直して不整合になる
  var lines=[];
  keys.forEach(function(k){
    var i=col[k];
    if(i==null||i<0){ lines.push(k+':見出し未検出'); return; }
    var grp=String(comb[i]||'').split('/')[0], span=[];
    for(var j=i;j<comb.length;j++){
      if(String(comb[j]||'').split('/')[0]!==grp) break;
      span.push(j+':'+_headLabel(comb[j]));
    }
    var short=span.length<need[k];
    lines.push(k+' 開始列'+i+' 実際'+span.length+'列/必要'+need[k]+'列 '+
      (short?(FLEX_KEYS[k]?'✅(1セル記載として処理)':'❌不足'):'✅')+' ['+span.join(' | ')+']');
  });
  _logJoin('■ 結合グループの実列数:', lines, 1);
}

/* どのフィールドにも割り当てられていない列＝取り込まれずに捨てられる列を出す。
   ★2列結合でサブ見出しが空だと _mapCols は2列目を拾えず、中身が黙って消える
     （実例: 薬タブの「内服(定期薬)」列3・列4で、列4が丸ごと捨てられていた）。
     gAt でオフセット参照する列は「使用済み」に数える。 */
var GAT_SPAN = {careCert:3, careOffice:4, welfareEquip:3, hospital:4, pharmacy:3};
/* グループ内の全列を読む項目（列数が可変）。_logUnused で「未使用」と誤報しないため。 */
var VARSPAN_KEYS = {supportLog:true};
/* 実列数が想定より少なくても正しく処理できる項目（1セル記載への対応済み）。 */
var FLEX_KEYS = {careCert:true};
function _logUnused(comb, col, label){
  var used={};
  Object.keys(col).forEach(function(k){
    var i=col[k]; if(i==null||i<0) return;
    used[i]=true;
    var grp=String(comb[i]||'').split('/')[0];
    if(VARSPAN_KEYS[k]){   // グループ内の全列を読む
      for(var jj=i+1;jj<comb.length;jj++){
        if(String(comb[jj]||'').split('/')[0]!==grp) break;
        used[jj]=true;
      }
      return;
    }
    var span=GAT_SPAN[k]; if(!span) return;
    for(var o=1;o<span;o++){
      var j=i+o;
      if(j<comb.length && String(comb[j]||'').split('/')[0]===grp) used[j]=true;
    }
  });
  var un=[];
  for(var i2=0;i2<comb.length;i2++){
    var h=String(comb[i2]||'');
    if(used[i2] || h==='__EXCLUDE__' || !h) continue;
    un.push(i2+':'+_headLabel(h));
  }
  if(!un.length){ Logger.log('■ '+label+' 未使用列: なし ✅'); return; }
  _logJoin('■ '+label+' 未使用列（'+un.length+'列・取り込まれません）:', un, 8);
}

/* 警告文から「個体を特定する部分」だけを伏せて種類に畳む。
   ★序数（2列目/3列目）・件数（氏名3/続柄2…・薬剤12行/効能7行）は伏せない。
     ここを潰すと「担当者が空」と「TELが空」、「(2,2,1,0)」と「(3,1,3,3)」が
     同じ種類に見え、どのフィールドが・誰の連絡先が壊れたのか判別できなくなる。 */
function _digest(m){
  return String(m)
    .replace(/（"[^"]*"）/g,'（"…"）')
    .replace(/"[^"]*"/g,'"…"')
    .replace(/利用者No重複:\s*\d+/g,'利用者No重複: *')
    .replace(/利用者No=\s*\d+/g,'利用者No=*')
    .replace(/利用者No\d+/g,'利用者No*')
    .replace(/行\d+:/g,'行*:')
    .replace(/（行\d+）/g,'（行*）')
    .replace(/（列\d+）/g,'（列*）')
    .replace(/原文長\d+字/g,'原文長*字');
}
/* 警告1件から「どの入居者・どの行の話か」を取り出す（追跡用の目印） */
function _locOf(m){
  var s=String(m);
  var a=s.match(/利用者No(?:重複)?[:：=]?\s*(\d+)/); if(a) return 'No'+a[1];
  var b=s.match(/行(\d+)/);                          if(b) return '行'+b[1];
  return '';
}
/* 種類別に件数の多い順で出す。
   ★件数だけにすると「移行されなかった入居者」を追えなくなるため、
     各種類について対象の利用者No/行番号を必ず列挙する（Noは氏名ではなく連携キー）。 */
function _report(title, list, sampleN, locShow){
  if(!list.length){ Logger.log('■ '+title+': なし ✅'); return; }
  /* ★致命側は対象Noを全件出す。137名全員に出る種類だと20件打切りでは
     「どの入居者が落ちたか」を追えず、過去の審査で必須とされた追跡性を失う。 */
  var LOC_MAX=(locShow===Infinity)?400:60;
  var groups={}, order=[];
  list.forEach(function(m){
    var k=_digest(m);
    if(!groups[k]){ groups[k]={n:0, ex:[], loc:[], locMore:0}; order.push(k); }
    groups[k].n++;
    if(groups[k].ex.length<sampleN) groups[k].ex.push(m);
    var lc=_locOf(m);
    if(lc && groups[k].loc.indexOf(lc)<0){
      if(groups[k].loc.length<LOC_MAX) groups[k].loc.push(lc); else groups[k].locMore++;
    }
  });
  order.sort(function(a,b){ return groups[b].n-groups[a].n; });
  /* ★全種類を1エントリにまとめる。行を分けると実行ログからのコピーで
     明細だけが取りこぼされる（26種類×3行は実際にコピーされなかった）。 */
  var LOC_SHOW=(locShow===Infinity)?LOC_MAX:(locShow||20), lines=[];
  order.forEach(function(k,i){
    var g=groups[k], loc='';
    if(g.loc.length){
      var hidden=Math.max(0,g.loc.length-LOC_SHOW)+g.locMore;
      loc='  対象: '+g.loc.slice(0,LOC_SHOW).join(',')+(hidden?(' …他'+hidden+'件'):'');
    }
    lines.push('['+(i+1)+']'+g.n+'件 '+k+loc);
    g.ex.forEach(function(x){ lines.push('例:'+x); });
  });
  _logJoin('■ '+title+'（'+order.length+'種類 / 計'+list.length+'件）:', lines, 1);
}

/* ═══════════ レコード変換 ═══════════ */

/* 見出しグループが実際に何列あるか */
function _groupSpan(comb, i){
  if(i==null||i<0) return 0;
  var grp=String(comb[i]||'').split('/')[0], n=0;
  for(var j=i;j<comb.length;j++){
    if(String(comb[j]||'').split('/')[0]!==grp) break;
    n++;
  }
  return n;
}
/* 同一グループの全セルを {v, sub} で取る（支援経過のように横へ伸びる列の取りこぼしを防ぐ）。
   sub はサブ見出し（例「旧CM」）で、記録者の別を失わないために保持する。 */
function _groupCells(row, comb, i){
  if(i==null||i<0) return [];
  var grp=String(comb[i]||'').split('/')[0], out=[];
  for(var j=i;j<comb.length;j++){
    var h=String(comb[j]||'');
    if(h.split('/')[0]!==grp) break;
    out.push({v:_s(row[j]), sub:(h.split('/')[1]||'')});
  }
  return out;
}
/* 「R6.4.1〜R8.3.31」のような1セル記載の期間を開始/終了に分ける。
   ★分けられない場合は原文を開始側に残す（消さない）。
     日付内のハイフンと区間のハイフンを区別できないため、区切りは
     波ダッシュ類と「空白で囲まれたハイフン」に限定する。 */
function _splitRange(v){
  var s=_s(v); if(!s) return {start:'',end:'',cert:'',raw:s};
  /* ★区切り文字を列挙する方式だと、全角ハイフン(－)等を取りこぼした瞬間に
     「先頭の日付だけ拾って終了日は消える」。認定有効期間の満了日は更新申請の
     判断材料なので、消してはいけない。
     そこで区切り文字に依存せず、日付らしいトークンを全部拾って個数で判断する。 */
  var re=/(?:令和|平成|昭和|R|H|S)?\s*\d{1,4}\s*[.\-\/年]\s*\d{1,2}\s*[.\-\/月]\s*\d{1,2}\s*日?/g;
  var m=_han(s).match(re);
  if(m && m.length>=3) return {start:_date(m[0]), end:_date(m[1]), cert:_date(m[2]), raw:s};
  if(m && m.length===2) return {start:_date(m[0]), end:_date(m[1]), cert:'', raw:s};
  if(m && m.length===1) return {start:_date(m[0]), end:'', cert:'', raw:s};
  return {start:s, end:'', cert:'', raw:s};   // 「未定」等。原文をそのまま残す（消さない）
}
/* 値の「形」だけを出す（内容は伏せる）。
   要配慮個人情報の中身を出さずに、正規化できない原因（全角・併記・表記ゆれ）を特定するため。 */
function _shape(s){
  return String(s==null?'':s)
    .replace(/[0-9]/g,'9').replace(/[０-９]/g,'９')
    .replace(/[A-Za-z]/g,'A').replace(/[Ａ-Ｚａ-ｚ]/g,'Ａ')
    .replace(/[ぁ-ん]/g,'ぁ').replace(/[ァ-ヶ]/g,'ァ')
    .replace(/[\u3005\u4E00-\u9FFF\uF900-\uFAFF]/g,'漢').slice(0,24);
}

function _toRecord(row, col, no, comb){
  function g(k){ var i=col[k]; return (i==null||i<0)?'':_s(row[i]); }
  /* ★結合見出しグループの2列目以降を読む。
     「居宅」が3列しか無いのに4列目を読む等、グループ境界を越えると
     隣の無関係な列（福祉用具の事業所名など）を取り込んでしまうため、
     同一グループであることを検証し、外なら空＋警告に倒す（誤った値を入れない）。 */
  function gAt(k,off){
    var i=col[k]; if(i==null||i<0) return '';
    var j=i+off;
    var grp=String((comb&&comb[i])||'').split('/')[0];
    var tgt=String((comb&&comb[j])!=null?comb[j]:'');
    if(!tgt || tgt.split('/')[0]!==grp){
      _w('❌ 利用者No'+no+': '+k+' の'+(off+1)+'列目がグループ「'+_headLabel(grp)+'」の外（列'+j+'）→空にしました。要目視');
      return '';
    }
    return _s(row[j]);
  }

  var disRaw=g('dischargeDate'), deathRaw=g('deathDate');
  var disISO=_date(disRaw), deathISO=_date(deathRaw);
  var isDate=function(x){ return /^\d{4}-\d{2}-\d{2}$/.test(x); };
  // ★在籍判定は「日付として成立しているか」で行う。
  //   原文判定だと退去日欄の「未定」「-」等で在籍者が退去扱いになり、各アプリの名簿から消える。
  var active = !(isDate(disISO)||isDate(deathISO));
  /* ★生セル値はログに出さない。退去日・ご逝去日欄には自由記述（搬送先・経緯）が
     入っていることがあり、利用者Noと組で要配慮個人情報になる。
     ログには「どの利用者Noか」だけ残し、中身は master_import と元シートで目視する。 */
  if(disRaw && !isDate(disISO)) _w('利用者No'+no+': 退去日を日付として解釈できず在籍のまま（原文長'+disRaw.length+'字）。要目視');
  if(deathRaw && !isDate(deathISO)) _w('利用者No'+no+': ご逝去日を日付として解釈できず在籍のまま（原文長'+deathRaw.length+'字）。要目視');
  var cl = _careLevel(g('careLevel'));
  var cp = _copay(g('copayRate'));

  /* ★実データの「認定期間」は列13の1列だけ（2026-07-19 判明）。
     3列あるものとして gAt を呼んでいたため、137名×2件＝274件の❌を量産していた。
     1列なら中身が「開始〜終了」の1セル記載とみなして分離し、分離できなければ原文を残す。 */
  var certSpan = _groupSpan(comb, col.careCert);
  var certStart='', certEnd='', certDate='';
  if(certSpan>=3){
    certStart=_date(g('careCert')); certEnd=_date(gAt('careCert',1)); certDate=_date(gAt('careCert',2));
  }else if(certSpan===2){
    // 2列目が「終了日」か「認定日」かは見出しから判別できない。終了日として扱うが必ず目視対象に載せる
    certStart=_date(g('careCert')); certEnd=_date(gAt('careCert',1));
    _w('利用者No'+no+': 認定期間が2列構成。2列目を終了日として扱いました。認定日の可能性があるため要目視');
  }else{
    var cr=_splitRange(g('careCert'));
    certDate=cr.cert;
    if(cr.end){ certStart=cr.start; certEnd=cr.end; }
    else if(cr.start && /^\d{4}-\d{2}-\d{2}$/.test(cr.start)){
      _certDays.push(parseInt(cr.start.slice(8,10),10));   // 日だけ集計（開始日か認定日かの判定材料）
      // 日付が1つだけ。開始日か満了日かで意味が真逆になるため推測しない
      if(CERT_SINGLE_DATE_AS==='end'){ certEnd=cr.start;
        _w('利用者No'+no+': 認定期間の単一日付を満了日として格納（CERT_SINGLE_DATE_AS='+CERT_SINGLE_DATE_AS+'）。要目視'); }
      else if(CERT_SINGLE_DATE_AS==='start'){ certStart=cr.start;
        _w('利用者No'+no+': 認定期間の単一日付を開始日として格納（CERT_SINGLE_DATE_AS='+CERT_SINGLE_DATE_AS+'）。要目視'); }
      else if(CERT_SINGLE_DATE_AS==='cert'){ certDate=cr.start;
        _w('利用者No'+no+': 認定期間の単一日付を認定日として格納（CERT_SINGLE_DATE_AS='+CERT_SINGLE_DATE_AS+'）。要目視'); }
      else { certStart=cr.start;
        _w('❌ 利用者No'+no+': 認定期間の日付が1つだけで開始日か満了日か未確定（暫定で開始日に格納）→CERT_SINGLE_DATE_AS を設定してください'); }
    }
    else if(cr.raw){ certStart=cr.start; _w('利用者No'+no+': 認定期間を日付として解釈できず原文のまま保持（形='+_shape(cr.raw)+'）'); }
  }

  /* ★列58・列59が両方「日常生活自立度」（2026-07-19 実測）。
     障害高齢者/認知症高齢者の並びと推測されるが見出しからは確定できず、
     取り違えは要配慮情報の取り違えになるため推定せず原文を退避する（薬タブ列4と同じ方針）。
     実シートを確認したら LABELS.dementia か COL 指定で正しく割り当て、この退避を解消すること。 */
  var unmapped=[];
  var adlSpan=_groupSpan(comb, col.adl);
  if(col.adl>=0 && adlSpan>=2){
    var adl2=_s(row[col.adl+1]);
    if(adl2) unmapped.push({label:'日常生活自立度の2列目（分類未確定・認知症自立度の可能性）', value:adl2});
  }
  // 享年（列57）はマスタに対応項目が無いが、捨てずに退避する
  var deathAgeCol=-1;
  for(var ci=0;ci<comb.length;ci++){ if(String(comb[ci]||'')==='享年'){ deathAgeCol=ci; break; } }
  if(deathAgeCol>=0){ var da=_s(row[deathAgeCol]); if(da) unmapped.push({label:'享年', value:da}); }

  var dayUse={};
  [['mon','dayUseMon'],['tue','dayUseTue'],['wed','dayUseWed'],['thu','dayUseThu'],['fri','dayUseFri'],['sat','dayUseSat']]
    .forEach(function(p){ var v=g(p[1]); if(v) dayUse[p[0]]=v; });

  var rec = {
    id: no,                                   // ★利用者No をそのまま採用（連携キー）
    name:g('name'), kana:g('kana'), room:g('room'), gender:g('gender'),
    careLevel: cl.value, active: active,
    updatedAt: new Date().toISOString(),
    birthDate:_date(g('birthSeireki')||g('birthWareki')),
    admissionDate:_date(g('admissionDate')),
    dischargeDate:disISO, deathDate:deathISO, dischargeTo:g('dischargeTo'),
    careCertStart:certStart, careCertEnd:certEnd, certDate:certDate,
    copayRate: cp.rate, welfare: cp.welfare,
    height:_num(g('height')), weight:_num(g('weight')),
    adl:g('adl'), dementia:g('dementia'), visitDay:g('visitDay'),
    // 居宅4列・福祉用具3列・病院4列・薬局3列は「グループ見出しの先頭列＋オフセット」で取る
    careOffice:g('careOffice'), careManager:gAt('careOffice',1), careOfficeTel:gAt('careOffice',2), careOfficeFax:gAt('careOffice',3),
    welfareEquip:g('welfareEquip'), welfareEquipStaff:gAt('welfareEquip',1), welfareEquipTel:gAt('welfareEquip',2),
    serviceManager:g('serviceManager'),
    hospital:g('hospital'), doctor:gAt('hospital',1), hospitalTel:gAt('hospital',2), hospitalFax:gAt('hospital',3),
    pharmacy:g('pharmacy'), pharmacyTel:gAt('pharmacy',1), pharmacyFax:gAt('pharmacy',2),
    emergencyHospital:g('emergencyHospital'),
    allergy:g('allergy'), sideEffects:g('sideEffects'),
    currentDiseases:g('currentDiseases'), pastHistory:g('pastHistory'),
    preAdmission:g('preAdmission'), postDischarge:g('postDischarge'),
    medsNotes:g('medsNotes'),
    mealStaple:g('mealStaple'), mealSide:g('mealSide'), mealNote:g('mealNote'),
    /* ★支援経過は列60〜70の11列に横へ伸びていた（2026-07-19 判明）。
       先頭列だけ読んでいたため10列分＝大量の経過記録を捨てていた。
       グループ内の全列を順に連結する。備考も和暦日付始まりの追記ログなので同じ配列へ入れる。 */
    supportLog:_groupCells(row, comb, col.supportLog)
                 .reduce(function(acc,c){ return acc.concat(_splitLog(c.v, c.sub)); }, [])
                 .concat(_splitLog(g('note'), '備考')),
    careLevelHistory:[], medicalSupportLog:[], medsPastLog:[], family:[],
    xref:{ sheetNo: no },                     // 移行元の行を辿れるようにしておく
    /* 分類が確定していない列の原文。捨てずに保持し、確定後に正しい項目へ移す。
       （マスタに対応項目が無いため画面には出ないが、master_import には残る） */
    targetApps: DEFAULT_TARGET_APPS.slice()
  };
  if(unmapped.length) rec.unmappedRaw=unmapped;
  if(Object.keys(dayUse).length) rec.dayUse=dayUse;
  // 介護度は心身の機能の障害に関する情報、負担割合は生活保護受給（社会的身分）を含みうる。どちらも生値は出さない。
  /* ★正規化できない介護度は週間計画(care-schedule)の CARE_LIMITS / DAYCARE_BASE_UNITS で
     キーに一致せず、限度額チェックが0・単価が要介護1へ無警告フォールバックする。
     表示が崩れるだけでなく単位計算が静かに狂うので❌にして元シートの修正を促す。 */
  if(cl.warn) _w('❌ 利用者No'+no+': 介護度を正規化できません（形='+_shape(cl.raw)+'）→このままだと週間計画の単位計算が無警告で狂います。元シートを正式表記（要介護N等）に直してください');
  if(cp.warn) _w('利用者No'+no+': 負担割合を正規化できず原文のまま保持（形='+_shape(cp.raw)+'）');
  return rec;
}

/* ═══════════ 家族情報タブ ═══════════ */
function _mergeFamily(sh, byNo){
  var H=_headers(sh); if(!H){ _w('家族情報: ヘッダー行が特定できません'); return; }
  var col=_mapCols(H.combined, LABELS_FAMILY);
  var miss=Object.keys(col).filter(function(k){return col[k]<0});
  Logger.log('■ 家族情報タブ: '+_tabLabel(sh.getName())+
    ' / 見出し行'+(H.gRow+1)+' サブ'+(H.sRow<0?'なし':(H.sRow+1))+' データ開始'+(H.dRow+1)+
    ' / マッピング '+JSON.stringify(col)+(miss.length?('  ⚠️未検出: '+miss.join(',')):''));
  /* ★27列ある。家族を「1セル内で改行」ではなく「家族①氏名/家族①続柄/家族②氏名…」と
     列方向に並べている場合、_splitMulti による分解は成立せず取込方式ごと作り直しになる。
     判断のため見出しを必ず全部出す。 */
  _logJoin('■ 家族情報タブ 見出し一覧 全'+H.combined.length+'列:', _headDump(H.combined), 12);
  /* ★実データの列構成（2026-07-19 判明）:
       5:緊急連絡先 / 6:電話 / 7:家族 / 8:電話 / 9:住所
     「電話」が2つあり、_mapCols は先に現れた列6（＝緊急連絡先の電話）を phone に割り当てる。
     その結果、家族氏名に緊急連絡先の電話が紐づき、本物の家族電話（列8）は捨てられていた。
     「氏名列の直後の電話列」という位置関係で割り当て直す。 */
  function _phoneAfter(i){
    var j=(i==null||i<0)?-1:i+1;
    var h=(j>0 && j<H.combined.length) ? String(H.combined[j]||'') : '';
    return (/電話/.test(h) && !/電話以外/.test(h)) ? j : -1;   // 列10「住所/電話以外の連絡手段」を拾わない
  }
  var famPhone=_phoneAfter(col.family), emgPhone=_phoneAfter(col.emergency);
  if(famPhone>=0 && col.phone!==famPhone){
    Logger.log('⚠️ 家族の電話を'+(col.phone<0?'未検出':('列'+col.phone))+'→列'+famPhone+'に修正（家族氏名の直後の電話列）');
    col.phone=famPhone;
  }
  if(emgPhone>=0 && col.emergencyPhone<0){
    Logger.log('⚠️ 緊急連絡先の電話を列'+emgPhone+'に割当（緊急連絡先の直後の電話列）');
    col.emergencyPhone=emgPhone;
  }
  /* 同意・確認書と、マスタ未対応だが捨てたくない列を解決する。
     col に入れておくことで _logUnused が「未使用」と誤報しない。 */
  function _findCol(label){
    var want=_normHead(label);
    for(var i=0;i<H.combined.length;i++){ if(String(H.combined[i]||'')===want) return i; }
    return -1;
  }
  var consentCols={}, consentMiss=[];
  CONSENT_MAP.forEach(function(pair){
    var i=_findCol(pair[1]);
    if(i>=0){ consentCols[pair[0]]=i; col['consent_'+pair[0]]=i; }
    else consentMiss.push(pair[0]);
  });
  Logger.log('■ 同意・確認書の対応: '+Object.keys(consentCols).length+'/'+CONSENT_MAP.length+'項目'+
    (consentMiss.length?('  ⚠️未検出: '+consentMiss.join(',')):' ✅'));
  // 見出しの表記ゆれ1文字で静かに欠落するため、揃わなければ止める（主タブの未検出と同じ扱い）
  if(consentMiss.length)
    _w('❌ 家族情報: 同意・確認書の'+consentMiss.join(',')+' が未検出→この項目は全員分が空になります。CONSENT_MAP の見出しを実際の文字列に合わせてください');
  var extraCols=[];
  FAMILY_EXTRA.forEach(function(label){
    var i=_findCol(label);
    if(i>=0){ extraCols.push({i:i, label:label}); col['extra_'+i]=i; }
  });
  _logUnused(H.combined, col, '家族情報タブ');
  /* 上の位置ベース補正が効かない列構成（電話が家族氏名より前にしか無い等）への保険。
     その状態で家族氏名と添字対応させると家族①に緊急連絡先の電話が付き、
     緊急連絡先本人は電話空欄になる。緊急時にかける番号なので、
     疑わしい場合は家族へ紐付けず緊急連絡先側の電話として扱う。 */
  var phoneIsEmergency = (col.phone>=0 && col.family>=0 && col.phone<col.family && col.emergencyPhone<0);
  if(phoneIsEmergency)
    _w('❌ 家族情報: 電話の列('+col.phone+')が家族氏名の列('+col.family+')より前→緊急連絡先側の電話とみなし、'+
       '家族への紐付けは行いません（別人の番号が付くのを防ぐため）。実際の列構成を要確認');
  /* ★2行見出し（グループ「家族」＋サブ「氏名/続柄/電話/住所」）だと
     _mapCols のグループ名フォールバックは先頭列しか拾えず、続柄・電話・住所が -1 になる。
     その状態でも family だけは値が入るため「■ 家族情報を反映: 138名」と成功表示され、
     続柄・住所・電話が全員分ゼロのまま通過する。必ず❌で止める。 */
  ['relation','phone','address','emergencyPhone'].forEach(function(k){
    if(col[k]>=0 || ACK_MISSING_FAMILY.indexOf(k)>=0) return;
    _w('❌ 家族情報: 「'+k+'」の列が未検出。このまま進めると全員分が空になります→LABELS_FAMILY に実際の見出しを追記してください');
  });
  var v=sh.getDataRange().getValues(), n=0, seenF={}, scanned=0, skipped=0, namesTotal=0, telsTotal=0;
  for(var r=H.dRow;r<v.length;r++){
    var noRawF=_s(v[r][col.no]);
    var no=_int(noRawF);
    // ★入居者1名分が黙って落ちる経路を作らない（薬タブ側と同じ扱いに揃える）
    if(no===''){ if(noRawF){ skipped++; _w('❌ 家族情報: 利用者No列が数値でない行あり（行'+(r+1)+'・原文長'+noRawF.length+'字）→スキップ'); } continue; }
    scanned++;
    var rec=byNo[no];
    if(!rec){
      skipped++;
      if(ACK_NO_MAIN.indexOf(no)>=0) _w('家族情報: 利用者No'+no+' は未入居のため主タブに無い（確認済み）→スキップ');
      else _w('❌ 家族情報: 利用者No'+no+' が主タブに無い（行'+(r+1)+'）→この家族情報は取り込まれません');
      continue;
    }
    function g(k){ var i=col[k]; return (i==null||i<0)?'':_s(v[r][i]); }
    /* ★分解は _splitNum に一本化する。
       以前は判定を _splitMulti（添字）、紐付けを _splitNum（丸数字）で行っていたため、
       丸数字で正しく突合できている人にまで「別人の番号が紐づく可能性」の❌が出ていた
       （同一人物に矛盾した2つの警告が並ぶ）。判定は必ず実際の突合方法に基づいて行う。 */
    /* ★行位置を保つため生セル値を渡す（g() は _s() 経由で trim され先頭の空行が消える）。 */
    function gRaw(k){
      var i=col[k]; if(i==null||i<0) return '';
      var x=v[r][i]; if(x==null) return '';
      if(x instanceof Date) return _date(x);   // String(Date) はJS既定書式になるのでISOに正規化
      var t=String(x);
      /* _s() が担っていた数式エラーの警告経路がここでは働かないため、明示的に拾う。
         address/phone/emergency/emergencyPhone は gRaw 経由でしか読まないので、
         ここで拾わないと「無警告で空」になる（緊急連絡先の電話が黙って消える）。 */
      if(/^#(REF|ERROR|N\/A|VALUE|DIV|NAME|NUM)/.test(t.trim())){
        _w('❌ 家族情報: 利用者No'+no+' の「'+k+'」が数式エラー（'+t.trim().slice(0,8)+'）→空として扱いました。要目視');
        return '';
      }
      return t;
    }
    var nameSet=_splitNum(gRaw('family')), addrSet=_splitNum(gRaw('address'));
    // 電話が緊急連絡先側の列と判断された場合、家族の電話としては使わない
    var telSet = phoneIsEmergency ? {numbered:false, items:[]} : _splitNum(gRaw('phone'));
    var byNum  = nameSet.numbered && telSet.numbered && nameSet.items.length>0;
    var nN=_countV(nameSet), nT=_countV(telSet), nA=_countV(addrSet);
    var rels=_splitMulti(g('relation'));
    /* 緊急連絡先も家族側と同じ規則で突合する。
       ★従来は丸数字を捨てて添字対応していたため、欠番（①③）があると②に③の番号が付いた。
         最も番号を間違えてはいけない項目なので家族側と揃える。 */
    var emgSet   =_splitNum(gRaw('emergency'));
    var emgTelSet=(phoneIsEmergency ? _splitNum(gRaw('phone')) : _splitNum(gRaw('emergencyPhone')));
    var emgByNum = emgSet.numbered && emgTelSet.numbered;
    function emgTelOf(item, idx){
      if(emgByNum){
        for(var q=0;q<emgTelSet.items.length;q++){ if(emgTelSet.items[q].n===item.n) return emgTelSet.items[q].v; }
        return '';
      }
      return (emgTelSet.items[idx]||{}).v||'';
    }
    /* 電話が1人に複数（自宅＋携帯）、住所が1人分で複数行（郵便番号・番地・建物名の折り返し）
       というのは通常の記載。別人に紐づく事故ではないので、氏名1件のときは全部その人にまとめる
       （氏名の無い家族要素を作らない）。 */
    var oneToMany = (nN===1 && (nT>1 || nA>1));
    /* ★警告は byNum 優先、組み立ては oneToMany 優先という順序の食い違いがあった。
       氏名①1件・電話①②の2件だと実際は oneToMany（①に全部まとめる）が走るのに、
       ログには「丸数字で突合したため紐付きは正しい」と出て目視対象から外れていた。
       組み立て側と同じ優先順位に揃える。 */
    if(byNum && !oneToMany){
      if(nN!==nT) _w('家族情報: 利用者No'+no+' 氏名'+nN+'件/電話'+nT+'件だが丸数字で突合したため紐付きは正しい');
    }else if(oneToMany){
      _w('家族情報: 利用者No'+no+' 氏名1件に電話'+nT+'件/住所'+nA+'件→同一人物の複数連絡先・複数行住所としてまとめました。要目視');
    }else if(nN && nT && nN!==nT){
      /* 2026-07-19 管理者確認:「電話が一つしか報告されていない場合はそうなる」＝件数差自体は正常。
         ただし2通りある。行数が一致していれば空行で行位置が対応しており安全。
         行数まで違うと1人目に別人の番号が付く。同じ文面に混ぜると危険な方が埋もれるので分ける。 */
      if(nameSet.items.length===telSet.items.length)
        _w('家族情報: 利用者No'+no+' 氏名'+nN+'件/電話'+nT+'件・行数一致('+nameSet.items.length+'行)→空行で行位置が対応。要目視');
      else
        /* 2026-07-19 管理者指示:「電話が一つしか報告されていない場合はそうなる。無視して」。
           行数が揃っていないので機械的には1人目に紐付ける。誰に付いたかを明示して目視対象に残す。
           もし2人目の番号だった場合は、元シートの電話欄に空行を入れて行を揃えれば正しくなる。 */
        _w('家族情報: 利用者No'+no+' 氏名'+nN+'件/電話'+nT+'件・行数不一致(氏名'+nameSet.items.length+'行/電話'+telSet.items.length+'行)'+
           '→電話は1人目に紐付けました。2人目の番号なら元シートの電話欄に空行を入れてください。要目視');
    }else if(nN>=2 && nT>=2 && nN===nT){
      /* 件数が一致していても、丸数字が無ければ記載順に頼るため順序の入れ替わりを検出できない。
         緊急時にかける番号なので、件数一致で安心せず目視対象に載せる。 */
      _w('家族情報: 利用者No'+no+' 家族'+nN+'件の電話を記載順で紐付け（丸数字なし）→順序の入れ替わりが無いか要目視');
    }
    if(nN && nA && nN!==nA)
      _w('家族情報: 利用者No'+no+' 氏名'+nN+'件/住所'+nA+'件（同居等で住所がまとまっている可能性）');
    // 同意・確認書（記載があるものだけ入れる。空欄で既存値を潰さない）
    var cs={};
    Object.keys(consentCols).forEach(function(k){ var val=_s(v[r][consentCols[k]]); if(val) cs[k]=val; });
    if(Object.keys(cs).length){
      if(rec.consents){ Object.keys(cs).forEach(function(k){ rec.consents[k]=cs[k]; }); }
      else rec.consents=cs;
    }
    // マスタに対応項目が無い列は原文を退避（捨てない）
    extraCols.forEach(function(e){
      var val=_s(v[r][e.i]); if(!val) return;
      rec.unmappedRaw = rec.unmappedRaw || [];
      rec.unmappedRaw.push({label:e.label, value:val});
    });
    /* 丸数字が両方に振ってあれば番号で、無ければ記載順で突き合わせる。 */
    function pickBy(set, n, idx){
      if(!set.items.length) return '';
      if(byNum && set.numbered){
        for(var q=0;q<set.items.length;q++){ if(set.items[q].n===n) return set.items[q].v; }
        return '';
      }
      return set.items[idx] ? set.items[idx].v : '';
    }
    /* 最初に値の入っている要素を返す（空行保持により items[0] が空のことがある） */
    function firstV(set){
      for(var q=0;q<set.items.length;q++){ if(set.items[q].v) return set.items[q].v; }
      return '';
    }
    namesTotal+=nN; telsTotal+=nT;
    var fam=[];
    if(oneToMany){
      // 1人に複数連絡先。氏名の無い家族要素を作らず、全ての番号をその人にまとめる
      // ★items[0] が空行のことがあるので先頭の「値のある要素」を取る。電話も空要素を連結しない
      fam.push({name:firstV(nameSet), relation:rels[0]||'', role:'',
                address:addrSet.items.map(function(a){return a.v}).filter(String).join('\n'),
                phone:telSet.items.map(function(t){return t.v}).filter(String).join(' / '), emergency:false});
    }else{
      /* ★len は「行数」で回す。_countV（非空件数）で回すと、氏名欄に空行があるだけで
         末尾の家族がループに入らず丸ごと落ちる（目視では載ったレコードしか見えないので気づけない）。 */
      var len=byNum ? nameSet.items.length
                    : Math.max(nameSet.items.length, rels.length, telSet.items.length, addrSet.items.length);
      for(var i=0;i<len;i++){
        var it  = nameSet.items[i];
        var nm2 = it ? it.v : '';
        var num = it ? it.n : (i+1);
        var e={name:nm2, relation:rels[i]||'', role:'',
               address:pickBy(addrSet,num,i), phone:pickBy(telSet,num,i), emergency:false};
        if(e.name||e.phone||e.address){
          /* 氏名が空なのに電話・住所だけある＝シート側の行がずれている。
             値は捨てず保持するが、誰の連絡先か未特定なので必ず止めて確認させる。 */
          if(!e.name)
            _w('❌ 家族情報: 利用者No'+no+' 氏名が空の行に電話/住所が対応（行'+(i+1)+'・行位置ずれ）→氏名未特定のまま保持。元シート要確認');
          fam.push(e);
        }
      }
    }
    // 緊急連絡先: 氏名一致で emergency を立てる。一致しなければ別要素として足す（消さない）
    emgSet.items.forEach(function(item,i){
      var en=item.v; if(!en) return;
      var tel=emgTelOf(item, i);   // 丸数字があれば番号で、無ければ行位置で対応
      var hit=null;
      for(var j=0;j<fam.length;j++){ if(fam[j].name && _norm(fam[j].name)===_norm(en)){ hit=fam[j]; break; } }
      /* ★続柄の列が無く本文に埋まっている（例「長女○○」）ため完全一致では常に外れ、
         同一人物が家族と緊急連絡先で二重登録される。部分一致でも突合する。
         2字未満での部分一致は別人を掴む危険があるので行わない。 */
      if(!hit){
        var bn=_norm(en);
        for(var j2=0;j2<fam.length;j2++){
          var an=_norm(fam[j2].name);
          if(an && bn.length>=2 && an.length>=2 && (an.indexOf(bn)>=0 || bn.indexOf(an)>=0)){
            hit=fam[j2];
            _w('家族情報: 利用者No'+no+' 緊急連絡先を氏名の部分一致で家族に突合（続柄が本文に含まれるため）。要目視');
            break;
          }
        }
      }
      if(hit){
        hit.emergency=true;
        /* ★家族欄＝自宅、緊急連絡先欄＝携帯 のように両方に別の番号があると、
           従来は家族側が埋まっているため緊急側の番号を無警告で捨てていた。
           緊急時にかける番号なので消さず両方を残す（氏名の部分一致突合を入れて
           hit が成立しやすくなったぶん、この経路の発火率も上がっている）。 */
        if(tel){
          if(!hit.phone) hit.phone=tel;
          else if(_norm(hit.phone).indexOf(_norm(tel))<0){
            hit.phone = hit.phone+' / '+tel;
            _w('家族情報: 利用者No'+no+' 緊急連絡先の電話が家族欄の番号と異なるため両方を保持（自宅／携帯等）。要目視');
          }
        }
      }
      else fam.push({name:en,relation:'',role:'緊急連絡先',address:'',phone:tel,emergency:true});
    });
    if(fam.length){
      if(seenF[no]){ rec.family=(rec.family||[]).concat(fam); _w('家族情報: 利用者No'+no+' に複数行あり→統合しました'); }
      else { rec.family=fam; n++; }
      seenF[no]=true;
    }
    else if(g('family')) _w('家族情報: 利用者No'+no+' の家族欄を分解できず（原文長'+g('family').length+'字）');
  }
  /* ★1行ごとの判定は「氏名も電話もある」場合しか働かない。
     電話列が実在する別の列にマッピングされ、その列が全行空だと、
     どの警告にも掛からず「✅ 家族情報を反映: 133名」で通ってしまう。
     全体の充足を集計して、電話がゼロなら止める。 */
  if(namesTotal===0)
    _w('❌ 家族情報: 家族氏名が1件も取得できませんでした→col.family='+col.family+' / col.no='+col.no+' を要確認');
  if(namesTotal>0 && telsTotal===0)
    _w('❌ 家族情報: 家族氏名'+namesTotal+'件に対し電話が1件も取得できませんでした→列マッピング(col.phone='+col.phone+')を要確認');
  Logger.log('■ 家族情報を反映: '+n+'名（走査'+scanned+'行 / スキップ'+skipped+'行 / 氏名'+namesTotal+'件・電話'+telsTotal+'件）');
}

/* ═══════════ 薬情報タブ ═══════════ */
function _mergeMeds(sh, byNo){
  var H=_headers(sh); if(!H){ _w('薬情報: ヘッダー行が特定できません'); return; }
  var col=_mapCols(H.combined, LABELS_MEDS);
  var miss=Object.keys(col).filter(function(k){return col[k]<0});
  Logger.log('■ 薬情報タブ: '+_tabLabel(sh.getName())+
    ' / 見出し行'+(H.gRow+1)+' サブ'+(H.sRow<0?'なし':(H.sRow+1))+' データ開始'+(H.dRow+1)+
    ' / マッピング '+JSON.stringify(col)+(miss.length?('  ⚠️未検出: '+miss.join(',')):''));
  _logJoin('■ 薬情報タブ 見出し一覧 全'+H.combined.length+'列:', _headDump(H.combined), 12);
  /* ★「内服(定期薬)」が2列結合でサブ見出しが空だと _mapCols は2列目を拾えず、
     列の中身が丸ごと捨てられる（2026-07-19 の実データで列3・列4が該当）。
     ただし2列目が「効能」なのか「薬が多くて溢れた継続列」なのかは見出しから判別できない。
     ★効能と決めつけて結合すると、継続列だった場合に「薬剤名（別の薬剤名）」が
       効能表示としてフェイスシートに出る（臨床安全上の事故）。しかもログに中身を
       出さない設計のため、推定が当たったかを検証する手段が無い。
     したがって推定はせず、原文をラベル付きで薬備考へ退避する
     ＝データは消さないが、誤った関連付けも作らない。
     実物を確認したら LABELS_MEDS に実際の見出しを追記して、この退避を解消すること。 */
  var extraCol=-1;
  if(col.effect<0 && col.medsRegular>=0){
    var gm=String(H.combined[col.medsRegular]||'').split('/')[0];
    var nx=col.medsRegular+1;
    if(nx<H.combined.length && String(H.combined[nx]||'').split('/')[0]===gm){
      extraCol=nx;
      col.extraMeds=nx;   // _logUnused で「未使用」と誤表示しないよう使用済みに数える
      /* ★列4の正体は未確認。管理者の回答は列3のセル書式（薬剤名・用量・用法を1セルに記載）
         についてであり、列4が「薬剤の続き」か「効能」か「中止」か「備考」かは答えていない。
         薬剤リストへ無ラベルで連結すると、中止薬や注記が定期薬の1行として
         フェイスシートに出て、書込後は出自を判別できなくなる（不可逆）。
         薬備考へラベル付きで退避すれば、正体が判明した時点で再実行して移せる（可逆）。
         安全側＝退避を採る。 */
      Logger.log('⚠️ 列'+nx+'（「'+_headLabel(H.combined[nx])+'」グループの2列目）は用途未確認のため、'+
                 '薬剤リストに混ぜず薬備考へラベル付きで退避します。中身を確認して LABELS_MEDS を修正してください');
    }
  }
  _logUnused(H.combined, col, '薬情報タブ');
  var v=sh.getDataRange().getValues(), n=0, seenM={}, scanned=0, skipped=0;
  for(var r=H.dRow;r<v.length;r++){
    var noRaw=_s(v[r][col.no]);
    var no=_int(noRaw);
    if(no===''){ if(noRaw){ skipped++; _w('❌ 薬情報: 利用者No列が数値でない行あり（行'+(r+1)+'・原文長'+noRaw.length+'字）→スキップ'); } continue; }
    scanned++;
    var rec=byNo[no];
    if(!rec){
      skipped++;
      if(ACK_NO_MAIN.indexOf(no)>=0) _w('薬情報: 利用者No'+no+' は未入居のため主タブに無い（確認済み）→スキップ');
      else _w('❌ 薬情報: 利用者No'+no+' が主タブに無い（行'+(r+1)+'）→この薬情報は取り込まれません');
      continue;
    }
    /* ★同一利用者の2行目以降は「上書き」ではなく「追記」にする。
       上書きだと1行目の薬剤リストが黙って消える（dev-principles #4 データを消さない）。
       家族情報タブ側が concat で統合しているのに、より安全性の高い薬情報が
       上書きなのは設計の不整合だった。 */
    var dupRow = !!seenM[no];
    if(dupRow) _w('❌ 薬情報: 利用者No'+no+' に複数行あり（行'+(r+1)+'・'+(seenM[no]+1)+'行目）→追記で統合しました。要目視');
    function g(k){ var i=col[k]; return (i==null||i<0)?'':_s(v[r][i]); }
    /* 定期薬と効能は「同じ行位置」で対応している。
       ★空行を除去してから対応させると行がずれ、別の薬に別の効能が貼り付く（臨床安全上の事故）。
         そこで空行を保持したまま行数が完全一致する場合のみ結合し、
         一致しない場合は結合せず効能を薬備考へ退避して警告する。 */
    var medsR=_linesRaw(g('medsRegular')), effR=_linesRaw(g('effect'));
    var meds=medsR.filter(String);
    // 2行目以降は既存の内容を残したまま後ろに足す（消さない）
    var keep = dupRow && rec.medsRegular ? (rec.medsRegular+'\n') : '';
    if(meds.length){
      var effFilled=effR.filter(String);
      if(effFilled.length && effR.length===medsR.length){
        rec.medsRegular = keep + medsR.map(function(m,i){ return m ? (effR[i]? (m+'（'+effR[i]+'）') : m) : ''; })
                               .filter(String).join('\n');
      }else{
        rec.medsRegular = keep + meds.join('\n');
        if(effFilled.length){
          rec.medsNotes = (rec.medsNotes? rec.medsNotes+'\n':'') + '【効能（薬剤との対応は要確認）】\n' + effFilled.join('\n');
          _w('❌ 利用者No'+no+': 薬剤'+medsR.length+'行/効能'+effR.length+'行が不一致→効能は結合せず薬備考へ退避。要目視');
        }
      }
    }
    // 用途未確認の隣接列はラベル付きで薬備考へ退避（結合せず、捨てもしない）
    if(extraCol>=0){
      var ex=_s(v[r][extraCol]);
      if(ex){
        rec.medsNotes = (rec.medsNotes? rec.medsNotes+'\n':'') +
          '【'+MEDS_EXTRA_TAG+'・分類未確認（定期薬の続き／効能／中止のいずれか要確認）】\n' + ex;
        _w('利用者No'+no+': 内服(定期薬)の2列目を分類未確認のまま薬備考へ退避。要目視');
      }
    }
    // 頓服・過去臨時薬も複数行なら追記（上書きで消さない）
    if(g('medsPrn')) rec.medsPrn = (dupRow && rec.medsPrn ? rec.medsPrn+'\n' : '') + g('medsPrn');
    var past=_splitLog(g('medsPast'));
    if(past.length) rec.medsPastLog = (dupRow && rec.medsPastLog && rec.medsPastLog.length) ? rec.medsPastLog.concat(past) : past;
    // 急変時の医療機関・連絡先（主タブの救急搬送先より入力率が高い。空で上書きしない）
    if(g('emergencyHospital')){
      if(rec.emergencyHospital && _norm(rec.emergencyHospital)!==_norm(g('emergencyHospital')))
        _w('利用者No'+no+': 救急搬送先が主タブと薬情報タブで不一致→薬情報タブを採用。要目視');
      rec.emergencyHospital=g('emergencyHospital');
    }
    if(g('emergencyTel')) rec.emergencyHospitalTel=g('emergencyTel');
    if(!dupRow) n++;                       // 「名」は実人数。行数で数えると主タブ人数を超えて誤読を招く
    seenM[no]=(seenM[no]||0)+1;
  }
  Logger.log('■ 薬情報を反映: '+n+'名（走査'+scanned+'行 / スキップ'+skipped+'行）');
}

/* ═══════════ 見出し解析（2行構成・結合セル対応） ═══════════ */

/* その行が「見出し」ではなく「データ」に見えるか。
   見出し語は短く、電話番号・用量・日付を含まない。閾値24字は主タブの最長見出し
   （認知症高齢者の日常生活自立度＝14字）に十分な余裕を取った値。 */
function _looksLikeData(row){
  for(var i=0;i<row.length;i++){
    var c=String(row[i]==null?'':row[i]).trim();
    if(!c) continue;
    if(c.length>24) return true;
    if(/\d{2,4}-\d{2,4}-\d{3,4}/.test(c)) return true;                    // 電話番号
    if(/\d+\s*(mg|ml|µg|mcg|錠|包|カプセル)/i.test(c)) return true;        // 薬剤の用量
    if(/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(c)) return true;         // 日付
  }
  return false;
}
function _headers(sh){
  var v=sh.getDataRange().getValues();
  var gRow=-1, idc=-1;
  for(var i=0;i<Math.min(v.length,40);i++){
    var row=v[i].map(_normHead);
    var j=row.indexOf('利用者No');
    if(j>=0){ gRow=i; idc=j; break; }
  }
  if(gRow<0) return null;
  /* 次の行が「サブ見出し行」かデータ行かを判定（利用者No列が数値ならデータ行）。
     ★これだけでは弱い。1行見出しのシートで先頭データ行の利用者Noが空・全角・「12番」等だと
       実データ行をサブ見出しに誤採用し、(a) 先頭1名が取り込まれない
       (b) 氏名・電話・薬剤名が「見出し」としてCloud Loggingに残る。
       データらしい特徴を持つ行はサブ見出しとみなさない（未知は見出しでない側に倒す）。 */
  var sRow=-1, dRow=gRow+1;
  if(v[gRow+1] && _int(_s(v[gRow+1][idc]))===''){
    if(_looksLikeData(v[gRow+1])){
      _w('❌ '+_tabLabel(sh.getName())+': 見出しの次行がデータに見えるためサブ見出し行として扱いません（行'+(gRow+2)+'）。1行見出しのシートならこれが正常です');
    }else{ sRow=gRow+1; dRow=gRow+2; }
  }
  // グループ見出しは横方向に結合されており先頭セルにしか値が無い → 前方補完する
  var g=_fill(v[gRow].map(_normHead));
  var s=(sRow>=0)? v[sRow].map(_normHead) : [];
  var combined=g.map(function(x,i){
    var sub=s[i]||'';
    if(EXCLUDE_LABELS.indexOf(x)>=0 || EXCLUDE_LABELS.indexOf(sub)>=0) return '__EXCLUDE__';
    return sub ? (x+'/'+sub) : x;
  });
  return {gRow:gRow,sRow:sRow,dRow:dRow,combined:combined};
}
function _fill(a){ var last=''; return a.map(function(x){ if(x){last=x; return x;} return last; }); }
function _normHead(h){ return String(h==null?'':h).replace(/\s+/g,'').replace(/[（）]/g,function(c){return c==='（'?'(':')'}); }
function _mapCols(comb, labels){
  var out={};
  Object.keys(labels).forEach(function(key){
    var cands=labels[key], idx=-1;
    for(var c=0;c<cands.length && idx<0;c++){
      var want=_normHead(cands[c]);
      for(var i=0;i<comb.length;i++){ if(comb[i]===want){ idx=i; break; } }
      // 完全一致で無ければ「グループ名のみ一致」（サブ見出し無しの結合列）も許容
      if(idx<0) for(var i2=0;i2<comb.length;i2++){ if(comb[i2].split('/')[0]===want){ idx=i2; break; } }
    }
    out[key]=idx;
  });
  return out;
}
function _findSheetBy(ss, mustHave, maxRows){
  var sheets=ss.getSheets();
  for(var i=0;i<sheets.length;i++){
    var v=sheets[i].getDataRange().getValues();
    for(var r=0;r<Math.min(v.length,maxRows);r++){
      var row=v[r].map(_normHead).join('');
      var ok=mustHave.every(function(m){ return row.indexOf(_normHead(m))>=0; });
      if(ok) return sheets[i];
    }
  }
  return null;
}

/* ═══════════ 値の正規化（消さない側に倒す） ═══════════ */
function _careLevel(v){
  var s=_s(v); if(!s) return {value:'',warn:false,raw:s};
  s=s.replace(/[０-９]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0xFEE0)});
  if(/^要支援\s*([12])$/.test(s)) return {value:'要支援'+RegExp.$1,warn:false,raw:s};
  if(/^要介護\s*([1-5])$/.test(s)) return {value:'要介護'+RegExp.$1,warn:false,raw:s};
  if(/^支援\s*([12])$/.test(s))   return {value:'要支援'+RegExp.$1,warn:false,raw:s};
  /* 素の数字は本来 要介護/要支援 の区別がセルから判断できないが、
     この施設は要介護のみ（要支援は別アプリ管理）と確認済みのため警告なしで確定する。
     他施設へ展開する場合は BARE_NUMBER_CARE_LEVEL を '' に戻すこと。 */
  if(/^([1-5])$/.test(s))          return {value:(BARE_NUMBER_CARE_LEVEL||'要介護')+RegExp.$1,
                                            warn:!BARE_NUMBER_CARE_LEVEL, raw:s};
  if(/自立/.test(s))               return {value:'自立',warn:false,raw:s};
  return {value:s, warn:true, raw:s};              // 変換不能でも原文を保持
}
/* ★「R3.8.1から2割」のような日付併記から先頭の3を拾ってしまう事故を防ぐため、
   「N割」表記 → 単独の数字 の順で判定し、それ以外は原文保持＋警告にする。 */
function _copay(v){
  var s=_s(v); if(!s) return {rate:'',welfare:false,warn:false,raw:s};
  if(/生保|生活保護/.test(s)) return {rate:'',welfare:true,warn:false,raw:s};
  var h=_han(s);
  var m=h.match(/([1-3])\s*割/);
  if(m) return {rate:m[1],welfare:false,warn:false,raw:s};
  if(/^[1-3]$/.test(h.trim())) return {rate:h.trim(),welfare:false,warn:false,raw:s};
  return {rate:s,welfare:false,warn:true,raw:s};   // 変換不能でも原文を保持
}
function _han(s){ return String(s==null?'':s).replace(/[０-９]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0xFEE0)}); }
/* ★丸数字の採番を「番号ごと」に分解する。
   添字で突き合わせると、氏名①②③に対し電話が①③しか無い場合、
   電話③が②の人に紐づく（緊急時にかける番号が別人になる）。
   番号が振ってあるなら番号で突き合わせれば、順序の入れ替わりも欠番も構造的に排除できる。
   戻り値: {numbered:採番されているか, items:[{n:番号, v:値}]} */
var CIRCLED_NUM = '①②③④⑤⑥⑦⑧⑨⑩';
function _splitNum(v){
  /* ★_s() は trim するため先頭の空行が消え、行位置対応が壊れる。
     ここでは生の文字列を受け取り、先頭の空行を保持したまま扱う。 */
  if(v==null) return {numbered:false, items:[]};
  var s=String(v);
  if(/^#(REF|ERROR|N\/A|VALUE|DIV|NAME|NUM)/.test(s.trim())) return {numbered:false, items:[]};
  if(!s.trim()) return {numbered:false, items:[]};
  if(new RegExp('['+CIRCLED_NUM+']').test(s)){
    var out=[], re=new RegExp('(['+CIRCLED_NUM+'])([^'+CIRCLED_NUM+']*)','g'), m;
    while((m=re.exec(s))!==null){
      var t=String(m[2]).replace(/^[\s:：]+/,'').trim();
      if(t) out.push({n:CIRCLED_NUM.indexOf(m[1])+1, v:t});
    }
    return {numbered:true, items:out};
  }
  /* ★丸数字が無い場合は改行で分ける。このとき空行を潰してはいけない。
     「氏名: 長女A / 長男B」に対し「電話: (空行) / 080-…」というシートで空行を落とすと、
     長男Bの番号が長女Aに付く（緊急時にかける番号が別人になる）。
     行位置を保つため空行を残す（末尾の空行だけ落とす）。 */
  var arr=String(s).split(/\r?\n/).map(function(x){ return x.trim(); });
  while(arr.length && !arr[arr.length-1]) arr.pop();
  return {numbered:false, items:arr.map(function(x,i){ return {n:i+1, v:x}; })};
}
/* 値の入っている件数（空行は数えない） */
function _countV(set){
  var n=0; for(var i=0;i<set.items.length;i++){ if(set.items[i].v) n++; }
  return n;
}
/* 丸数字①②③／改行／読点で複数値を分解 */
function _splitMulti(v){
  var s=_s(v); if(!s) return [];
  if(/[①②③④⑤⑥⑦⑧⑨⑩]/.test(s)){
    return s.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).map(function(x){return x.trim()}).filter(function(x){return x});
  }
  return s.split(/[\r\n]+/).map(function(x){return x.trim()}).filter(function(x){return x});
}
function _lines(v){ var s=_s(v); return s? s.split(/[\r\n]+/).map(function(x){return x.trim()}).filter(function(x){return x}) : []; }
/* 空行を保持したまま行に分ける（行位置で対応関係を持つ列の突合に使う） */
function _linesRaw(v){ var s=_s(v); return s? String(s).split(/\r?\n/).map(function(x){return x.trim()}) : []; }
/* 和暦/西暦の日付で始まる追記ログを {date,text} の配列へ分解。日付が無ければ1件にまとめる */
function _splitLog(v, src){
  var s=_s(v); if(!s) return [];
  var lines=_lines(s), out=[], cur=null;
  var re=/^(令和|平成|昭和|R|H|S)?\s*(\d{1,4})[.\-\/年]\s*(\d{1,2})[.\-\/月]\s*(\d{1,2})日?/;
  lines.forEach(function(ln){
    var m=_han(ln).match(re);
    if(m){
      var iso=_wareki(m[1],m[2],m[3],m[4]);
      if(cur) out.push(cur);
      // ★ISO化できない日付は本文から削らない（削ると原文が復元できなくなる）
      cur = iso ? {date:iso, text:ln.replace(re,'').replace(/^[\s:：]+/,'')}
                : {date:'', text:ln};
      // 列62「支援経過/旧CM」等、記録者の別を残す（実地指導・監査で意味を持つ）
      if(src) cur.src=src;
      /* ★本文は出さない。支援経過は要配慮個人情報で、実行ログはCloud Loggingに残る。
         日付部分だけ（元号記号・年月日）を出せば原因特定には足りる。 */
      if(!iso) _w('経過ログの日付を確定できず原文のまま保持（日付部分="'+String(m[0]).slice(0,12)+'"）');
    }else if(cur){ cur.text += (cur.text?'\n':'')+ln; }
    else{ cur={date:'',text:ln}; if(src) cur.src=src; }
  });
  if(cur) out.push(cur);
  return out.filter(function(x){ return x.date||x.text; });
}
/* 和暦→西暦。★元号記号の無い2桁は「令和の範囲内なら令和」とみなし、
   範囲外（例 30.5.1＝平成30年）は**推測せずISO化を諦める**（原文を残す側に倒す）。
   以前は一律 2018+y としていたため 平成30年→2048年 のような未来日を作っていた。 */
function _wareki(era,y,m,d){
  y=parseInt(y,10); m=parseInt(m,10); d=parseInt(d,10);
  if(isNaN(y)||isNaN(m)||isNaN(d)) return '';
  if(m<1||m>12||d<1||d>31) return '';
  var base={'令和':2018,'R':2018,'平成':1988,'H':1988,'昭和':1925,'S':1925};
  if(era && base[era]!=null){ y = base[era]+y; }
  else if(y<100){
    var reiwaMax = new Date().getFullYear()-2018;   // 今が令和何年か
    if(y>=1 && y<=reiwaMax) y = 2018+y;
    else return '';                                  // 平成/昭和と区別できない → 諦める
  }
  if(y<1900||y>2200) return '';
  return y+'-'+('0'+m).slice(-2)+'-'+('0'+d).slice(-2);
}
function _norm(s){ return String(s==null?'':s).replace(/\s+/g,'').trim(); }
function _s(v){ if(v==null) return ''; if(v instanceof Date) return _date(v);
  var s=String(v).trim();
  if(/^#(REF|ERROR|N\/A|VALUE|DIV|NAME|NUM)/.test(s)){ _w('数式エラーセルを空として扱いました: "'+s+'"'); return ''; }
  return s; }
function _int(v){ var s=String(v==null?'':v).replace(/[０-９]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0xFEE0)}).trim();
  return /^\d+$/.test(s) ? parseInt(s,10) : ''; }
function _num(v){ var n=parseFloat(String(v).replace(/[^0-9.]/g,'')); return isNaN(n)?'':n; }
function _date(v){
  if(!v) return '';
  // ★TZはスクリプト設定に依存させない（設定違いで全件1日ずれるのを防ぐ）
  if(v instanceof Date){ return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd'); }
  var s=_han(String(v).trim());                    // 全角数字も受ける
  var m=s.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  // 月日の妥当性も見る。不正なISO（2026-13-45等）を作ると画面のdate入力が受け付けず空になり値が消える
  if(m){
    var mo=parseInt(m[2],10), dy=parseInt(m[3],10);
    if(mo>=1&&mo<=12&&dy>=1&&dy<=31) return m[1]+'-'+('0'+mo).slice(-2)+'-'+('0'+dy).slice(-2);
    return String(v).trim();
  }
  var w=s.match(/^(令和|平成|昭和|R|H|S)?\s*(\d{1,4})[.\-\/年]\s*(\d{1,2})[.\-\/月]\s*(\d{1,2})/);
  if(w){ var iso=_wareki(w[1],w[2],w[3],w[4]); if(iso) return iso; }
  return String(v).trim();                         // ISOにできなくても原文を残す（画面側がtextで表示する）
}
