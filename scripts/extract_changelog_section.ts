#!/usr/bin/env node
/**
 * Extract a single release section from CHANGELOG.md.
 *
 * Used by the release workflow to publish the notes for the tag that
 * triggered the run.
 */

import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';

interface Args {
  ref: string;
  input: string;
  output?: string;
}

function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  let ref = '';
  let input = 'CHANGELOG.md';
  let output: string | undefined;

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

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^v/i, '');
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

function main(): void {
  const args = parseArgs();
  const changelogPath = pathResolver.rootResolve(args.input);
  if (!safeExistsSync(changelogPath)) {
    throw new Error(`CHANGELOG not found: ${path.relative(pathResolver.rootDir(), changelogPath)}`);
  }

  const changelog = safeReadFile(changelogPath, { encoding: 'utf8' }) as string;
  const section = extractReleaseSection(changelog, args.ref);

  if (args.output) {
    safeWriteFile(args.output, section, { encoding: 'utf8' });
    console.log(`✅ wrote release notes to ${args.output}`);
    return;
  }

  process.stdout.write(section);
}

const isDirect = process.argv[1] && /extract_changelog_section\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main();
}

export { extractReleaseSection, normalizeRef };
