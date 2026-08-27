import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

const DOCUMENT_ROOTS = ['docs', 'knowledge'] as const;
const MARKDOWN_LINK = /\]\((<[^>]+>|[^)\s]+)(?:\s+['"][^'"]*['"])?\)/gu;

function markdownFiles(): string[] {
  const files = DOCUMENT_ROOTS.flatMap((root) =>
    safeExistsSync(pathResolver.rootResolve(root))
      ? getAllFiles(pathResolver.rootResolve(root)).filter((filePath) => filePath.endsWith('.md'))
      : []
  );
  for (const name of safeReaddir(pathResolver.rootDir())) {
    if (name.endsWith('.md')) files.push(pathResolver.rootResolve(name));
  }
  return [...new Set(files)].sort();
}

function isExternalReference(value: string): boolean {
  return (
    value.startsWith('#') ||
    value.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.startsWith('//')
  );
}

const ROOT_RELATIVE_PREFIXES = [
  'docs/',
  'knowledge/',
  'pipelines/',
  'schemas/',
  'active/',
  'libs/',
  'scripts/',
  'satellites/',
  'presence/',
  '.github/',
];

function isVendoredDocumentation(sourcePath: string): boolean {
  return path
    .relative(pathResolver.rootDir(), sourcePath)
    .startsWith('knowledge/public/external-wisdom/');
}

export function resolveDocumentationTargets(sourcePath: string, target: string): string[] {
  const isExplicitRootReference =
    ROOT_RELATIVE_PREFIXES.some((prefix) => target.startsWith(prefix)) ||
    ['AGENTS.md', 'README.md', 'CAPABILITIES_GUIDE.md'].includes(target);
  const resolved = isExplicitRootReference
    ? pathResolver.rootResolve(target)
    : path.resolve(path.dirname(sourcePath), target);
  return [resolved];
}

export function checkDocumentationLinks(files = markdownFiles()): string[] {
  const failures: string[] = [];
  for (const filePath of files) {
    if (isVendoredDocumentation(filePath)) continue;
    const source = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
    const relativeSource = path.relative(pathResolver.rootDir(), filePath);
    for (const match of source.matchAll(MARKDOWN_LINK)) {
      // Image examples in theme guides are illustrative asset names, not
      // repository navigation links.
      if (match.index !== undefined && match.index > 0 && source[match.index - 1] === '!') continue;
      const rawTarget = match[1] || '';
      const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
      const targetPath = target.split('#', 1)[0]?.split('?', 1)[0] || '';
      const openingBracket = match.index === undefined ? -1 : source.lastIndexOf('[', match.index);
      if (openingBracket > 0 && source[openingBracket - 1] === '!') continue;
      if (
        !targetPath ||
        targetPath === '../active/INDEX.volatile.md' ||
        isExternalReference(targetPath) ||
        (!targetPath.includes('/') && !path.extname(targetPath))
      )
        continue;
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(targetPath);
      } catch {
        failures.push(`${relativeSource}: invalid encoded link ${target}`);
        continue;
      }
      const candidates = resolveDocumentationTargets(filePath, decodedTarget);
      if (
        !candidates.some((candidate) =>
          candidate.includes('/knowledge/personal/') ||
          candidate.includes('/knowledge/confidential/')
            ? true
            : safeExistsSync(candidate)
        )
      ) {
        failures.push(`${relativeSource}: broken relative link ${target}`);
      }
    }
  }
  return failures;
}

export const runCheckDocumentationLinks = defineScript({
  name: 'check:documentation-links',
  flags: [],
  run(context) {
    const failures = checkDocumentationLinks();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`- ${failure}`);
      throw new Error(`${failures.length} documentation link violation(s)`);
    }
    context.print(`[check:documentation-links] OK (${markdownFiles().length} documents)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_documentation_links.ts') ||
  isDirectScript(import.meta.url, 'check_documentation_links.js')
)
  void runCheckDocumentationLinks();
