#!/usr/bin/env node
/**
 * CU-05: one-line deprecation notice for a renamed package script. The alias
 * keeps working (`"old": "node scripts/deprecated_script_alias.mjs old new && <new command>"`);
 * this only tells the operator the new name, on stderr so stdout stays clean.
 *
 * Bootstrap-class script: it runs before `pnpm build`, so it cannot load
 * @agent/core. It imports the user-facing vocabulary catalog as JSON (en/ja,
 * chosen from KYBERION_LOCALE, then LANG; falls back to en).
 */
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ENGLISH =
  '[deprecated] `pnpm {old}` is renamed to `pnpm {new}`; the old name still works for now.';
const CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../knowledge/product/orchestration/user-facing-vocabulary.json'
);

/** @param {NodeJS.ProcessEnv} env */
export function resolveAliasLocale(env) {
  const raw = env.KYBERION_LOCALE || env.KYBERION_UI_LOCALE || env.LANG || '';
  return /^ja/iu.test(raw) ? 'ja' : 'en';
}

/** @param {string} oldName @param {string} newName @param {NodeJS.ProcessEnv} [env] */
export async function formatDeprecatedScriptNotice(oldName, newName, env = process.env) {
  let template = ENGLISH;
  try {
    const catalog = createRequire(import.meta.url)(CATALOG);
    const entry = catalog?.domains?.cli?.cli_deprecated_script;
    template = entry?.[resolveAliasLocale(env)] ?? entry?.en ?? ENGLISH;
  } catch {
    // catalog unreadable: keep the English fallback
  }
  return template.replaceAll('{old}', oldName).replaceAll('{new}', newName);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [oldName, newName] = process.argv.slice(2);
  if (oldName && newName) console.error(await formatDeprecatedScriptNotice(oldName, newName));
}
