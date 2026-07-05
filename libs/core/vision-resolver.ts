import * as path from 'node:path';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export type VisionSectionKey = 'soul' | 'steering' | 'destination';

export interface ResolvedVision {
  tenant_slug: string | null;
  source_path: string;
  source_kind: 'customer' | 'tenant' | 'global';
  title: string | null;
  raw: string;
  sections: Record<VisionSectionKey, string[]>;
}

export const GOLDEN_RULE_PRIORITY = [
  'logical_integrity',
  'vision_alignment',
  'execution_speed',
  'adaptive_resilience',
] as const;

export type GoldenRulePriority = (typeof GOLDEN_RULE_PRIORITY)[number];

const SECTION_ALIASES: Record<VisionSectionKey, RegExp[]> = {
  soul: [/^soul\b/i, /\bidentity\b/i, /\bmission\b/i, /存在意義/, /使命/],
  steering: [
    /^steering\b/i,
    /\bgolden rule\b/i,
    /\bdecision\b/i,
    /意思決定/,
    /優先順位/,
    /guidance/i,
  ],
  destination: [
    /^destination\b/i,
    /\bvision\b/i,
    /\bnorth star\b/i,
    /長期ビジョン/,
    /将来像/,
    /purpose/i,
  ],
};

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function normalizeSectionKey(title: string): VisionSectionKey | null {
  const normalized = title.trim();
  for (const [key, patterns] of Object.entries(SECTION_ALIASES) as [VisionSectionKey, RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(normalized))) return key;
  }
  return null;
}

function buildCandidatePaths(
  tenantSlug: string | null,
  rootDir?: string
): Array<{
  path: string;
  kind: ResolvedVision['source_kind'];
}> {
  const baseDir = resolveBaseDir(rootDir);
  const candidates: Array<{ path: string; kind: ResolvedVision['source_kind'] }> = [];

  if (tenantSlug) {
    candidates.push({
      path: path.join(baseDir, 'customer', tenantSlug, 'vision.md'),
      kind: 'customer',
    });
    candidates.push({
      path: path.join(baseDir, 'knowledge', 'tenants', tenantSlug, 'vision.md'),
      kind: 'tenant',
    });
  }

  candidates.push({
    path: path.join(baseDir, 'vision', '_default.md'),
    kind: 'global',
  });

  if (baseDir !== pathResolver.rootDir()) {
    candidates.push({
      path: pathResolver.vision('_default.md'),
      kind: 'global',
    });
  }

  return candidates;
}

function extractTitleAndSections(raw: string): {
  title: string | null;
  sections: Record<VisionSectionKey, string[]>;
} {
  const sections: Record<VisionSectionKey, string[]> = {
    soul: [],
    steering: [],
    destination: [],
  };
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let title: string | null = null;
  let currentSection: VisionSectionKey | null = null;
  let currentBuffer: string[] = [];

  const flush = () => {
    if (!currentSection) {
      currentBuffer = [];
      return;
    }
    const text = currentBuffer
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) sections[currentSection].push(text);
    currentBuffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)?.[1]?.trim();
    if (heading) {
      flush();
      if (!title) title = heading;
      currentSection = normalizeSectionKey(heading);
      continue;
    }

    if (!line.trim()) {
      if (currentBuffer.length > 0) currentBuffer.push('');
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      currentBuffer.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim());
      continue;
    }

    currentBuffer.push(line.trim());
  }

  flush();

  return { title, sections };
}

function readResolvedVision(filePath: string): string | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return safeReadFile(filePath, { encoding: 'utf8' }) as string;
  } catch {
    return null;
  }
}

function normalizeGoldenRulePriority(value: string): GoldenRulePriority | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (GOLDEN_RULE_PRIORITY as readonly string[]).includes(normalized)
    ? (normalized as GoldenRulePriority)
    : null;
}

export function compareGoldenRulePriority(left: string, right: string): number {
  const leftIndex = GOLDEN_RULE_PRIORITY.indexOf(
    normalizeGoldenRulePriority(left) || 'logical_integrity'
  );
  const rightIndex = GOLDEN_RULE_PRIORITY.indexOf(
    normalizeGoldenRulePriority(right) || 'logical_integrity'
  );
  return leftIndex - rightIndex;
}

export function resolveGoldenRulePriorityOrder(
  resolvedVision?: ResolvedVision | null
): GoldenRulePriority[] {
  const order = [...GOLDEN_RULE_PRIORITY];
  if (!resolvedVision) return order;

  const text = [resolvedVision.title || '', ...resolvedVision.sections.steering, resolvedVision.raw]
    .join('\n')
    .toLowerCase();
  const weights: Array<[GoldenRulePriority, string[]]> = [
    ['logical_integrity', ['logical integrity', 'integrity']],
    ['vision_alignment', ['vision alignment', 'alignment']],
    ['execution_speed', ['execution speed', 'speed']],
    ['adaptive_resilience', ['adaptive resilience', 'resilience']],
  ];
  if (!weights.some(([, needles]) => needles.some((needle) => text.includes(needle)))) {
    return order;
  }

  return order.sort((left, right) => compareGoldenRulePriority(left, right));
}

export function resolveVision(tenantSlug?: string | null, rootDir?: string): ResolvedVision {
  const resolvedTenantSlug = tenantSlug?.trim() || customerResolver.activeCustomer() || null;
  const candidates = buildCandidatePaths(resolvedTenantSlug, rootDir);

  for (const candidate of candidates) {
    const raw = readResolvedVision(candidate.path);
    if (raw == null) continue;
    const { title, sections } = extractTitleAndSections(raw);
    return {
      tenant_slug: resolvedTenantSlug,
      source_path: candidate.path,
      source_kind: candidate.kind,
      title,
      raw,
      sections,
    };
  }

  const fallback = candidates[candidates.length - 1];
  return {
    tenant_slug: resolvedTenantSlug,
    source_path: fallback?.path || pathResolver.vision('_default.md'),
    source_kind: fallback?.kind || 'global',
    title: null,
    raw: '',
    sections: {
      soul: [],
      steering: [],
      destination: [],
    },
  };
}
