#!/usr/bin/env node
// 文書テンプレート登録: PDF/DOCX/XLSX を正本として registry に登録する.
// 使い方:
//   node scripts/doc-templates/register.mjs --source <path> --name <template-id> --kind quotation|contract|invoice [--force]
// 保存先: knowledge/product/sales/doc-templates/sources/<id>.<ext>
// 台帳:   knowledge/product/sales/doc-templates/registry.json
// ※ 個人情報を含む得意先固有版は confidential/{tenant}/templates/ に置くこと. ここは共通雛形のみ.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readJson } = require('@agent/core/foundation');
const {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} = require('@agent/core/secure-io');

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const REG_DIR = path.join(ROOT, 'knowledge/product/sales/doc-templates');
const SOURCES = path.join(REG_DIR, 'sources');
const REGISTRY = path.join(REG_DIR, 'registry.json');

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const ALLOWED_EXT = new Set(['.pdf', '.docx', '.xlsx']);
const ALLOWED_KIND = new Set(['quotation', 'contract', 'invoice']);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const source = arg('source');
const name = arg('name');
const kind = arg('kind') ?? 'quotation';
const force = process.argv.includes('--force');

if (!source || !name) {
  console.error(
    'usage: register.mjs --source <path> --name <template-id> --kind quotation|contract|invoice [--force]'
  );
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
  console.error(`invalid template id: ${name} (use kebab-case)`);
  process.exit(1);
}
if (!ALLOWED_KIND.has(kind)) {
  console.error(`invalid kind: ${kind}`);
  process.exit(1);
}
const abs = path.isAbsolute(source) ? source : path.join(ROOT, source);
if (!safeExistsSync(abs)) {
  console.error(`source not found: ${abs}`);
  process.exit(1);
}
if (
  isWithin(abs, path.join(ROOT, 'knowledge', 'personal')) ||
  isWithin(abs, path.join(ROOT, 'knowledge', 'confidential'))
) {
  console.error(
    'refusing to promote personal/confidential material into the shared template catalog'
  );
  process.exit(1);
}
const ext = path.extname(abs).toLowerCase();
if (!ALLOWED_EXT.has(ext)) {
  console.error(`unsupported extension: ${ext} (allowed: .pdf .docx .xlsx)`);
  process.exit(1);
}

safeMkdir(SOURCES, { recursive: true });
const dest = path.join(SOURCES, `${name}${ext}`);
if (safeExistsSync(dest) && !force) {
  console.error(`already registered: ${dest} (use --force to overwrite)`);
  process.exit(1);
}
const bytes = safeReadFile(abs, { encoding: null });
const sha256 = createHash('sha256').update(bytes).digest('hex');
safeCopyFileSync(abs, dest);

let registry = [];
if (safeExistsSync(REGISTRY)) {
  registry = readJson(REGISTRY);
}
const entry = {
  id: name,
  kind,
  file: path.relative(ROOT, dest),
  sha256,
  bytes: bytes.length,
  registered_at: new Date(Date.now()).toISOString(),
  profile: `knowledge/product/sales/doc-templates/profiles/${name}.profile.json`,
};
registry = registry.filter((r) => r.id !== name);
registry.push(entry);
safeWriteFile(REGISTRY, JSON.stringify(registry, null, 2) + '\n');

console.log(
  JSON.stringify({ registered: entry.file, sha256: sha256.slice(0, 16), bytes: bytes.length })
);
