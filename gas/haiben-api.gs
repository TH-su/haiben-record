/** ============================================================
 *  排便記録アプリ用 Apps Script（堅牢版 + Phase 2 B-2 差分同期対応）
 * ============================================================ */
const SS = SpreadsheetApp.getActiveSpreadsheet();

const RES_DEFAULT_HEADERS = ['id','name','yomi','room','gender','active','hidden','laxNote','cfg'];
const REC_DEFAULT_HEADERS = ['id','residentId','date','time','datetime','type',
  'urineAmt','urineColor','urineSrc','consistency','stoolAmt','stoolColor','stoolSrc',
  'medicine','tablets','notes','staff','createdAt','updatedAt'];
const CFG_DEFAULT_HEADERS = ['key','value'];

/** ============ doGet（差分同期対応） ============ */
function doGet(e){
  // エディタの「実行」ボタンで直接呼ばれた場合の保護
  const params = (e && e.parameter) || {};
  try{
    // Phase 2 B-2: ?since= があれば updatedAt で差分フィルタ
    const since = parseInt(params.since, 10) || 0;
    let records = readSheet_('Records', REC_DEFAULT_HEADERS);
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
      residents: readSheet_('Residents', RES_DEFAULT_HEADERS),
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
  try{
    if(!e || !e.postData) return json({ok:false, error:'no postData'});
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    console.log('doPost action=', action, ' body=', JSON.stringify(body).slice(0,800));
    switch(action){
      case 'addRecord':  upsertRow_('Records',   REC_DEFAULT_HEADERS, body.record);  return json({ok:true});
      case 'saveRecord': upsertRow_('Records',   REC_DEFAULT_HEADERS, body.record);  return json({ok:true});
      case 'delRecord':  deleteRow_('Records',   body.id);                            return json({ok:true});
      case 'saveRes':    upsertRow_('Residents', RES_DEFAULT_HEADERS, body.resident); return json({ok:true});
      case 'delRes':     deleteRow_('Residents', body.id);                            return json({ok:true});
      case 'saveCfg':    writeConfig_(body.cfg);                                      return json({ok:true});
      default: return json({ok:false, error:'unknown action: '+action});
    }
  }catch(err){
    console.error('doPost error:', err);
    return json({ok:false, error:String(err)});
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

function upsertRow_(name, defaultHeaders, obj){
  if(!obj) throw new Error('no object');
  const sh = getOrCreateSheet_(name, defaultHeaders);
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
      row.forEach((v,j)=> console.log('  '+headers[j]+' = "'+v+'"'));
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
