#!/usr/bin/env node
/**
 * Extract a single release section from CHANGELOG.md.
 *
 * Used by the release workflow to publish the notes for the tag that
 * triggered the run.
 */

import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

interface Args {
  ref: string;
  input: string;
  output?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  let ref = '';
  let input = 'CHANGELOG.md';
  let output: string | undefined;

  if (argv.includes('--help') || argv.includes('-h')) {
    return { ref: '', input, output, help: true };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref') {
      ref = argv[++i] || '';
    } else if (arg === '--input') {
      input = argv[++i] || input;
    } else if (arg === '--output') {
      output = argv[++i];
    }
  }

  if (!ref) {
    throw new Error('Missing required --ref <tag-or-version>');
  }

  return { ref, input, output };
}

function printUsage(print: Print): void {
  print(
    'Usage: pnpm extract-changelog-section --ref <tag-or-version> [--input CHANGELOG.md] [--output <file>]'
  );
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^v/i, '');
}

function resolveInputPath(filePath: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(filePath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`CHANGELOG must be an existing regular file: ${filePath}`);
  }
  return resolved;
}

function resolveOutputPath(filePath: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(filePath), {
    allowMissingLeaf: true,
  });
}

function extractReleaseSection(changelog: string, ref: string): string {
  const target = normalizeRef(ref);
  const lines = changelog.split(/\r?\n/);
  const headingPrefix = '## [';
  let startIndex = -1;
  let endIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith(headingPrefix)) continue;
    const match = line.match(/^## \[([^\]]+)\]/);
    if (!match) continue;
    const label = match[1];
    if (label === target || label === `v${target}` || normalizeRef(label) === target) {
      startIndex = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith(headingPrefix)) {
          endIndex = j;
          break;
        }
      }
      break;
    }
  }

  if (startIndex === -1) {
    throw new Error(`Could not find release section for "${ref}" in CHANGELOG.md`);
  }

  return lines.slice(startIndex, endIndex).join('\n').trimEnd() + '\n';
}

function main(argv: string[], print: Print = () => undefined): void {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage(print);
    return;
  }
  const changelogPath = resolveInputPath(args.input);

  const changelog = safeReadFile(changelogPath, { encoding: 'utf8' }) as string;
  const section = extractReleaseSection(changelog, args.ref);

  if (args.output) {
    safeWriteFile(resolveOutputPath(args.output), section, { encoding: 'utf8' });
    print(`✅ wrote release notes to ${args.output}`);
    return;
  }

  // defineScript's printer appends one line ending, so avoid duplicating the
  // extractor's canonical trailing line ending in the rendered CLI output.
  print(section.trimEnd());
}

if (
  isDirectScript(import.meta.url, 'extract_changelog_section.ts') ||
  isDirectScript(import.meta.url, 'extract_changelog_section.js')
)
  void defineScript({
    name: 'extract:changelog-section',
    flags: [],
    run(context) {
      return main(context.argv, context.print);
    },
  })();

export { extractReleaseSection, normalizeRef, resolveInputPath, resolveOutputPath };
