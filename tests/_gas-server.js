/* 実物の GAS（gas/haiben-api.gs）をローカルの HTTP サーバとして立てる（テスト専用・ローカルのみ）。
   ブラウザから本物と同じ形（text/plain の POST 本文に JSON）で叩けるようにして、
   「片方の端末で入れた記録が、もう片方の端末に何秒で出るか」を実測するために使う。

   ・GAS のロジックは写さない。_gas-ctx.js 経由で実物を vm で動かす
   ・合言葉は設定済み（_gas-ctx.js の TEST_TOKEN）。端末が token を送らない時は、包みが正しい合言葉を足す（2026-10-08：未設定の猶予モードをやめたため）
   ・ポートは 0 で OS に選ばせる（固定ポートは他セッションの居残りと衝突する）
   ・記録はすべて合成データ。実在の氏名・記録は使わない */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeGasCtx, REC_HEADERS_FULL } = require('./_gas-ctx');

const ROOT = path.join(__dirname, '..');

/* sheet: [[ヘッダ...],[行...]] の実体。呼び出し側がそのまま覗ける（書き込みも反映される）。
   返り値: {url, sheet, port, close(), stats} */
function startGasServer(opts) {
  opts = opts || {};
  const gasSource = fs.readFileSync(opts.gasPath || path.join(ROOT, 'gas', 'haiben-api.gs'), 'utf8');
  const sheet = opts.sheet || [REC_HEADERS_FULL.slice()];
  const residents = opts.residents || [{ id: 1, name: '入居者A', room: '101', active: true }];
  const stats = { get: 0, post: 0, byAction: {} };
  const sheets = opts.sheets || {};   // Records 以外のシート（Deleted 等・2026-10-07）。要求をまたいで持ち続ける

  /* 毎回 ctx を作り直すと GAS 内のキャッシュ（CacheService は空実装）や状態が素直になる。
     sheet の実体は共有するので、書いた記録は次の取得で読める。 */
  function ctx() {
    return makeGasCtx(gasSource, sheet, { writable: true, residents: residents, config: opts.config || {}, sheets: sheets });
  }

  const server = http.createServer((req, res) => {
    // text/plain の POST は preflight を起こさないが、念のため OPTIONS も通す
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out = '{"ok":false,"error":"未対応"}';
      try {
        if (req.method === 'POST') {
          stats.post++;
          try {
            const parsed = JSON.parse(body || '{}');
            const a = parsed && parsed.action;
            if (a) stats.byAction[a] = (stats.byAction[a] || 0) + 1;
          } catch (e) { /* 形式不明はそのまま GAS に渡して本物の応答を見る */ }
          out = ctx().doPost({ postData: { contents: body } }).getContent();
        } else {
          stats.get++;
          const u = new URL(req.url, 'http://localhost');
          const params = {};
          u.searchParams.forEach((v, k) => { params[k] = v; });
          out = ctx().doGet({ parameter: params }).getContent();
        }
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(out);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ sheets: sheets,
        url: 'http://127.0.0.1:' + port + '/exec',
        port,
        sheet,
        stats,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startGasServer, REC_HEADERS_FULL };
