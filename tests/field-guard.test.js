/* ══════════════════════════════════════════════════════════════════════
   現場端末の守りと CSP の検証（2026-10-15・代表者の依頼）
   実行:  node tests/field-guard.test.js
   ──────────────────────────────────────────────────────────────────────
   守る約束:
     1 su_device_role が field の端末では、設定と接続・データ管理と危険操作・入居者の管理を出さない（CSS）
     2 同じ操作は関数の入口でも止める（画面を細工して押しても通らない）
     3 field 以外（未設定・office・読めない）は今までどおり＝止めない
     4 記録・予定・記録者・帳票・手動同期は field でも使える（隠さない・止めない）
     5 CSP の meta が中身の指紋と一致し、<meta charset> の直後にある。インラインのイベント属性が無い
   ★haiben-record.html の実物のソースから関数を切り出して評価する（写経しない）。HAIBEN_HTML で差し替えは変異テスト用。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { makeExtractor } = require('./_extract.js');

const FILE = process.env.HAIBEN_HTML || path.join(__dirname, '..', 'haiben-record.html');
const HTML = fs.readFileSync(FILE, 'utf8');
const SRC = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];
const X = makeExtractor(SRC);

let pass = 0, fail = 0;
function t(name, ok, info) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info !== undefined ? '（' + JSON.stringify(info) + '）' : '')); } }

function box(role, throws) {
  const toasts = [];
  const cls = new Set();
  const b = {
    localStorage: { getItem: (k) => { if (throws) throw new Error('blocked'); return k === 'su_device_role' ? role : null; } },
    showToast: (m) => toasts.push(m),
    document: { documentElement: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } } },
    toasts, cls
  };
  vm.createContext(b);
  vm.runInContext(['hbIsField', 'hbFieldDeny', 'hbApplyField_'].map((n) => X.fn(n)).join('\n'), b);
  return b;
}

console.log('— 1・3 端末の役割の判定 —');
{
  const f = box('field'); f.hbApplyField_();
  t('field: 止める・お知らせを出す', f.hbFieldDeny() === true && f.toasts.length === 1 && /事務所PC/.test(f.toasts[0]), f.toasts);
  t('field: html に hb-field を付ける', f.cls.has('hb-field'));
  for (const [role, label] of [[null, '未設定'], ['office', 'office'], ['', '空']]) {
    const o = box(role); o.hbApplyField_();
    t(label + ': 止めない・印を付けない', o.hbFieldDeny() === false && o.toasts.length === 0 && !o.cls.has('hb-field'));
  }
  const e = box('field', true); e.hbApplyField_();
  t('端末の控えが読めない時は事務所PC扱い（今までの動き）', e.hbFieldDeny() === false && !e.cls.has('hb-field'));
}

console.log('\n— 2 関数の入口で止める —');
{
  const guarded = ['toggleResActive', 'toggleResHidden', 'linkAck', 'linkUnlink', 'clearLinkBackup', 'restoreLinkBackup',
    'repairResLinks', 'openHospModal', 'editRes', 'delRes', 'expCSV', 'expJSON', 'impJSON'];
  for (const n of guarded) {
    const body = X.fn(n);
    const head = body.slice(body.indexOf('{') + 1, body.indexOf('{') + 60);
    t(n + ' の入口で止める', /^\s*if\(hbFieldDeny\(\)\)/.test(head), head.slice(0, 40));
  }
  for (const id of ['btnAddRes', 'btnSaveCfg', 'btnClear', 'btnApiSave', 'btnApiClear', 'btnImport']) {
    const re = new RegExp("\\$\\('" + id + "'\\)\\.addEventListener\\('click',function\\(\\)\\{if\\(hbFieldDeny\\(\\)\\)return;");
    t(id + ' のボタンの入口で止める', re.test(SRC));
  }
  t('saveRes（入居者の保存）の入口で止める（開いたままの画面から保存させない）', /^function saveRes\(\)\{if\(hbFieldDeny\(\)\)return;/m.test(SRC));
  for (const sel of ["$('mHospAdd')", "#mHospList .hosp-discharge", "#mHospList .hosp-del"]) {
    const i = SRC.indexOf(sel); const seg = SRC.slice(i, i + 220);
    t(sel + ' の入口で止める', i >= 0 && /addEventListener\('click',function\(\)\{if\(hbFieldDeny\(\)\)return;/.test(seg));
  }
  {
    const removed = [];
    const b2 = { localStorage: { getItem: () => 'field' }, showToast: () => {}, document: { documentElement: { classList: { toggle: () => {} } }, getElementById: (id) => ({ classList: { remove: (c) => removed.push(id + ':' + c) } }) } };
    vm.createContext(b2); vm.runInContext(['hbIsField', 'hbFieldDeny', 'hbApplyField_'].map((n) => X.fn(n)).join('\n'), b2);
    b2.hbApplyField_();
    t('現場用に変わったら、開いている入居者の編集・入院の画面を閉じる', removed.includes('mRes:on') && removed.includes('mHosp:on'), removed);
  }
  /* 実際に動かして、止めた時に中身へ進まないことを確かめる（expJSON は書き出しの dl を呼ぶ） */
  const b = { calls: 0, localStorage: { getItem: () => 'field' }, showToast: () => {}, dl: () => { b.calls++; }, JSON, D: {}, today: () => '2026-10-15' };
  vm.createContext(b);
  vm.runInContext(['hbIsField', 'hbFieldDeny', 'expJSON'].map((n) => X.fn(n)).join('\n'), b);
  b.expJSON();
  t('field で JSON の書き出しを押しても書き出さない', b.calls === 0);
  b.localStorage.getItem = () => 'office'; b.expJSON();
  t('事務所PC では今までどおり書き出す', b.calls === 1);
}

console.log('\n— 1・4 隠すもの・隠さないもの（CSS）—');
{
  const css = (/html\.hb-field #cdResMgmt[^{]*\{display:none !important\}/.exec(HTML) || [''])[0];
  for (const id of ['cdResMgmt', 'cdCfgAlert', 'cdData', 'cdDanger', 'cdLinkAudit']) {
    t('#' + id + ' を隠す（その id のカードが画面にある）', css.includes('#' + id) && new RegExp('id="' + id + '"').test(HTML));
  }
  t('.hb-conn-edit（接続先と合言葉の入力・保存・連携解除）を隠す', css.includes('.hb-conn-edit') && (HTML.match(/hb-conn-edit/g) || []).length >= 5);
  for (const id of ['btnApiSync', 'btnOpenReport', 'btnAddStaff', 'btnSubmit', 'btnSched']) {
    const m = new RegExp('<[^>]*id="' + id + '"[^>]*>').exec(HTML);
    t(id + ' は隠さない', !!m && !/hb-conn-edit/.test(m[0]));
  }
  /* 隠すカードの中に、記録・帳票・手動同期のボタンが紛れ込んでいない */
  const card = (id) => { const i = HTML.indexOf('id="' + id + '"'); const s = HTML.lastIndexOf('<div', i); let d = 0, j = s; const re = /<\/?div\b/g; re.lastIndex = s; let m; while ((m = re.exec(HTML))) { d += m[0] === '<div' ? 1 : -1; if (d === 0) { j = m.index; break; } } return HTML.slice(s, j); };
  const hidden = ['cdResMgmt', 'cdCfgAlert', 'cdData', 'cdDanger'].map(card).join('');
  t('隠すカードに記録・帳票・手動同期・記録者のボタンが無い', !/id="(btnApiSync|btnOpenReport|btnAddStaff|btnAddStaff2|btnSubmit|btnSched)"/.test(hidden));
  t('現場用の案内がある（field の時だけ見える）', /class="hb-field-note"/.test(HTML) && /html\.hb-field \.hb-field-note\{display:block/.test(HTML));
  t('読み込み時と他のタブで役割が変わった時に印を付け直す', /hbApplyField_\(\);window\.addEventListener\('storage'/.test(SRC));
}

console.log('\n— 5 CSP —');
{
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'csp.mjs'), '--check'], { encoding: 'utf8', env: Object.assign({}, process.env, { HAIBEN_CSP_FILE: FILE }) });
  if (process.env.HAIBEN_HTML) t('（変異テスト中は CSP の照合を飛ばす）', true);
  else t('CSP の meta が中身と一致し、<meta charset> の直後にある', r.status === 0, (r.stderr || r.stdout).trim());
  t('worker-src に blob: がある（圧縮の Worker を CSP で止めない）', /worker-src 'self' blob:/.test(HTML));
  t('接続先は自サイト・Google の受け口・Supabase だけ', /connect-src 'self' https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com https:\/\/[a-z0-9]+\.supabase\.co wss:\/\/[a-z0-9]+\.supabase\.co;/.test(HTML));
}

console.log('\n────────── 合計: ' + pass + ' 件成功 / ' + fail + ' 件失敗 ──────────');
process.exit(fail ? 1 : 0);
