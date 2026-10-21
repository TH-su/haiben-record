/* 実物の GAS（gas/haiben-api.gs）を vm で動かすための偽 Apps Script 環境（テスト専用・ローカルのみ）。
   もとは delta-sync.test.js の中にあったものを、伝播テスト（propagation.test.js）と共用するために切り出した。
   ★GAS の判定ロジックはここに写さない。実物をそのまま評価する。
   ★入居者・記録はすべて合成データ。実在の氏名・記録は使わない。

   writable:
     false（既定・従来の挙動）… setValues / appendRow を捨てる。読み取りだけを見るテスト向け。
     true                   … sheet 配列を実際に書き換える。書いた記録を読み直す伝播テスト向け。 */
'use strict';
const vm = require('vm');

const REC_HEADERS_FULL = ['id','residentId','date','time','datetime','type',
  'urineAmt','urineColor','urineSrc','consistency','stoolAmt','stoolColor','stoolSrc',
  'medicine','tablets','notes','staff','createdAt','updatedAt'];

const TEST_TOKEN='hb-aikotoba-kakuu';   // 試験用の合言葉（架空）
function colIndex(letters){let n=0;for(const ch of letters)n=n*26+(ch.charCodeAt(0)-64);return n-1}

/* sheet は [[ヘッダ...],[行...],...] の2次元配列。呼び出し側が持ち続ける実体をそのまま渡す。 */
function makeGasCtx(gasSource, sheet, opts){
  const writable = !!(opts && opts.writable);
  const residents = (opts && opts.residents) || [{id:1,name:'入居者A',room:'101',active:true}];
  const config = (opts && opts.config) || {};
  /* 2026-10-08 から GAS は HAIBEN_TOKEN が未設定なら全部断る（猶予モードをやめた）。scriptProperties を渡さない試験は
     「合言葉を設定済み・端末は正しい合言葉を送る」を既定にする（下の doPost/doGet の包みが本文・クエリへ足す） */
  const props = (opts && opts.scriptProperties) || { HAIBEN_TOKEN: TEST_TOKEN };
  const autoToken = !(opts && opts.scriptProperties);

  const ctx={
    console:{log(){},warn(){},error(){}},
    Date,JSON,Math,String,Number,Array,Object,isNaN,parseInt,parseFloat,
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getId:()=>'SS',getSheetByName:(n)=>_byName(n),insertSheet:(n)=>_create(n)}),flush(){}},
    PropertiesService:{getScriptProperties:()=>({getProperty:(k)=>(k in props?props[k]:null)})},
    CacheService:{getScriptCache:()=>({get:()=>null,put(){},remove(){}})},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:(s)=>({_s:s,setMimeType(){return this},getContent(){return this._s}})},
    Sheets:{Spreadsheets:{Values:{
      get(id,range){
        if(range==='Records')return{values:sheet.map(r=>r.slice())};
        if(range==='Records!1:1')return{values:[sheet[0].slice()]};
        throw new Error('未対応のレンジ: '+range);
      },
      batchGet(id,o){
        const out=(o.ranges||[]).map(rg=>{
          let m=/^Records!([A-Z]+):([A-Z]+)$/.exec(rg);
          if(m){
            const ci=colIndex(m[1]);
            return{values:sheet.map(r=>{const v=r[ci];return (v===undefined||v==='')?[]:[v]})};
          }
          m=/^Records!A(\d+):([A-Z]+)(\d+)$/.exec(rg);
          if(m){
            const r1=Number(m[1]),r2=Number(m[3]);
            return{values:sheet.slice(r1-1,r2).map(r=>r.slice())};
          }
          throw new Error('未対応のレンジ: '+rg);
        });
        return{valueRanges:out};
      }
    }}},
    Utilities:{}
  };
  vm.createContext(ctx);
  vm.runInContext(gasSource,ctx,{filename:'haiben-api.gs'});
  if(autoToken){
    const realPost=ctx.doPost, realGet=ctx.doGet;
    ctx.doPost=(e)=>{
      try{ const c=e&&e.postData&&e.postData.contents; const j=c?JSON.parse(c):null;
        if(j&&typeof j==='object'&&!('token' in j)){ j.token=props.HAIBEN_TOKEN; e=Object.assign({},e,{postData:Object.assign({},e.postData,{contents:JSON.stringify(j)})}); } }catch(err){}
      return realPost(e);
    };
    ctx.doGet=(e)=>{ const p=Object.assign({},(e&&e.parameter)||{}); if(!('token' in p)) p.token=props.HAIBEN_TOKEN; return realGet(Object.assign({},e,{parameter:p})); };
  }

  /* シート実体（SpreadsheetApp 経路＝readSheet_ のフォールバックでも同じ盤面を見せる）。
     getOrCreateSheet_ だけを差し替え、readSheet_/readRecordsFast_/readRecordsWindow_ は実物のまま動かす。
     2026-10-07: 削除の印（Deleted）を試すため、名前ごとに別の盤面を持てるようにした。
     ★Records と Deleted・DeletedRows 以外の名前は、従来どおり記録の盤面を返す（既存テストの挙動を変えない）。
     opts.failCreate(名前) が真なら、その名前の作成・取得で例外にする（控えを書けない場面の試験）。 */
  function makeFake(sheet){ return {
    getLastRow:()=>sheet.length,
    getLastColumn:()=>sheet.reduce((m,r)=>Math.max(m,r.length),0),
    getMaxColumns:()=>sheet.reduce((m,r)=>Math.max(m,r.length),0),
    getRange(r,c,nr,nc){
      nr=nr||1;nc=nc||1;
      return{
        getValues(){
          const out=[];
          for(let i=0;i<nr;i++){
            const row=sheet[r-1+i]||[];
            const line=[];
            for(let j=0;j<nc;j++){const v=row[c-1+j];line.push(v===undefined?'':v)}
            out.push(line);
          }
          return out;
        },
        setValues(vals){
          if(!writable)return;                    // 従来どおり捨てる（読み取りだけのテスト）
          for(let i=0;i<vals.length;i++){
            const ri=r-1+i;
            if(!sheet[ri])sheet[ri]=[];
            for(let j=0;j<vals[i].length;j++)sheet[ri][c-1+j]=vals[i][j];
          }
        },
        getValue(){ const row=sheet[r-1]||[]; const v=row[c-1]; return v===undefined?'':v; },
        setValue(v){
          if(!writable)return;
          if(!sheet[r-1])sheet[r-1]=[];
          sheet[r-1][c-1]=v;
        }
      };
    },
    insertColumnsAfter(){},
    appendRow(row){ if(writable)sheet.push(row.slice()); },
    deleteRow(n){ if(writable)sheet.splice(n-1,1); },
    deleteRows(n,k){ if(writable)sheet.splice(n-1,k||1); },
    getName(){ return ''; }
  }; }
  const fakeSheet=makeFake(sheet);
  const sheets=(opts&&opts.sheets)||{};          // 名前 → 2次元配列（呼び出し側が覗ける実体）
  const fakes={Records:fakeSheet};
  Object.keys(sheets).forEach(n=>{fakes[n]=makeFake(sheets[n])});
  const OWN=['Deleted','DeletedRows'];   // 自分の盤面を持つ名前（DeletedRows は消す前の控え・2026-10-21）
  function _byName(n){ if(fakes[n])return fakes[n]; return OWN.indexOf(n)>=0?null:fakeSheet; }
  function _create(n,headers){
    if(!fakes[n]){ sheets[n]=headers?[headers.slice()]:[]; fakes[n]=makeFake(sheets[n]); }
    return fakes[n];
  }
  ctx.__sheets=sheets;
  ctx.getOrCreateSheet_=(n,headers)=>{ if(OWN.indexOf(n)>=0){ if(opts&&opts.failCreate&&opts.failCreate(n))throw new Error('Service Spreadsheets failed'); return fakes[n]||_create(n,headers); } return fakeSheet; };
  ctx.readResidentsCached_=()=>residents.map(r=>Object.assign({},r));
  ctx.readConfig_=()=>Object.assign({},config);
  return ctx;
}

module.exports={makeGasCtx, REC_HEADERS_FULL, colIndex, TEST_TOKEN};
