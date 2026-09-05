import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const IMPROVEMENT_PLAN_ROOT = 'docs/developer/improvement-plans-2026-08';
export const IMPROVEMENT_PLAN_ROOTS = [
  {
    root: 'docs/developer/improvement-plans-2026-07',
    tag: '2026-07',
    last_updated: '2026-07-31',
    default_status: 'archived' as const,
  },
  {
    root: 'docs/developer/improvement-plans-archive/2026-07',
    tag: 'archived',
    last_updated: '2026-08-26',
    default_status: 'archived' as const,
  },
  {
    root: 'docs/developer/improvement-plans-2026-08',
    tag: '2026-08',
    last_updated: '2026-08-26',
    default_status: 'active' as const,
  },
  {
    root: 'docs/developer/improvement-plans-archive',
    tag: 'archived',
    last_updated: '2026-08-26',
    default_status: 'archived' as const,
  },
] as const;
const REQUIRED_KEYS = ['title', 'tags', 'last_updated', 'status'] as const;

export interface PlanMetadata {
  title: string;
  tags: string[];
  last_updated: string;
  status: 'planned' | 'active' | 'partial' | 'completed' | 'archived';
}

export interface PlanFrontmatterDefaults {
  tag?: string;
  last_updated?: string;
  status?: PlanMetadata['status'];
}

function read(filePath: string): string {
  return readTextFile(filePath);
}

export function parseFrontmatter(markdown: string): Record<string, string> | null {
  if (!markdown.startsWith('---\n')) return null;
  const end = markdown.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  let inMultilineTags = false;
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match) {
      fields[match[1]] = match[2].trim();
      inMultilineTags = match[1] === 'tags' && match[2].trim() === '';
      if (inMultilineTags) fields.tags = '[multiline]';
      continue;
    }
    if (inMultilineTags && line.includes(']')) inMultilineTags = false;
  }
  return fields;
}

export function addPlanFrontmatter(
  markdown: string,
  title: string,
  lastUpdated = '2026-08-25',
  defaults: PlanFrontmatterDefaults = {}
): string {
  if (parseFrontmatter(markdown)) return markdown;
  const cleanTitle = title
    .replace(/\.ja\.md$/u, '')
    .replace(/[_-]+/gu, ' ')
    .trim();
  const header = [
    '---',
    `title: ${cleanTitle}`,
    `tags: [improvement-plan, ${defaults.tag || '2026-08'}]`,
    `last_updated: ${defaults.last_updated || lastUpdated}`,
    `status: ${defaults.status || 'active'}`,
    '---',
    '',
  ].join('\n');
  return `${header}${markdown}`;
}

function normalizeStatus(value: string | undefined): PlanMetadata['status'] {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    normalized === 'completed' ||
    normalized === 'implemented' ||
    normalized === 'implemented-reviewed' ||
    normalized === 'implemented-and-verified'
  )
    return 'completed';
  if (normalized === 'archived') return 'archived';
  if (normalized === 'partial' || normalized === 'accepted-with-follow-ups') return 'partial';
  if (normalized === 'planned') return 'planned';
  return 'active';
}

export function normalizePlanFrontmatter(
  markdown: string,
  title: string,
  lastUpdated = '2026-08-25',
  defaults: PlanFrontmatterDefaults = {}
): string {
  if (!parseFrontmatter(markdown))
    return addPlanFrontmatter(markdown, title, lastUpdated, defaults);
  const end = markdown.indexOf('\n---\n', 4);
  const header = markdown.slice(0, end);
  const fields = parseFrontmatter(markdown) || {};
  const additions: string[] = [];
  if (!fields.title)
    additions.push(
      `title: ${title
        .replace(/\.ja\.md$/u, '')
        .replace(/[_-]+/gu, ' ')
        .trim()}`
    );
  if (!fields.tags) additions.push(`tags: [improvement-plan, ${defaults.tag || '2026-08'}]`);
  if (!fields.last_updated) additions.push(`last_updated: ${defaults.last_updated || lastUpdated}`);
  const normalizedStatus = normalizeStatus(fields.status || defaults.status);
  let normalizedHeader = header.replace(/^status:\s*.*$/mu, `status: ${normalizedStatus}`);
  if (!fields.status) additions.push(`status: ${normalizedStatus}`);
  if (additions.length) normalizedHeader = `${normalizedHeader}\n${additions.join('\n')}`;
  return `${normalizedHeader}\n---${markdown.slice(end + '\n---'.length)}`;
}

export function listImprovementPlans(rootDir?: string): string[] {
  const roots = rootDir
    ? [rootDir]
    : IMPROVEMENT_PLAN_ROOTS.map((entry) => pathResolver.rootResolve(entry.root));
  return roots
    .flatMap((root) => getAllFiles(root))
    .filter((filePath) => filePath.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function defaultsForPlan(filePath: string): PlanFrontmatterDefaults {
  const relative = path.relative(pathResolver.rootDir(), filePath).replace(/\\/g, '/');
  const entry = IMPROVEMENT_PLAN_ROOTS.find((candidate) =>
    relative.startsWith(`${candidate.root}/`)
  );
  return entry
    ? { tag: entry.tag, last_updated: entry.last_updated, status: entry.default_status }
    : {};
}

export function checkImprovementPlanMetadata(): string[] {
  const failures: string[] = [];
  for (const filePath of listImprovementPlans()) {
    const metadata = parseFrontmatter(read(filePath));
    const relative = path.relative(pathResolver.rootDir(), filePath);
    if (!metadata) {
      failures.push(`${relative}: missing YAML frontmatter`);
      continue;
    }
    for (const key of REQUIRED_KEYS) {
      if (!metadata[key]) failures.push(`${relative}: missing frontmatter key ${key}`);
    }
    if (
      metadata.status &&
      !/^(planned|active|partial|completed|archived)$/u.test(metadata.status)
    ) {
      failures.push(`${relative}: invalid status ${metadata.status}`);
    }
  }
  return failures;
}

export const runCheckImprovementPlanMetadata = defineScript({
  name: 'check:improvement-plan-metadata',
  flags: [],
  run(context) {
    const files = listImprovementPlans();
    if (context.argv.includes('--fix')) {
      for (const filePath of files) {
        const current = read(filePath);
        const next = normalizePlanFrontmatter(
          current,
          path.basename(filePath),
          undefined,
          defaultsForPlan(filePath)
        );
        if (next !== current) {
          withExecutionContext(
            'ecosystem_architect',
            () => safeWriteFile(filePath, next),
            'ecosystem_architect'
          );
        }
      }
    }
    const failures = checkImprovementPlanMetadata();
    if (failures.length) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    context.print(`[check:improvement-plan-metadata] OK (${files.length} documents)`);
    return { failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_improvement_plan_metadata.ts') ||
  isDirectScript(import.meta.url, 'check_improvement_plan_metadata.js')
)
  void runCheckImprovementPlanMetadata();
