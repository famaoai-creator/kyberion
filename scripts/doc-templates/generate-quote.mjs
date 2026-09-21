#!/usr/bin/env node
// プロファイル駆動の見積書生成: profile の section_order/ラベルに従い md+html を生成する.
// 使い方:
//   node scripts/doc-templates/generate-quote.mjs --profile <template-id> --input <quote-input.json> --out-dir <dir>
// 金額規則: 明細=税抜単価×数量（1円未満切り捨て）、消費税=小計の10%を四捨五入。price-book と単価突合せ。
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(import.meta.url);
const { readJson } = require('@agent/core/foundation');
const { safeExistsSync, safeMkdir, safeWriteFile } = require('@agent/core/secure-io');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const jpy = (n) => Number(n).toLocaleString('ja-JP');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const profileId = arg('profile');
const inputPath = arg('input');
const outDirArg = arg('out-dir') ?? 'active/shared/tmp/quote-sample';
if (!profileId || !inputPath) {
  console.error(
    'usage: generate-quote.mjs --profile <template-id> --input <quote-input.json> --out-dir <dir>'
  );
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(profileId)) {
  console.error(`invalid profile id: ${profileId}`);
  process.exit(1);
}

const profilePath = path.join(
  ROOT,
  'knowledge/product/sales/doc-templates/profiles',
  `${profileId}.profile.json`
);
if (!safeExistsSync(profilePath)) {
  console.error(`profile not found: ${profileId} (run extract-profile.mjs first)`);
  process.exit(1);
}
const profile = readJson(profilePath);
const inputAbs = path.isAbsolute(inputPath) ? inputPath : path.join(ROOT, inputPath);
if (!safeExistsSync(inputAbs)) {
  console.error(`input not found: ${inputAbs}`);
  process.exit(1);
}
const data = readJson(inputAbs);

// price-book 突合せ
const book = readJson(path.join(ROOT, 'knowledge/product/sales/price-book.json'));
const unitPrices = Object.fromEntries(book.items.map((r) => [r.sku, r.unit_price]));
const mismatches = (data.items ?? [])
  .filter(
    (it) =>
      it.sku &&
      unitPrices[it.sku] !== undefined &&
      Number(it.unit_price_ex_tax) !== unitPrices[it.sku]
  )
  .map((it) => `${it.sku}: input=${it.unit_price_ex_tax} book=${unitPrices[it.sku]}`);
if (mismatches.length) {
  console.error(`price-book mismatch: ${mismatches.join(', ')}`);
  process.exit(1);
}

// 金額計算
if (!Array.isArray(data.items) || data.items.length === 0) {
  console.error('input must contain at least one item');
  process.exit(1);
}
if (!data.recipient || !data.issuer || !Array.isArray(data.notes)) {
  console.error('input must contain recipient, issuer, and notes');
  process.exit(1);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(data.quote_number || ''))) {
  console.error('quote_number must be a safe filename token');
  process.exit(1);
}
let subtotal = 0;
const lines = data.items.map((it, i) => {
  const unitPrice = Number(it.unit_price_ex_tax);
  const quantity = Number(it.quantity);
  if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
    throw new Error(`invalid unit_price_ex_tax at items[${i}]`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error(`invalid quantity at items[${i}]`);
  }
  const amount = Math.floor(unitPrice * quantity);
  subtotal += amount;
  return { n: i + 1, ...it, amount };
});
const tax = Math.round(subtotal * 0.1);
const total = subtotal + tax;

const order = profile.section_order.length
  ? profile.section_order
  : [
      'doc_title',
      'recipient',
      'subject',
      'quote_number',
      'items_table',
      'subtotal',
      'total',
      'notes',
    ];

const mdRows = lines
  .map(
    (l) =>
      `| ${l.n} | ${l.name} | ${l.quantity} | ${l.unit} | ${jpy(l.unit_price_ex_tax)} | ${jpy(l.amount)} | ${l.note ?? ''} |`
  )
  .join('\n');
const mdSections = {
  doc_title: `# 御見積書`,
  recipient: `## 宛先\n\n- ${data.recipient.org} ${data.recipient.title}\n- ${data.recipient.dept} ${data.recipient.contact} 様`,
  subject: `- 件名: ${data.subject}\n- 見積番号: ${data.quote_number}\n- 発行日: ${data.issue_date}\n- 有効期限: ${data.valid_until}`,
  quote_number: null, // subject に統合済み
  issue_date: null,
  valid_until: null,
  issuer_contact: `## 発行者\n\n- ${data.issuer.org}\n- 〒${data.issuer.postal} ${data.issuer.address}\n- TEL: ${data.issuer.phone} / Email: ${data.issuer.email}\n- 担当: ${data.issuer.contact}\n- 適格請求書発行事業者登録番号: ${data.issuer.reg_number}`,
  items_table: `## 明細\n\n| # | 品名 | 数量 | 単位 | 単価(税抜) | 金額(税抜) | 備考 |\n|---|------|------|------|------------|------------|------|\n${mdRows}`,
  subtotal: `- 小計(税抜): ${jpy(subtotal)} 円`,
  tax: `- 消費税(10%): ${jpy(tax)} 円`,
  total: `- 合計(税込): ${jpy(total)} 円`,
  due_date: `- 納期: ${data.due_date}`,
  payment_terms: `- 支払条件: ${data.payment_terms}`,
  payment_method: `- 支払方法: ${data.payment_method} (${data.bank_info})`,
  bank_info: null,
  notes: `## 備考\n\n${data.notes.map((n) => `- ${n}`).join('\n')}`,
  seal_box: `- 押印欄: ________________________`,
  approval_box: `- 承認: ________________________`,
  reg_number: null, // 発行者に統合済み
  item_quantity: null,
  item_unit_price: null,
  item_amount: null,
};
// doc_title/recipient は見出しとして先頭に固定し、残りは profile の順序で出す
const seen = new Set();
const body = [];
for (const key of ['doc_title', 'recipient', ...order]) {
  if (seen.has(key)) continue;
  seen.add(key);
  const s = mdSections[key];
  if (s) body.push(s);
}
const md =
  body.join('\n\n') +
  `\n\n---\n\n> profile: ${profileId}（抽出 ${profile.fields.length} 項目 / 順序継承）・送付前に金額検算と operator 承認が必須です。\n`;

const htmlRows = lines
  .map(
    (l) =>
      `<tr><td>${l.n}</td><td>${esc(l.name)}</td><td>${l.quantity}</td><td>${esc(l.unit)}</td><td>${jpy(l.unit_price_ex_tax)}</td><td>${jpy(l.amount)}</td><td>${esc(l.note ?? '')}</td></tr>`
  )
  .join('');
const htmlDoc = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>御見積書 ${esc(data.quote_number)}</title></head>
<body>
<h1>御見積書</h1>
<p>見積番号: ${esc(data.quote_number)} ／ 発行日: ${esc(data.issue_date)} ／ 有効期限: ${esc(data.valid_until)}</p>
<p>件名: ${esc(data.subject)}</p>
<p>宛先: ${esc(data.recipient.org)} ${esc(data.recipient.title)} ${esc(data.recipient.dept)} ${esc(data.recipient.contact)} 様</p>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr><th>#</th><th>品名</th><th>数量</th><th>単位</th><th>単価(税抜)</th><th>金額(税抜)</th><th>備考</th></tr></thead>
<tbody>${htmlRows}</tbody>
</table>
<p>小計(税抜): ${jpy(subtotal)} 円 ／ 消費税(10%): ${jpy(tax)} 円 ／ <strong>合計(税込): ${jpy(total)} 円</strong></p>
<p>納期: ${esc(data.due_date)} ／ 支払条件: ${esc(data.payment_terms)} ／ 支払方法: ${esc(data.payment_method)}（${esc(data.bank_info)}）</p>
<ul>${data.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
<!-- profile: ${esc(profileId)} / order: ${esc(profile.section_order.join(','))} -->
</body></html>
`;

const outDir = path.isAbsolute(outDirArg) ? outDirArg : path.join(ROOT, outDirArg);
safeMkdir(outDir, { recursive: true });
const mdPath = path.join(outDir, `${data.quote_number}.md`);
const htmlPath = path.join(outDir, `${data.quote_number}.html`);
safeWriteFile(mdPath, md);
safeWriteFile(htmlPath, htmlDoc);
console.log(
  JSON.stringify({
    profile: profileId,
    sections: order,
    subtotal,
    tax,
    total,
    wrote: [path.relative(ROOT, mdPath), path.relative(ROOT, htmlPath)],
  })
);
