/**
 * Companion Hub helpers for Presence Studio Learn / Discover pages.
 * Keeps catalog loading and discover drafts out of the huge runtime-data module.
 */
import * as path from 'node:path';
import { nowIso, parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';

export type CompanionLearnCatalog = {
  version: string;
  title?: string;
  description?: string;
  gallery: Array<{
    id: string;
    title: string;
    summary: string;
    kind: string;
    related?: string[];
    try_hint?: string;
  }>;
  guides: Array<{
    id: string;
    title: string;
    audience: string;
    steps: string[];
    doc?: string;
  }>;
};

export type DiscoverRequirementItem = {
  id: string;
  label: string;
  checked: boolean;
  note?: string;
};

export type DiscoverDraft = {
  version: 1;
  scenario: 'web_app_build';
  site_url: string;
  notes: string;
  requirements: DiscoverRequirementItem[];
  updated_at: string;
  alignment_hint: string;
};

export const DEFAULT_WEB_APP_REQUIREMENTS: DiscoverRequirementItem[] = [
  { id: 'audience', label: 'Who is the primary audience?', checked: false },
  { id: 'job', label: 'What job should the site do in one sentence?', checked: false },
  { id: 'pages', label: 'Which pages or flows are must-have for v1?', checked: false },
  { id: 'brand', label: 'Brand / visual direction (or examples) confirmed?', checked: false },
  { id: 'content', label: 'Where does content come from?', checked: false },
  { id: 'integrations', label: 'Any external services (auth, payments, CRM)?', checked: false },
  { id: 'success', label: 'How will we know the site succeeded?', checked: false },
];

const CATALOG_RELATIVE = 'product/orchestration/companion-learn-catalog.json';

export function loadCompanionLearnCatalog(): CompanionLearnCatalog {
  const catalogPath = pathResolver.knowledge(CATALOG_RELATIVE);
  const raw = readTextFile(catalogPath);
  const parsed = parseSafeJsonInput(raw, 'companion learn catalog') as CompanionLearnCatalog;
  if (!parsed || !Array.isArray(parsed.gallery) || !Array.isArray(parsed.guides)) {
    throw new Error('companion learn catalog has an unsupported shape');
  }
  return parsed;
}

export function discoverDraftDir(): string {
  return pathResolver.sharedTmp('companion-discover');
}

function safeScopeSegment(value: string, fallback: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || fallback;
}

export function discoverScopeKey(input: {
  principalId: string;
  tenantSlugs: string[] | 'all';
}): string {
  const tenant = input.tenantSlugs === 'all' ? 'all' : [...input.tenantSlugs].sort().join('_');
  return `${safeScopeSegment(tenant, 'unscoped')}__${safeScopeSegment(input.principalId, 'unknown')}`;
}

export function discoverDraftPath(sessionId = 'current', scopeKey = 'default'): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'current';
  return path.join(discoverDraftDir(), safeScopeSegment(scopeKey, 'default'), `${safeId}.json`);
}

export function buildDiscoverDraft(input: {
  site_url?: string;
  notes?: string;
  requirements?: DiscoverRequirementItem[];
}): DiscoverDraft {
  const siteUrl = String(input.site_url || '').trim();
  if (siteUrl) {
    let parsed: URL;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw new Error('site_url must be a valid HTTP(S) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('site_url must use http or https');
    }
  }
  const requirements =
    Array.isArray(input.requirements) && input.requirements.length > 0
      ? input.requirements.map((item) => ({
          id: String(item.id || ''),
          label: String(item.label || ''),
          checked: Boolean(item.checked),
          ...(typeof item.note === 'string' && item.note ? { note: item.note } : {}),
        }))
      : DEFAULT_WEB_APP_REQUIREMENTS.map((item) => ({ ...item }));

  return {
    version: 1,
    scenario: 'web_app_build',
    site_url: siteUrl,
    notes: String(input.notes || '').trim(),
    requirements,
    updated_at: nowIso(),
    alignment_hint:
      'Confirm this draft in the mission alignment gate (report-review :8137) before building.',
  };
}

export function saveDiscoverDraft(
  input: {
    site_url?: string;
    notes?: string;
    requirements?: DiscoverRequirementItem[];
    session_id?: string;
  },
  options: { persona?: string; scopeKey?: string } = {}
): { path: string; draft: DiscoverDraft } {
  const draft = buildDiscoverDraft(input);
  const outPath = discoverDraftPath(input.session_id, options.scopeKey);
  const write = () => {
    if (!safeExistsSync(path.dirname(outPath)))
      safeMkdir(path.dirname(outPath), { recursive: true });
    safeWriteFile(outPath, `${JSON.stringify(draft, null, 2)}\n`);
  };
  withExecutionContext(options.persona || 'ecosystem_architect', write, 'ecosystem_architect');
  return { path: outPath, draft };
}

export function readDiscoverDraft(
  sessionId = 'current',
  scopeKey = 'default'
): DiscoverDraft | null {
  const filePath = discoverDraftPath(sessionId, scopeKey);
  if (!safeExistsSync(filePath)) return null;
  return parseSafeJsonInput(readTextFile(filePath), 'companion discover draft') as DiscoverDraft;
}
