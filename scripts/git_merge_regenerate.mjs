#!/usr/bin/env node
/**
 * Git merge driver "kyberion-regenerate" (GF-03) for tracked generated files
 * (see .gitattributes). Optional: the repository owner installs it once with
 * `pnpm kyberion resolve install-driver` (scripts/install_git_merge_driver.mjs),
 * which sets:
 *
 *   [merge "kyberion-regenerate"]
 *     driver = node scripts/git_merge_regenerate.mjs %O %A %B %P
 *
 * Without it git does its normal text merge (conflict markers), and
 * `pnpm kyberion resolve generated` runs the same strategies after the fact
 * from the index conflict stages: `node scripts/git_merge_regenerate.mjs
 * --from-index <path>` (stage :1: base, :2: ours, :3: theirs).
 *
 * Bootstrap-class like kyberion_cli_entry.mjs: git runs it mid-merge, before
 * any build, so it uses node:fs / node:child_process directly and never
 * @agent/core. A driver cannot safely run the generators mid-merge (the rest
 * of the tree may still be conflicted), so it only makes the merge succeed
 * with a valid file and leaves regeneration to
 * `pnpm kyberion resolve generated`; the freshness gates catch a missed run.
 *
 * Strategies by path:
 * - derived files (default): ordinary 3-way text merge; on conflict keep our
 *   side unchanged (valid content, never conflict markers) — regeneration
 *   rebuilds it from the merged sources anyway.
 * - env-registry.json (curated + generated): 3-way merge of `entries` keyed by
 *   `name` (plus top-level fields). Only a real curated conflict — the same
 *   entry or field changed differently on both sides — falls back to a normal
 *   conflict with markers, because keeping one side would silently drop the
 *   other side's curated description.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENTRY_MERGED_PATHS = new Set(['knowledge/product/governance/env-registry.json']);

function textMerge(ours, base, theirs) {
  try {
    const merged = execFileSync('git', ['merge-file', '-p', '--quiet', ours, base, theirs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { clean: true, content: merged };
  } catch {
    return { clean: false };
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 3-way pick for one value; `conflict` when both sides changed it differently. */
function pick(base, ours, theirs) {
  if (same(ours, theirs)) return { value: ours };
  if (same(ours, base)) return { value: theirs };
  if (same(theirs, base)) return { value: ours };
  return { conflict: true };
}

/**
 * Merge `{ ...fields, entries: [{ name, ... }] }` documents. Returns the merged
 * document, or `null` when a field or entry conflicts. `undefined` values mean
 * "absent" (added or deleted on one side).
 */
export function mergeNamedEntries(base, ours, theirs) {
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (key === 'entries') continue;
    const result = pick(base[key], ours[key], theirs[key]);
    if (result.conflict) return null;
    if (result.value !== undefined) merged[key] = result.value;
  }
  const byName = (doc) => new Map((doc.entries || []).map((entry) => [entry.name, entry]));
  const [baseEntries, ourEntries, theirEntries] = [byName(base), byName(ours), byName(theirs)];
  const entries = [];
  for (const name of new Set([...ourEntries.keys(), ...theirEntries.keys()])) {
    const result = pick(baseEntries.get(name), ourEntries.get(name), theirEntries.get(name));
    if (result.conflict) return null;
    if (result.value !== undefined) entries.push(result.value);
  }
  // Same comparator as scripts/generate_env_registry.ts, so a merge followed by
  // regeneration on the same machine produces no reorder diff.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { ...merged, entries };
}

async function formatJson(value, path) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(path)) ?? {};
    return await prettier.format(text, { ...config, parser: 'json' });
  } catch {
    return text;
  }
}

/** Merge three JSON texts; an absent side (`null`, e.g. no base) is an empty document. */
async function entryMergeText(base, ours, theirs, path) {
  try {
    const doc = (text) => (text === null ? {} : JSON.parse(text));
    const merged = mergeNamedEntries(doc(base), doc(ours), doc(theirs));
    return merged ? { clean: true, content: await formatJson(merged, path) } : { clean: false };
  } catch {
    return { clean: false };
  }
}

async function entryMerge(base, ours, theirs, path) {
  const read = (file) => readFileSync(file, 'utf8');
  return entryMergeText(read(base), read(ours), read(theirs), path);
}

function gitText(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve an unmerged path in the work tree from its index stages, with the
 * same strategy the driver would have used. Returns 0 when the work-tree file
 * now holds valid content (the caller regenerates and stages it), 1 when a
 * curated conflict needs a human (the file is left untouched).
 */
export async function resolveFromIndex(path) {
  const [base, ours, theirs] = [1, 2, 3].map((stage) => gitText(['show', `:${stage}:${path}`]));
  if (ours === null || theirs === null) {
    console.error(`kyberion-regenerate: ${path} is not a two-sided conflict; resolve it manually.`);
    return 1;
  }
  if (ENTRY_MERGED_PATHS.has(path)) {
    const result = await entryMergeText(base, ours, theirs, path);
    if (!result.clean) {
      console.error(
        `kyberion-regenerate: ${path} has a curated conflict (same entry changed on both sides); edit the conflict markers by hand, keeping both descriptions where they differ.`
      );
      return 1;
    }
    writeFileSync(path, result.content);
    return 0;
  }
  // Derived files: clean text merge, else our side. Regeneration overwrites it.
  const merged =
    base === null
      ? null
      : gitText([
          'merge-file',
          '-p',
          '--quiet',
          '--object-id',
          `:2:${path}`,
          `:1:${path}`,
          `:3:${path}`,
        ]);
  writeFileSync(path, merged ?? ours);
  return 0;
}

export async function runMergeDriver([base, ours, theirs, path]) {
  const curated = ENTRY_MERGED_PATHS.has(path);
  const result = curated
    ? await entryMerge(base, ours, theirs, path)
    : textMerge(ours, base, theirs);
  if (result.clean) {
    writeFileSync(ours, result.content);
    return 0;
  }
  if (curated) {
    // Leave git's usual conflict markers in place for a human decision.
    try {
      execFileSync('git', ['merge-file', ours, base, theirs], { stdio: 'ignore' });
    } catch {
      // merge-file exits non-zero on conflicts; the markers are written anyway.
    }
    console.error(
      `kyberion-regenerate: ${path} has a curated conflict (same entry changed on both sides); resolve it, then run 'pnpm kyberion resolve generated'.`
    );
    return 1;
  }
  console.error(
    `kyberion-regenerate: ${path} conflicted; kept our side. Run 'pnpm kyberion resolve generated' after the merge.`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exitCode =
    args[0] === '--from-index' ? await resolveFromIndex(args[1]) : await runMergeDriver(args);
}
