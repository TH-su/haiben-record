/* haiben-record.html / *.gs から関数・変数の実体を切り出す共用ヘルパ（テスト専用・ローカルのみ）。
   テスト側にロジックを写経しないため。字句走査は link-guard.test.js と同じ考え方。 */
'use strict';
function matchBrace(src, openIdx){
  let depth=0,i=openIdx;
  while(i<src.length){
    const c=src[i];
    if(c==='/'&&src[i+1]==='/'){const n=src.indexOf('\n',i);i=n<0?src.length:n;continue}
    if(c==='/'&&src[i+1]==='*'){const n=src.indexOf('*/',i+2);i=n<0?src.length:n+2;continue}
    if(c==='"'||c==="'"||c==='`'){const q=c;i++;while(i<src.length){if(src[i]==='\\'){i+=2;continue}if(src[i]===q){i++;break}i++}continue}
    if(c==='/'){
      let j=i-1;while(j>=0&&/\s/.test(src[j]))j--;
      const p=j>=0?src[j]:'';
      if(p===''||'(,=:[!&|?{};+-*%~^<>'.includes(p)){
        i++;let cls=false;
        while(i<src.length){
          if(src[i]==='\\'){i+=2;continue}
          if(src[i]==='[')cls=true; else if(src[i]===']')cls=false;
          else if(src[i]==='/'&&!cls){i++;break}
          else if(src[i]==='\n')break;
          i++;
        }
        continue;
      }
    }
    if(c==='{')depth++;
    else if(c==='}'){depth--;if(depth===0)return i}
    i++;
  }
  throw new Error('対応する } が見つかりません');
}
function makeExtractor(SRC){
  return {
    fn(name){
      const re=new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+'+name+'\\s*\\(');
      const m=re.exec(SRC);
      if(!m)throw new Error('関数が見つかりません: '+name);
      const from=m.index+(SRC[m.index]==='\n'?1:0);
      const open=SRC.indexOf('{',m.index+m[0].length);
      return SRC.slice(from,matchBrace(SRC,open)+1);
    },
    varDecl(name){
      const re=new RegExp('(?:^|\\n)\\s*(?:var|let|const)\\s+'+name+'\\s*=[^\\n]*');
      const m=re.exec(SRC);
      if(!m)throw new Error('変数が見つかりません: '+name);
      return m[0].trim().replace(/;?$/,';');
    },
    src: SRC
  };
}
module.exports={makeExtractor,matchBrace};
