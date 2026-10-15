#!/usr/bin/env node
/* tools/csp.mjs — 排泄ケア記録の CSP の meta を作る・確かめる（2026-10-15）
 *
 * 使い方（リポジトリの直下で）:
 *   node tools/csp.mjs --write   … haiben-record.html の CSP の meta を中身に合わせて書き直す
 *   node tools/csp.mjs --check   … 合っていなければ終了コード 1
 *
 * 決まりは care-tools の業務画面と同じ（care-tools の check/csp.mjs の policy をそのまま使う）。
 * 読み込み元は自サイト・Google の受け口（GAS）・Supabase に絞り、画面の中のスクリプトは中身の指紋（sha256）で許す。
 * 排泄ケア記録だけの足し分は worker-src（保存の圧縮を別スレッドで回す Worker を blob: から作るため）。
 * インラインのスクリプトを直したら --write を必ず回す（指紋がずれると画面が動かない）。
 * care-tools のクローンは CARE_TOOLS（既定は隣の ../care-tools）。見つからない時は止める（CSP の無い版・指紋のずれた版を作らない）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARE = process.env.CARE_TOOLS || path.resolve(ROOT, '..', 'care-tools');
const TOOL = path.join(CARE, 'check', 'csp.mjs');
if (!fs.existsSync(TOOL)) { console.error('🛑 care-tools の check/csp.mjs が見つかりません: ' + TOOL + '（CARE_TOOLS で場所を指定）'); process.exit(2); }
const care = await import(pathToFileURL(TOOL).href);

const FILE = path.join(ROOT, 'haiben-record.html');
const META_RE = /<meta http-equiv="Content-Security-Policy" data-su-csp content="[^"]*">\n?/;
export function policy(html) { return care.policy(html) + "; worker-src 'self' blob:"; }
export function metaOf(html) { return '<meta http-equiv="Content-Security-Policy" data-su-csp content="' + policy(html) + '">'; }
export function withMeta(html) {
  const meta = metaOf(html.replace(META_RE, ''));
  if (META_RE.test(html)) return html.replace(META_RE, meta + '\n');
  const m = /<meta charset="[^"]*">\n?/i.exec(html);
  if (!m) throw new Error('<meta charset> がありません');
  const at = m.index + m[0].length;
  return html.slice(0, at) + (m[0].endsWith('\n') ? '' : '\n') + meta + '\n' + html.slice(at);
}
export function checkPage(html) {
  const m = META_RE.exec(html);
  if (!m) return 'CSP の meta がありません';
  if (m[0].trim() !== metaOf(html.replace(META_RE, ''))) return 'CSP の指紋が中身と合っていません（node tools/csp.mjs --write を回す）';
  const low = html.replace(/[A-Z]/g, ch => ch.toLowerCase());
  const cs = low.indexOf('<meta charset'), first = low.indexOf('<script');
  if (cs < 0 || m.index < cs || (first >= 0 && first < m.index)) return 'CSP の meta が <meta charset> の直後（どのスクリプトよりも前）にありません';
  if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, ''))) return 'インラインのイベント属性（onclick など）があります（CSP で動かない）';
  return '';
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const html = fs.readFileSync(FILE, 'utf8');
  if (process.argv.includes('--write')) {
    const out = withMeta(html);
    if (out !== html) { fs.writeFileSync(FILE, out); console.log('書き直した: haiben-record.html'); } else console.log('変わりなし: haiben-record.html');
    const err = checkPage(out);
    if (err) { console.error('🛑 ' + err); process.exit(1); }
  } else {
    const err = checkPage(html);
    if (err) { console.error('🛑 haiben-record.html: ' + err); process.exit(1); }
    console.log('CSP は中身と一致（haiben-record.html）');
  }
}
