#!/usr/bin/env node
/**
 * 資料一致性檢查（純 Node，免安裝套件）
 *   node scripts/check-data.js            # 錯誤 → 結束碼 1；警告不影響
 *   node scripts/check-data.js --strict   # 警告也視為失敗
 *   node scripts/check-data.js --dir ./   # 指定網站資料夾（預設為腳本的上一層）
 *
 * 會讀取：stock.js、discounts.js，以及商品資料
 *   （優先 products.js；沒有的話從 index.html 內嵌的 P / CAT / ORD / TABS / ALSO 解析）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const dirArg = args.indexOf('--dir');
const ROOT = path.resolve(dirArg > -1 ? args[dirArg + 1] : path.join(__dirname, '..'));

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

// ---------- 工具 ----------
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
function runVarsFile(file, names) {
  const ctx = vm.createContext({});
  vm.runInContext(read(file), ctx, { filename: file, timeout: 2000 });
  const out = {};
  names.forEach((n) => (out[n] = ctx[n]));
  return out;
}
const norm = (s) => String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function suggest(name, candidates) {
  const nn = norm(name);
  let best = null, bd = 99;
  for (const c of candidates) {
    const dist = norm(c) === nn ? 0 : lev(nn, norm(c));
    if (dist < bd) { bd = dist; best = c; }
  }
  return bd <= 3 ? best : null;
}
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const lit = (src) => vm.runInNewContext('(' + src + ')', {}, { timeout: 2000 });
const q = (s) => JSON.stringify(s);

// ---------- 載入商品資料 ----------
function loadProducts() {
  if (exists('products.js')) {
    const v = runVarsFile('products.js', ['P', 'CAT', 'ORD', 'TABS', 'ALSO']);
    return { ...v, source: 'products.js' };
  }
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts.join('\n');
  const P = [];
  const re = /\{\s*id:\s*(\d+)\s*,\s*n:\s*("(?:[^"\\]|\\.)*")\s*,\s*p:\s*(-?[\d.]+)\s*,\s*i:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
  let m;
  while ((m = re.exec(code))) P.push({ id: Number(m[1]), n: JSON.parse(m[2]), p: Number(m[3]), i: JSON.parse(m[4]) });
  // 偵測「長得像商品、但沒被解析到」的條目，避免漏檢
  const declared = (code.match(/\bid:\s*\d+\s*,\s*n:/g) || []).length;
  if (declared !== P.length) err(`index.html 內有 ${declared} 筆 id/n 商品寫法，但只解析到 ${P.length} 筆，商品格式可能被改動，請檢查腳本的解析規則`);
  // 取出 `var NAME = [...]` 或 `{...}`（用括號配對，避免 `var TABS=[...],cat="全部"` 這種連寫被切錯）
  const grab = (name) => {
    const mm = new RegExp('var\\s+' + name + '\\s*=\\s*').exec(code);
    if (!mm) return undefined;
    let i = mm.index + mm[0].length;
    const open = code[i];
    if (open !== '[' && open !== '{') return undefined;
    let depth = 0, inStr = null;
    for (let j = i; j < code.length; j++) {
      const c = code[j];
      if (inStr) { if (c === '\\') j++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") inStr = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { try { return lit(code.slice(i, j + 1)); } catch (e) { err(`無法解析 ${name}：${e.message}`); return undefined; } } }
    }
    return undefined;
  };
  return { P, CAT: grab('CAT'), ORD: grab('ORD'), TABS: grab('TABS'), ALSO: grab('ALSO'), source: 'index.html' };
}

// ---------- 檢查：商品 ----------
function checkProducts(d) {
  const { P, CAT, ORD, TABS, ALSO } = d;
  if (!P.length) { err('找不到任何商品資料（P 為空）'); return; }
  const ids = new Map(), names = new Map();
  for (const x of P) {
    if (ids.has(x.id)) err(`商品 id 重複：${x.id}（${ids.get(x.id)} 與 ${x.n}）`); else ids.set(x.id, x.n);
    if (names.has(norm(x.n)) ) err(`商品名稱重複（忽略空白與全半形後相同）：${q(names.get(norm(x.n)))} 與 ${q(x.n)}`); else names.set(norm(x.n), x.n);
    if (x.n !== x.n.trim()) err(`商品名稱前後有空白：${q(x.n)}`);
    if (!x.n) err(`id ${x.id} 沒有品名`);
    if (!(Number.isFinite(x.p) && x.p > 0)) err(`價格不是正數：${x.n} → ${x.p}`);
    else if (!Number.isInteger(x.p)) warn(`價格不是整數元：${x.n} → ${x.p}（折扣會四捨五入，建議用整數）`);
    checkImage(x);
  }
  const idset = new Set(ids.keys());

  if (!CAT) err('找不到 CAT（分類對照表）');
  else {
    for (const x of P) if (!(x.id in CAT)) err(`商品沒有分類：id ${x.id} ${x.n}（只會出現在「全部」分頁）`);
    for (const k of Object.keys(CAT)) {
      if (!idset.has(Number(k))) err(`CAT 引用了不存在的商品 id：${k}`);
      if (TABS && !TABS.includes(CAT[k])) err(`CAT[${k}] 的分類 ${q(CAT[k])} 不在 TABS 分頁清單裡`);
    }
  }
  if (!TABS) err('找不到 TABS（分頁清單）');
  else {
    const used = new Set([...(CAT ? Object.values(CAT) : []), ...Object.values(ALSO || {}).flat()]);
    for (const t of TABS) {
      if (t === '全部') continue;
      const has = P.some((x) => (CAT && CAT[x.id] === t) || ((ALSO || {})[x.id] || []).includes(t) || (t === '王品' && x.n.startsWith('王品')));
      if (!has) warn(`分頁 ${q(t)} 目前沒有任何商品`);
    }
    void used;
  }
  if (ALSO) {
    for (const [k, arr] of Object.entries(ALSO)) {
      if (!idset.has(Number(k))) err(`ALSO 引用了不存在的商品 id：${k}`);
      (arr || []).forEach((t) => { if (TABS && !TABS.includes(t)) err(`ALSO[${k}] 的分類 ${q(t)} 不在 TABS 裡`); });
    }
  }
  if (ORD) {
    const seen = new Set();
    for (const id of ORD) {
      if (!idset.has(id)) err(`ORD（排序表）引用了不存在的商品 id：${id}`);
      if (seen.has(id)) err(`ORD（排序表）有重複的 id：${id}`);
      seen.add(id);
    }
    for (const x of P) if (!seen.has(x.id)) warn(`商品不在排序表 ORD 裡，會被排到最後：id ${x.id} ${x.n}`);
  }
}

function checkImage(x) {
  const i = x.i || '';
  if (!i) { err(`商品沒有圖片：${x.n}`); return; }
  const m = i.match(/^data:image\/(\w+);base64,(.*)$/s);
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    const hex = buf.subarray(0, 4).toString('hex');
    const ok = hex.startsWith('ffd8ff') || hex === '89504e47' || (buf.subarray(0, 4).toString() === 'RIFF');
    if (!buf.length || !ok) err(`圖片資料損壞或格式不明：${x.n}`);
    if (buf.length > 150 * 1024) warn(`圖片偏大（${Math.round(buf.length / 1024)} KB）：${x.n}`);
  } else if (/^https?:\/\//.test(i)) {
    warn(`圖片使用外部網址（可能失效或被擋）：${x.n}`);
  } else if (!exists(i)) {
    err(`圖片檔案不存在：${x.n} → ${i}`);
  }
}

// ---------- 檢查：庫存 ----------
function checkStock(P) {
  if (!exists('stock.js')) { err('找不到 stock.js'); return; }
  let STOCK;
  try { STOCK = runVarsFile('stock.js', ['STOCK']).STOCK; } catch (e) { err(`stock.js 無法執行：${e.message}`); return; }
  if (!STOCK || typeof STOCK !== 'object') { err('stock.js 沒有定義 STOCK 物件'); return; }
  const pnames = P.map((x) => x.n);
  const pset = new Set(pnames);
  const keys = Object.keys(STOCK);
  for (const k of keys) {
    if (!pset.has(k)) {
      const s = suggest(k, pnames);
      err(`stock.js 的品名在商品資料裡找不到：${q(k)}${s ? `　→ 你是不是要寫 ${q(s)}？` : ''}（這筆庫存不會生效）`);
    }
    const v = STOCK[k];
    if (!(v === null || (isInt(v) && v >= 0))) err(`庫存值不合法（只能是 null 或 0 以上的整數）：${q(k)} → ${JSON.stringify(v)}`);
  }
  const kset = new Set(keys);
  for (const n of pnames) {
    if (!kset.has(n)) {
      const s = suggest(n, keys);
      err(`商品沒有庫存設定，會被當成「不限量」：${q(n)}${s ? `　→ stock.js 裡有相近的 ${q(s)}，是不是品名不一致？` : ''}`);
    }
  }
  // 同一個 key 重複（JS 物件後者會蓋掉前者，需讀原始碼才能發現）
  const raw = read('stock.js');
  const seen = new Map();
  for (const m of raw.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) {
    const k = JSON.parse(m[1]);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, c] of seen) if (c > 1) err(`stock.js 同一個品名寫了 ${c} 次（後面的會蓋掉前面的）：${q(k)}`);
  const sold = keys.filter((k) => STOCK[k] === 0).length;
  info.push(`庫存：${keys.length} 筆設定，其中 ${sold} 項售完，${keys.filter((k) => STOCK[k] === null).length} 項不限量`);
}

// ---------- 檢查：折扣碼 ----------
function checkDiscounts(P, TABS) {
  if (!exists('discounts.js')) { warn('找不到 discounts.js（沒有折扣碼功能）'); return; }
  let D;
  try { D = runVarsFile('discounts.js', ['DISCOUNT_SALT', 'DISCOUNTS']); } catch (e) { err(`discounts.js 無法執行：${e.message}`); return; }
  if (!D.DISCOUNTS || typeof D.DISCOUNTS !== 'object') { err('discounts.js 沒有定義 DISCOUNTS 物件'); return; }
  if (!D.DISCOUNT_SALT) warn('DISCOUNT_SALT 是空的，雜湊會更容易被猜');
  const pnames = new Set(P.map((x) => x.n));
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const [k, r] of Object.entries(D.DISCOUNTS)) {
    n++;
    const label = /^[0-9a-f]{64}$/i.test(k) ? `${k.slice(0, 8)}…（${r && r.note ? r.note : '無說明'}）` : `明碼 ${q(k)}`;
    if (/^[0-9a-f]{64}$/i.test(k)) { if (k !== k.toLowerCase()) warn(`${label}：雜湊含大寫字母，建議改小寫`); }
    else warn(`${label}：折扣碼是以明碼存放，公開倉庫任何人都看得到，建議改用 code-tool 產生雜湊`);
    if (!r || typeof r !== 'object') { err(`${label}：設定不是物件`); continue; }
    if (!['fixed', 'percent'].includes(r.type)) err(`${label}：type 只能是 "fixed" 或 "percent"，目前是 ${JSON.stringify(r.type)}`);
    if (!(typeof r.amount === 'number' && r.amount > 0)) err(`${label}：amount 必須是大於 0 的數字`);
    if (r.type === 'percent' && r.amount >= 100) err(`${label}：percent 的 amount 要小於 100（目前 ${r.amount}）`);
    if (r.type === 'fixed' && r.max != null) warn(`${label}：max 只對 percent 有效，fixed 會被忽略`);
    for (const f of ['min', 'max']) if (r[f] != null && !(typeof r[f] === 'number' && r[f] >= 0)) err(`${label}：${f} 必須是 0 以上的數字`);
    for (const f of ['start', 'end']) if (r[f] != null && !isDate(r[f])) err(`${label}：${f} 日期格式要是真實存在的 YYYY-MM-DD，目前是 ${JSON.stringify(r[f])}`);
    if (isDate(r.start || '') && isDate(r.end || '') && r.start > r.end) err(`${label}：start（${r.start}）晚於 end（${r.end}）`);
    if (r.enabled != null && typeof r.enabled !== 'boolean') err(`${label}：enabled 必須是 true 或 false`);
    if (r.type === 'fixed' && r.min != null && r.amount > r.min && r.min > 0) warn(`${label}：折扣 ${r.amount} 大於最低消費 ${r.min}，可能設定有誤`);
    if (r.end && isDate(r.end) && r.end < today && r.enabled !== false) warn(`${label}：已於 ${r.end} 過期，仍是啟用狀態`);
    (r.categories || []).forEach((c) => { if (TABS && !TABS.includes(c)) err(`${label}：categories 的 ${q(c)} 不在分頁清單裡`); });
    (r.items || []).forEach((it) => { if (!pnames.has(it)) err(`${label}：items 的 ${q(it)} 不是現有商品名稱`); });
    if (!r.note) warn(`${label}：沒有 note 說明，之後很難辨認是哪一組`);
  }
  info.push(`折扣碼：${n} 組`);
  // 不該公開的檔案
  for (const f of ['code-tool.html', 'codes.txt', '折扣碼.txt', '折扣碼明碼.txt'])
    if (exists(f)) err(`不應放進公開倉庫的檔案：${f}（內含或可產生折扣碼明碼）`);
}


let d0 = null; // 商品資料（供促銷比對分類用）
function matchCat(x, t, d) {
  const CAT = d.CAT || {}, ALSO = d.ALSO || {};
  return t === '全部' || CAT[x.id] === t || (t === '王品' && x.n.startsWith('王品')) || (ALSO[x.id] || []).includes(t);
}

// ---------- 檢查：促銷 ----------
function checkPromos(P, TABS) {
  if (!exists('promos.js')) return;
  let PR;
  try { PR = runVarsFile('promos.js', ['PROMOS']).PROMOS; } catch (e) { err(`promos.js 無法執行：${e.message}`); return; }
  if (!Array.isArray(PR)) { err('promos.js 沒有定義 PROMOS 陣列'); return; }
  if (!/<script[^>]*src=["']promos\.js["']/.test(read('index.html'))) err('index.html 沒有載入 promos.js，促銷不會生效');
  const pnames = new Set(P.map((x) => x.n));
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const today = new Date().toISOString().slice(0, 10);
  PR.forEach((r, i) => {
    const label = `促銷 #${i + 1}${r && r.label ? `（${r.label}）` : ''}`;
    if (!r || typeof r !== 'object') { err(`${label}：設定不是物件`); return; }
    if (!r.label) warn(`${label}：沒有 label，圖片上的小標會顯示預設文字`);
    if (!(isInt(r.amount) && r.amount > 0)) err(`${label}：amount 必須是大於 0 的整數元，目前是 ${JSON.stringify(r.amount)}`);
    if (!(r.categories && r.categories.length) && !(r.items && r.items.length)) err(`${label}：categories 和 items 都沒寫，沒有任何商品會適用`);
    (r.categories || []).forEach((c) => { if (TABS && !TABS.includes(c)) err(`${label}：categories 的 ${q(c)} 不在分頁清單裡`); });
    (r.items || []).forEach((it) => { if (!pnames.has(it)) err(`${label}：items 的 ${q(it)} 不是現有商品名稱`); });
    for (const f of ['start', 'end']) if (r[f] != null && !isDate(r[f])) err(`${label}：${f} 日期格式要是真實存在的 YYYY-MM-DD，目前是 ${JSON.stringify(r[f])}`);
    if (isDate(r.start || '') && isDate(r.end || '') && r.start > r.end) err(`${label}：start（${r.start}）晚於 end（${r.end}）`);
    if (r.title != null && typeof r.title !== 'string') err(`${label}：title 必須是文字`);
    if (r.period != null && typeof r.period !== 'string') err(`${label}：period 必須是文字`);
    if (r.enabled != null && typeof r.enabled !== 'boolean') err(`${label}：enabled 必須是 true 或 false`);
    if (r.end && isDate(r.end) && r.end < today && r.enabled !== false) warn(`${label}：已於 ${r.end} 過期，仍是啟用狀態`);
    const matched = P.filter((x) => (r.items || []).includes(x.n) || (r.categories || []).some((c) => matchCat(x, c, d0)));
    if (!matched.length) warn(`${label}：目前沒有任何商品符合，這組促銷不會有效果`);
    matched.filter((x) => r.amount >= x.p).forEach((x) => warn(`${label}：折扣 ${r.amount} 元大於等於商品價格，${x.n}（NT$${x.p}）會變成 0 元`));
    info.push(`促銷：${label}，適用 ${matched.length} 項商品`);
  });
}

// ---------- 執行 ----------
const info = [];
let products;
try { products = loadProducts(); } catch (e) { console.error('✗ 無法載入商品資料：' + e.message); process.exit(2); }
info.push(`商品：${products.P.length} 項（來源 ${products.source}）`);
checkProducts(products);
checkStock(products.P);
checkDiscounts(products.P, products.TABS);
d0 = products;
checkPromos(products.P, products.TABS);

console.log(`資料夾：${ROOT}`);
info.forEach((s) => console.log('· ' + s));
if (errors.length) { console.log(`\n✗ 錯誤 ${errors.length} 項`); errors.forEach((m, i) => console.log(`  ${i + 1}. ${m}`)); }
if (warns.length) { console.log(`\n⚠ 警告 ${warns.length} 項`); warns.forEach((m, i) => console.log(`  ${i + 1}. ${m}`)); }
if (!errors.length && !warns.length) console.log('\n✓ 全部通過');
else if (!errors.length) console.log('\n✓ 沒有錯誤' + (STRICT ? '，但 --strict 模式下警告視為失敗' : ''));
process.exit(errors.length || (STRICT && warns.length) ? 1 : 0);
