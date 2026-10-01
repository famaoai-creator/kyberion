#!/usr/bin/env node
/**
 * CU-05: one-line deprecation notice for a renamed package script. The alias
 * keeps working (`"old": "node scripts/deprecated_script_alias.mjs old new && <new command>"`);
 * this only tells the operator the new name, on stderr so stdout stays clean.
 */
const [oldName, newName] = process.argv.slice(2);
if (oldName && newName) {
  console.error(
    `[deprecated] \`pnpm ${oldName}\` is renamed to \`pnpm ${newName}\`; the old name still works for now.`
  );
}
