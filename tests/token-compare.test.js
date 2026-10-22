/* 合言葉の受け取り方と比べ方（2026-10-22 改善プロンプト第3弾の11）
 * 守ること:
 *   1. 合言葉は POST 本文の token だけで受ける。URL のクエリの合言葉（e.parameter.token）は読まない
 *   2. 比べ方は一致した長さで時間が変わらない tokensEqual_（入居者マスタ・個別機能訓練計画書API と同じ中身）。=== で比べない
 *   3. 違う・長さ違い・文字でない・未設定は断る（例外を出さない）
 * 実物の gas/haiben-api.gs から関数を切り出して動かす（写経しない）。合言葉は試験用の作り物。
 * 実行: node tests/token-compare.test.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeExtractor } = require('./_extract.js');
const SRC = fs.readFileSync(process.env.HAIBEN_GAS || path.join(__dirname, '..', 'gas', 'haiben-api.gs'), 'utf8');
const X = makeExtractor(SRC);
let pass = 0, fail = 0;
function ok(c, m, e) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } }

function box(props) {
  const b = { JSON, String, PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) } };
  vm.createContext(b);
  vm.runInContext([X.varDecl('TOKEN_PROP').replace(/^const /, 'var '), X.fn('tokensEqual_'), X.fn('_token')].join('\n'), b);
  return b;
}
const body = o => ({ postData: { contents: JSON.stringify(o) } });

console.log('— 1. tokensEqual_ の答え —');
{
  const b = box({}); const E = b.tokensEqual_;
  ok(E('abc-123', 'abc-123') === true, '同じなら true');
  ok(E('abc-123', 'abc-124') === false, '同じ長さで1文字違えば false');
  ok(E('abc', 'abc-123') === false && E('abc-123', 'abc') === false, '長さが違えば false（短い方が先頭一致でも）');
  ok(E('', 'x') === false && E(null, 'x') === false && E(undefined, 'x') === false, '空・null・undefined は false');
}

console.log('— 2. 本文の合言葉だけで判定する —');
{
  const b = box({ HAIBEN_TOKEN: 'HB-1' });
  ok(b._token(body({ token: 'HB-1' })) === true, '本文の合言葉は通る');
  ok(b._token({ parameter: { token: 'HB-1' }, postData: { contents: '{}' } }) === false, 'クエリだけの合言葉は断る');
  ok(b._token({ parameter: { token: 'HB-1' } }) === false, '本文の無い要求（GET と同じ形）のクエリの合言葉も断る');
  ok(b._token({ parameter: { token: 'HB-1' }, postData: { contents: JSON.stringify({ token: 'HB-2' }) } }) === false, 'クエリが正しくても本文が違えば断る（クエリは見ない）');
  ok(b._token({ parameter: { token: 'HB-2' }, postData: { contents: JSON.stringify({ token: 'HB-1' }) } }) === true, 'クエリと本文の両方なら本文で決まる');
  ok(b._token(body({ token: 'HB-2' })) === false && b._token(body({ token: 'HB-' })) === false && b._token(body({ token: 12 })) === false, '違う・長さ違い・文字でない合言葉は断る');
  ok(b._token({ postData: { contents: '{壊' } }) === false && b._token({ postData: { contents: 'null' } }) === false && b._token({}) === false, '本文が壊れている・null・無いなら断る（例外を出さない）');
  const b2 = box({});
  ok(b2._token(body({ token: '' })) === false && b2._token(body({ token: 'x' })) === false, '合言葉が未設定なら断る');
}

console.log('— 3. ソースの形 —');
{
  const fnBody = X.fn('_token').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/parameter\.token|parameter\b/.test(fnBody), '_token は URL のクエリ（e.parameter）を読まない');
  ok(/tokensEqual_\(/.test(fnBody) && !/(got|exp)\s*[!=]==?\s*(got|exp)/.test(fnBody), '_token は tokensEqual_ で比べ、=== で合言葉を比べない');
}

console.log('\n合計: ' + pass + ' 件成功 / ' + fail + ' 件失敗');
process.exit(fail ? 1 : 0);
