/** ============================================================
 *  排便記録アプリ用 Apps Script（堅牢版 + Phase 2 B-2 差分同期対応）
 * ============================================================ */
const SS = SpreadsheetApp.getActiveSpreadsheet();

// schedule（入居者ごとの排泄予定時刻 ["09:00", ...]）は 2026-07-25 追加。
// それまで端末の localStorage にしか存在せず、自動ロックの消去で永久に失われる状態だった。
const RES_DEFAULT_HEADERS = ['id','name','yomi','room','gender','active','hidden','laxNote','cfg','schedule'];
const REC_DEFAULT_HEADERS = ['id','residentId','date','time','datetime','type',
  'urineAmt','urineColor','urineSrc','consistency','stoolAmt','stoolColor','stoolSrc',
  'medicine','tablets','notes','staff','createdAt','updatedAt'];
const CFG_DEFAULT_HEADERS = ['key','value'];

// Google Sheets のシリアル値の基準日 1899-12-30（UTC）。serial×86400000ms を加算し UTC 成分を読むと
// Session.getScriptTimeZone()/Utilities.formatDate を一切使わずに元の暦日・時刻を復元できる（TZ非依存）。
const SHEETS_EPOCH_MS = -2209161600000; // = Date.UTC(1899,11,30)
const RESIDENTS_CACHE_KEY = 'residents_v1';

/** ============ 認証（2026-07-18 追加） ============
 * スクリプトプロパティ HAIBEN_TOKEN に合言葉を設定すると、全リクエスト（doGet/doPost）で
 * トークン検証が有効になる。未設定の間は従来通り認証なしで動作する「猶予モード」。
 * → 新コードをデプロイ（挙動不変）→ 全端末でトークン入力 → 最後に HAIBEN_TOKEN を設定した
 *   瞬間から強制、という無停止移行ができる。※設定までは無認証のままなので移行は即日完了させる。
 * トークンの受け取り: GET は ?token=、POST は JSON ボディの token（master.gs と同方式）。 */
const TOKEN_PROP = 'HAIBEN_TOKEN';

function _token(e){
  var exp = PropertiesService.getScriptProperties().getProperty(TOKEN_PROP);
  if(!exp) return true; // 猶予モード: トークン未設定なら検証しない（従来互換）
  var got = (e && e.parameter && e.parameter.token) || '';
  if(!got && e && e.postData){
    try{ got = JSON.parse(e.postData.contents).token || ''; }catch(err){}
  }
  return got === exp;
}

/** 403 相当のレスポンス（GAS は HTTP ステータスを変えられないため JSON で表現） */
function authError_(){
  return json({ok:false, error:'認証エラー: 同期トークンが未設定または一致しません。設定画面で正しいトークンを入力してください。', code:403});
}

/** ============ 入居者マスタ名簿の取得（2026-07-22 / スプレッドシート直読み方式） ============
 * 入居者マスタのスプレッドシート 'master' タブを直接読む。
 * 当初は GAS 間の HTTP 通信（UrlFetchApp）で取得する設計にしたが、外部通信の権限
 * （script.external_request）の承認がどうしても通らなかったため方式を変更した。
 * 直読みなら既に承認済みの spreadsheets 権限だけで動くので、追加の承認作業が要らない。
 * 副次的に、マスタ側のトークン管理もマスタGASのデプロイ状態への依存もなくなる。
 *
 * スクリプトプロパティ MASTER_SHEET_ID（入居者マスタのスプレッドシートID）が設定された
 * 時だけ有効。未設定なら null を返し、呼び出し側は従来どおり動作する（既存挙動を保つ）。
 * 読み出すのは識別・表示用の安全項目のみ。dataJson（医療情報等）は列添字すら取らない。
 * 返す形は呼び出し側の契約（masterId/name/kana/room/gender/careLevel/active）を変えない。 */
const MASTER_ROSTER_CACHE_KEY = 'master_roster_v1';
const MASTER_SHEET_NAME = 'master';   // master.gs の MASTER_SHEET と同じ
const MASTER_SAFE_COLS = ['id','name','kana','room','gender','careLevel','active'];

function fetchMasterRoster_(){
  const sheetId = PropertiesService.getScriptProperties().getProperty('MASTER_SHEET_ID');
  if(!sheetId) return null;   // 連携未設定 ＝ 従来動作

  const cache = CacheService.getScriptCache();
  try{
    const hit = cache.get(MASTER_ROSTER_CACHE_KEY);
    if(hit) return JSON.parse(hit);
  }catch(e){}

  try{
    const sh = SpreadsheetApp.openById(sheetId).getSheetByName(MASTER_SHEET_NAME);
    if(!sh){ console.error('masterRoster: シート「' + MASTER_SHEET_NAME + '」が見つかりません'); return null; }
    const last = sh.getLastRow();
    if(last < 2) return [];   // ヘッダーのみ＝入居者ゼロ。連携は成立しているので [] を返す

    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(function(v){ return String(v).trim(); });
    // 安全項目の列位置だけを引く。dataJson・targetApps は添字を取らない＝読み出し対象にしない。
    const idx = {};
    MASTER_SAFE_COLS.forEach(function(k){ idx[k] = headers.indexOf(k); });
    if(idx.id < 0){ console.error('masterRoster: id列が見つかりません（ヘッダー: ' + headers.join(',') + '）'); return null; }

    const rows = sh.getRange(2,1,last-1,lastCol).getValues();
    const pick = function(r,k){ return idx[k]>=0 ? String(r[idx[k]]==null?'':r[idx[k]]).trim() : ''; };
    const roster = [];
    for(let i=0;i<rows.length;i++){
      const r = rows[i];
      if(r[idx.id]==='' || r[idx.id]==null) continue;
      // 在籍判定は master.gs の _truthy と同じ規則（false/'false'/'退去'/空 を除外）
      const act = idx.active>=0 ? r[idx.active] : true;
      if(act===false || act==='false' || act==='退去' || act==='') continue;
      roster.push({
        masterId : String(r[idx.id]),
        name     : pick(r,'name'),
        kana     : pick(r,'kana'),
        room     : pick(r,'room'),
        gender   : pick(r,'gender'),
        careLevel: pick(r,'careLevel'),
        active   : true
      });
    }
    try{
      const s = JSON.stringify(roster);
      if(s.length <= 90000) cache.put(MASTER_ROSTER_CACHE_KEY, s, 600); // 100KB上限の防御・TTL 10分
    }catch(e){}
    return roster;
  }catch(err){
    // 権限不足・ID誤り・マスタ側の障害いずれでも、記録の同期は止めない（安全側フォールバック）
    console.error('masterRoster read error: ' + err);
    return null;
  }
}

/** 診断用: マスタ連携の設定をエディタから点検する。デプロイ不要・氏名は出力しない。
 *  Apps Script エディタの関数プルダウンで checkMasterLink を選び「実行」を押す。
 *  ウェブアプリからは到達できない（doGet/doPost の分岐に無い）ため、公開面は増えない。 */
function checkMasterLink(){
  const id = PropertiesService.getScriptProperties().getProperty('MASTER_SHEET_ID');
  console.log('--- 1. 設定の確認 ---');
  console.log('MASTER_SHEET_ID: ' + (id ? '設定あり（末尾8文字: ' + id.slice(-8) + '）' : '★未設定★'));
  if(!id){ console.log('→ スクリプトプロパティ MASTER_SHEET_ID が未設定です。'); return; }

  console.log('--- 2. スプレッドシートを開く ---');
  let ss;
  try{ ss = SpreadsheetApp.openById(id); }
  catch(err){
    console.log('→ 開けません: ' + err);
    console.log('   IDが違うか、このアカウントに閲覧権限がありません。');
    return;
  }
  console.log('スプレッドシート名: ' + ss.getName());
  const sh = ss.getSheetByName(MASTER_SHEET_NAME);
  if(!sh){
    console.log('→ シート「' + MASTER_SHEET_NAME + '」がありません。');
    console.log('   このファイルのタブ一覧: ' + ss.getSheets().map(function(s){ return s.getName(); }).join(', '));
    return;
  }

  console.log('--- 3. 名簿の読み取り ---');
  try{ CacheService.getScriptCache().remove(MASTER_ROSTER_CACHE_KEY); }catch(e){}  // 診断は必ず実データを見る
  const roster = fetchMasterRoster_();
  if(roster === null){ console.log('→ 読み取りに失敗しました。上に出ているエラーログを確認してください。'); return; }
  console.log('★★★ 成功 ★★★');
  console.log('在籍者: ' + roster.length + '件'
    + ' / 居室あり: ' + roster.filter(function(r){ return r.room; }).length + '件'
    + ' / かなあり: ' + roster.filter(function(r){ return r.kana; }).length + '件');
  console.log('※氏名は表示していません');
}

/** ============ doGet（差分同期対応） ============ */
function doGet(e){
  // 認証: HAIBEN_TOKEN 設定時は全 GET を検証（要配慮個人情報の読取保護）
  if(!_token(e)) return authError_();
  // エディタの「実行」ボタンで直接呼ばれた場合の保護
  const params = (e && e.parameter) || {};
  // 入居者マスタ名簿の代理取得。既存の getAll 経路とは独立した別アクションにすることで、
  // マスタ側の遅延・障害が記録同期のホットパスに一切影響しないようにする。
  if(params.action === 'masterRoster'){
    const mr = fetchMasterRoster_();
    return json({ok:true, roster: mr || [], available: mr !== null});
  }
  try{
    // Phase 2 B-2: ?since= があれば updatedAt で差分フィルタ
    const since = parseInt(params.since, 10) || 0;
    // Records は Advanced Service でバルク高速読込（per-cell formatDate を排除）。失敗時は readSheet_ へフォールバック。
    let records = readRecords_();
    let delta = false;

    if(since > 0 && records.length > 0){
      const filtered = records.filter(function(r){
        const ts = parseTs_(r.updatedAt) || parseTs_(r.tsUTC) || parseTs_(r.createdAt);
        if(!ts) return true; // タイムスタンプが取れない古いデータは念のため返す
        return ts >= since;
      });
      if(filtered.length < records.length){
        records = filtered;
        delta = true;
      }
    }

    // 日付を JST の 'yyyy-MM-dd' へ正規化（2026-06-15 修正）。
    // Sheets の date セルは Date シリアル(JST深夜=前日15:00Z)で読み出されるため、
    // 値が ISO/Date/文字列いずれでも +9h して UTC 成分を読み、日付境界の-1日ズレを確実に防ぐ。
    // ※normalizeCell_ の整形に依存せず doGet 出口で一括正規化する（端末間の日付不一致の恒久対策）。
    records.forEach(function(r){
      if(r && r.date){
        var _d = new Date(r.date);
        if(!isNaN(_d.getTime())){
          var _j = new Date(_d.getTime() + 32400000); // +9h = JST
          r.date = _j.getUTCFullYear()+'-'+('0'+(_j.getUTCMonth()+1)).slice(-2)+'-'+('0'+_j.getUTCDate()).slice(-2);
        }
      }
    });

    return json({ok:true,
      residents: readResidentsCached_(),
      records:   records,
      cfg:       readConfig_(),
      delta:     delta,
      serverTime: new Date().getTime()
    });
  }catch(err){
    console.error('doGet error:', err);
    return json({ok:false, error:String(err)});
  }
}

/** ============ doPost（既存通り。upsertRow_ が updatedAt を自動設定済み） ============ */
function doPost(e){
  // 認証: HAIBEN_TOKEN 設定時は全 POST を検証（改竄・削除の防止）。ロック取得前に弾く。
  if(!_token(e)) return authError_();
  // 複数端末の同時POSTによる読み-書き競合（lost update・行重複・Configヘッダ破壊）を防ぐため
  // スクリプトロックで書き込みを直列化する。既存の switch / レスポンス形状は不変（外側で包むだけ）。
  var lock = LockService.getScriptLock();
  try{
    lock.waitLock(20000); // 取得できなければ throw → catch で ok:false（クライアントはキュー退避・再送）
    if(!e || !e.postData) return json({ok:false, error:'no postData'});
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    // 個人情報保護：body（氏名・排泄記録内容）はログに出力しない。action のみ記録する。
    console.log('doPost action=', action);
    switch(action){
      case 'addRecord':  upsertRow_('Records',   REC_DEFAULT_HEADERS, body.record);  return json({ok:true});
      case 'saveRecord': upsertRow_('Records',   REC_DEFAULT_HEADERS, body.record);  return json({ok:true});
      case 'delRecord':  deleteRow_('Records',   body.id);                            return json({ok:true});
      case 'saveRes':    upsertRow_('Residents', RES_DEFAULT_HEADERS, body.resident, true); invalidateResidentsCache_(); return json({ok:true});
      case 'delRes':     deleteRow_('Residents', body.id);                            invalidateResidentsCache_(); return json({ok:true});
      case 'saveCfg':    writeConfig_(body.cfg);                                      return json({ok:true});
      default: return json({ok:false, error:'unknown action: '+action});
    }
  }catch(err){
    console.error('doPost error:', err);
    return json({ok:false, error:String(err)});
  }finally{
    try{ lock.releaseLock(); }catch(_){}
  }
}

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** ============ Phase 2 B-2 ヘルパ：ISO/数値/文字列の updatedAt を ms に変換 ============ */
function parseTs_(v){
  if(v==null || v==='') return 0;
  if(typeof v === 'number') return v > 0 ? v : 0;
  if(v instanceof Date){
    const t = v.getTime();
    return isNaN(t) ? 0 : t;
  }
  if(typeof v === 'string'){
    // ISO 8601 文字列（2026-05-19T10:00:00.000Z）
    if(/^\d{4}-\d{2}-\d{2}T/.test(v)){
      const t = new Date(v).getTime();
      return isNaN(t) ? 0 : t;
    }
    // 数値文字列（"1700000000000"）
    const n = parseInt(v, 10);
    if(!isNaN(n) && n > 1000000000000) return n; // 2001年以降の妥当な timestamp のみ
  }
  return 0;
}

function getOrCreateSheet_(name, defaultHeaders){
  let sh = SS.getSheetByName(name);
  if(!sh){
    sh = SS.insertSheet(name);
    sh.getRange(1,1,1,defaultHeaders.length).setValues([defaultHeaders]);
    return sh;
  }
  const lastCol = Math.max(1, sh.getLastColumn());
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0];
  if(headers.every(h => h===''||h==null)){
    sh.getRange(1,1,1,defaultHeaders.length).setValues([defaultHeaders]);
  }
  return sh;
}

/** 既存シートに不足している既定列を「末尾に追加するだけ」行う（2026-07-25 追加）。
 * getOrCreateSheet_ は既存シートのヘッダーを一切触らないため、RES_DEFAULT_HEADERS に
 * 列を足しても既存スプレッドシートには反映されず、upsertRow_ が値を黙って捨てていた。
 * ★ 追加のみ。既存列の削除・並べ替え・改名は行わない（利用者が足した独自列も壊さない）。
 * ★ 書き込みが発生するのは不足列がある初回だけ。以降は no-op。
 * 読み取り経路（doGet）からは呼ばず upsertRow_ からのみ呼ぶ（GETで書き込みを起こさないため）。 */
function ensureHeaders_(sh, defaultHeaders){
  if(!sh || !defaultHeaders || !defaultHeaders.length) return;
  const lastCol = Math.max(1, sh.getLastColumn());
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(v=>String(v).trim());
  const lower = headers.map(h=>h.toLowerCase());
  const missing = defaultHeaders.filter(h => lower.indexOf(String(h).toLowerCase()) < 0);
  if(!missing.length) return;
  sh.getRange(1, lastCol+1, 1, missing.length).setValues([missing]);
}

function readSheet_(name, defaultHeaders){
  const sh = getOrCreateSheet_(name, defaultHeaders);
  const last = sh.getLastRow();
  if(last < 2) return [];
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(v=>String(v).trim());
  const rows = sh.getRange(2,1,last-1,lastCol).getValues();
  return rows.map(row => {
    const o = {};
    headers.forEach((h,i)=>{ if(h) o[h]=normalizeCell_(h,row[i]); });
    return o;
  }).filter(o => o.id!=null && o.id!=='');
}

/** ============ Records 高速読込（Sheets Advanced Service・per-cell formatDate 排除） ============
 * doGet のホットパス。UNFORMATTED_VALUE + SERIAL_NUMBER で取得し、日付/時刻セルは
 * cellFromSerial_ の TZ非依存算術で復元する。例外/クォータ(429)時は従来 readSheet_ にフォールバック。 */
function readRecords_(){
  try{
    return readRecordsFast_();
  }catch(err){
    console.warn('readRecordsFast_ フォールバック（readSheet_使用）:', String(err));
    return readSheet_('Records', REC_DEFAULT_HEADERS);
  }
}

function readRecordsFast_(){
  getOrCreateSheet_('Records', REC_DEFAULT_HEADERS); // シート存在・ヘッダを保証（構造保証は従来どおり）
  const res = Sheets.Spreadsheets.Values.get(SS.getId(), 'Records', {
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const values = res.values;
  if(!values || values.length < 2) return [];
  const headers = values[0].map(v => String(v).trim());
  const out = [];
  for(let r = 1; r < values.length; r++){
    const row = values[r]; // API は行末の空セルを省略しうる → row[i] が undefined になり得る
    const o = {};
    for(let i = 0; i < headers.length; i++){
      const h = headers[i];
      if(h) o[h] = cellFromSerial_(h, row[i]);
    }
    if(o.id != null && o.id !== '') out.push(o);
  }
  return out;
}

// UTC 成分から 'yyyy-MM-dd' を組む
function _ymdUTC_(ms){
  const d = new Date(ms);
  return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2);
}

/** SERIAL_NUMBER 取得値をセル種別に応じて正規化（normalizeCell_ の Utilities.formatDate 版と同一の暦日/時刻を返す）。
 * date は整数部＝日、datetime/time は小数部＝時刻。丸めは分単位（Math.round）で 10:00→9:59 の浮動小数バグを回避。 */
function cellFromSerial_(header, v){
  if(v == null || v === ''){
    if(header === 'active') return true;   // 空は既定 true（normalizeCell_ と一致）
    if(header === 'hidden') return false;
    return '';
  }
  if(header === 'date'){
    if(typeof v === 'number'){
      if(v < 1) return '';                 // serial<1（1899-12-30/時刻のみ）＝日付なし
      return _ymdUTC_(SHEETS_EPOCH_MS + Math.floor(v) * 86400000);
    }
    return v;                              // 文字列で入っているケースはそのまま（doGet 出口で正規化）
  }
  if(header === 'datetime'){
    if(typeof v === 'number'){
      if(v < 1) return '';                 // 日付なし
      const totalMin = Math.round(v * 1440);
      const days = Math.floor(totalMin / 1440);
      const minInDay = totalMin - days * 1440;
      const hh = Math.floor(minInDay / 60), mm = minInDay % 60;
      return _ymdUTC_(SHEETS_EPOCH_MS + days * 86400000)
        + 'T' + ('0'+hh).slice(-2) + ':' + ('0'+mm).slice(-2);
    }
    return v;
  }
  if(header === 'time'){
    if(typeof v === 'number'){
      const frac = v - Math.floor(v);
      let mins = Math.round(frac * 1440);
      if(mins >= 1440) mins = 0;
      const h2 = Math.floor(mins / 60), m2 = mins % 60;
      return ('0'+h2).slice(-2) + ':' + ('0'+m2).slice(-2);
    }
    return v;
  }
  if(header === 'createdAt' || header === 'updatedAt' || header === 'tsUTC'){
    // ISO 文字列保存が通常だが、Date 型で入っていた場合の吸収（normalizeCell_ の toISOString 相当）。
    if(typeof v === 'number' && v > 0) return new Date(SHEETS_EPOCH_MS + v * 86400000).toISOString();
    return v;
  }
  if(header === 'cfg'){
    if(typeof v === 'string' && v.trim().charAt(0) === '{'){
      try{ return JSON.parse(v); }catch(e){ return {}; }
    }
    return v;
  }
  if(header === 'active'){
    if(typeof v === 'boolean') return v;
    const sa = String(v).toUpperCase();
    return !(sa === 'FALSE' || sa === '0' || sa === 'NO');
  }
  if(header === 'hidden'){
    if(typeof v === 'boolean') return v;
    const sb = String(v).toUpperCase();
    return (sb === 'TRUE' || sb === '1' || sb === 'YES');
  }
  return v;
}

/** ============ Residents キャッシュ（変更頻度が低いため doGet 毎の全行読込を除去） ============ */
function readResidentsCached_(){
  const cache = CacheService.getScriptCache();
  let hit = null;
  try{ hit = cache.get(RESIDENTS_CACHE_KEY); }catch(e){}
  if(hit){
    try{ return JSON.parse(hit); }catch(e){}
  }
  const residents = readSheet_('Residents', RES_DEFAULT_HEADERS);
  try{
    const s = JSON.stringify(residents);
    if(s.length <= 90000) cache.put(RESIDENTS_CACHE_KEY, s, 300); // 100KB上限の将来防御・TTL 300秒
  }catch(e){}
  return residents;
}

function invalidateResidentsCache_(){
  try{ CacheService.getScriptCache().remove(RESIDENTS_CACHE_KEY); }catch(e){}
}

/* ensureCols=true のときだけ不足している既定列を追加する（2026-07-25）。
   Residents（schedule 列の追加が必要）でのみ true を渡す。Records は列数が多く、
   万一シートのヘッダーが既定と異なっていると大量の列を足してしまうため既定では触らない。 */
function upsertRow_(name, defaultHeaders, obj, ensureCols){
  if(!obj) throw new Error('no object');
  const sh = getOrCreateSheet_(name, defaultHeaders);
  if(ensureCols) ensureHeaders_(sh, defaultHeaders);   // 不足列を末尾に追加（初回のみ書き込み）
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(v=>String(v).trim());
  const last = sh.getLastRow();
  const idCol = headers.findIndex(h=>h.toLowerCase()==='id');
  if(idCol < 0) throw new Error('id列が見つかりません: '+name);
  const now = new Date().toISOString();
  if(obj.createdAt==null) obj.createdAt = now;
  obj.updatedAt = now;  // ← Phase 2 B-2: 全保存で必ず更新される（既存通り）
  const objLc = {};
  Object.keys(obj).forEach(k => objLc[k.toLowerCase()] = obj[k]);
  const rowVals = headers.map(h => {
    const key = h.toLowerCase();
    if(key==='cfg' && obj.cfg) return JSON.stringify(obj.cfg);
    // schedule は配列。空配列 [] は「予定を全解除した」という意味を持つため必ず書く。
    // undefined/null のときだけ空セルにして、クライアント側の「ローカル値を保持」に委ねる。
    if(key==='schedule') return Array.isArray(obj.schedule) ? JSON.stringify(obj.schedule) : '';
    if(key==='active') return obj.active!==false;
    if(key==='hidden') return obj.hidden===true;
    const v = objLc[key];
    return (v==null)?'':v;
  });
  if(last >= 2){
    const ids = sh.getRange(2, idCol+1, last-1, 1).getValues();
    for(let i=0;i<ids.length;i++){
      if(String(ids[i][0])===String(obj.id)){
        sh.getRange(i+2, 1, 1, headers.length).setValues([rowVals]);
        return;
      }
    }
  }
  sh.appendRow(rowVals);
}

function deleteRow_(name, id){
  const sh = SS.getSheetByName(name);
  if(!sh) return;
  const last = sh.getLastRow();
  if(last < 2) return;
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(v=>String(v).trim());
  const idCol = headers.findIndex(h=>h.toLowerCase()==='id');
  if(idCol < 0) return;
  const ids = sh.getRange(2, idCol+1, last-1, 1).getValues();
  for(let i=0;i<ids.length;i++){
    if(String(ids[i][0])===String(id)){
      sh.deleteRow(i+2);
      return;
    }
  }
}

function readConfig_(){
  const sh = getOrCreateSheet_('Config', CFG_DEFAULT_HEADERS);
  const last = sh.getLastRow();
  if(last < 2) return {};
  const rows = sh.getRange(2,1,last-1,2).getValues();
  const o = {};
  rows.forEach(r => { if(r[0]) o[r[0]] = isNaN(Number(r[1]))?r[1]:Number(r[1]); });
  return o;
}

function writeConfig_(cfg){
  if(!cfg) return;
  const sh = getOrCreateSheet_('Config', CFG_DEFAULT_HEADERS);
  if(sh.getLastRow()>1) sh.getRange(2,1,sh.getLastRow()-1,2).clearContent();
  const rows = Object.keys(cfg).map(k => [k, cfg[k]]);
  if(rows.length) sh.getRange(2,1,rows.length,2).setValues(rows);
}

function normalizeCell_(header, v){
  if(v instanceof Date){
    if(v.getFullYear()===1899 && v.getMonth()===11 && v.getDate()===30){
      if(header==='time') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
      return '';
    }
    if(header==='date') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if(header==='datetime') return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
    return v.toISOString();
  }
  if(header==='cfg' && typeof v==='string' && v.trim().startsWith('{')){
    try{ return JSON.parse(v); }catch(e){ return {}; }
  }
  // schedule は空セルのとき null を返す（'' ではない）。クライアントは「サーバーが値を持たない」と
  // 判定してローカルの予定を保持できる（列追加直後の移行期に、既存の予定を消さないための要）。
  // 壊れた JSON も null 扱い＝ローカル保持。誤って空配列で上書きするより安全側に倒す。
  if(header==='schedule'){
    if(typeof v==='string' && v.trim().startsWith('[')){
      try{ const a = JSON.parse(v); return Array.isArray(a) ? a : null; }catch(e){ return null; }
    }
    return null;
  }
  if(header==='active'){
    if(v===''||v==null) return true;
    if(typeof v==='boolean') return v;
    const s=String(v).toUpperCase();
    return !(s==='FALSE'||s==='0'||s==='NO');
  }
  if(header==='hidden'){
    if(typeof v==='boolean') return v;
    const s=String(v).toUpperCase();
    return (s==='TRUE'||s==='1'||s==='YES');
  }
  return v;
}

/** ============ 🧪 エディタからのテスト関数（doGet を直接実行しない用） ============ */
function testDoGet_full(){
  const result = doGet({parameter: {action: 'getAll'}});
  const data = JSON.parse(result.getContent());
  console.log('OK / residents:', data.residents.length, ' records:', data.records.length, ' delta:', data.delta);
  console.log('serverTime:', new Date(data.serverTime).toISOString());
}

function testDoGet_delta(){
  // 過去 1 時間以降の差分を取得するテスト
  const oneHourAgo = new Date().getTime() - 3600000;
  const result = doGet({parameter: {action: 'getAll', since: String(oneHourAgo)}});
  const data = JSON.parse(result.getContent());
  console.log('Delta flag:', data.delta);
  console.log('Records returned:', data.records.length, '(過去1時間以内に updatedAt が更新された記録)');
}

function testDoGet_emptyParam(){
  // パラメータなし（旧アプリの動作確認）
  const result = doGet({parameter: {}});
  const data = JSON.parse(result.getContent());
  console.log('OK (no since) / records:', data.records.length, ' delta:', data.delta, '← false 期待');
}

/** ============ 🔍 診断用（既存のまま） ============ */
function debugDumpResidents(){
  const sh = SS.getSheetByName('Residents');
  if(!sh){ console.log('Residents シートなし'); return; }
  const last = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  console.log('=== ヘッダー行 ===');
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0];
  headers.forEach((h,i)=> console.log('列'+String.fromCharCode(65+i)+' ('+(i+1)+'): "'+h+'"'));
  if(last>=2){
    const rows = sh.getRange(2,1,Math.min(5,last-1),lastCol).getValues();
    rows.forEach((row,i)=>{
      console.log('行'+(i+2)+':');
      // 個人情報保護：値そのもの（氏名・居室等）はログに残さず、先頭1字＋長さのみ表示する。
      row.forEach(function(v,j){var s=(v==null?'':String(v));var shown=s.length?(s.charAt(0)+'…('+s.length+')'):'';console.log('  '+headers[j]+' = "'+shown+'"');});
    });
  }
}

function fixAllResidentRows(){
  const sh = SS.getSheetByName('Residents');
  if(!sh) return;
  const last = sh.getLastRow();
  if(last<2) return;
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(v=>String(v).trim());
  const cId=headers.indexOf('id'), cName=headers.indexOf('name'),
        cYomi=headers.indexOf('yomi'), cRoom=headers.indexOf('room'),
        cGender=headers.indexOf('gender'), cActive=headers.indexOf('active');
  const rows = sh.getRange(2,1,last-1,lastCol).getValues();
  let fixed = 0;
  rows.forEach((row,i)=>{
    const vYomi = String(row[cYomi]||'').trim();
    const vRoom = String(row[cRoom]||'').trim();
    const vGender = String(row[cGender]||'').trim();
    if(/^\d+$/.test(vYomi) && (vRoom==='true'||vRoom==='false')){
      row[cYomi] = '';
      row[cRoom] = vYomi;
      row[cGender] = '';
      row[cActive] = vRoom==='true';
      fixed++;
    }
    else if(vYomi==='' && /^\d+$/.test(vRoom) && (vGender==='true'||vGender==='false')){
      row[cGender] = '';
      row[cActive] = vGender==='true';
      fixed++;
    }
  });
  if(fixed>0) sh.getRange(2,1,rows.length,lastCol).setValues(rows);
  console.log('修正件数:', fixed, '/', rows.length);
}
