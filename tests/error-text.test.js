/* 例外の中身を応答に出さない（2026-10-18 改善プロンプト第2弾の14）
 * 守ること:
 *   1. gas/haiben-api.gs の catch で、応答に String(err)・err.message を入れない（定型文 SERVER_ERR_MSG だけ）
 *   2. 例外の中身は console（GAS の実行ログ）にだけ残す
 *   3. 定型文は1か所（SERVER_ERR_MSG）。ok:false のまま＝画面は未送信として送り直す
 * 実行: node tests/error-text.test.js */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(process.env.HAIBEN_GAS || path.join(__dirname, '..', 'gas', 'haiben-api.gs'), 'utf8');
let pass = 0, fail = 0;
function ok(c, m, e) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } }
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const bad = code.split('\n').filter(l => /error\s*:\s*(String\(\s*(err|e|ex)\s*\)|(err|e|ex)\.message|''\s*\+\s*(err|e))/.test(l));
ok(bad.length === 0, '応答の error に例外の中身（String(err)・err.message）を入れていない', bad);
ok(/const SERVER_ERR_MSG = '[^']+';/.test(SRC), '定型文は SERVER_ERR_MSG の1か所');
const uses = (code.match(/error:SERVER_ERR_MSG/g) || []).length;
ok(uses >= 5, '例外の応答5か所がすべて定型文（' + uses + 'か所）', uses);
const catches = code.match(/catch\s*\(\s*err\s*\)\s*\{[^}]*error:SERVER_ERR_MSG[^}]*\}/g) || [];
ok(catches.every(c => /console\.(error|warn)\(/.test(c)), '定型文を返す catch では、例外の中身を console に残している', catches.filter(c => !/console\.(error|warn)\(/.test(c)));
console.log('\n合計: ' + pass + ' 件成功 / ' + fail + ' 件失敗');
process.exit(fail ? 1 : 0);
