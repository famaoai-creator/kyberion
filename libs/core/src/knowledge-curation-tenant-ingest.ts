/**
 * DA-08: tenant-ingested cards join the KP-06 weekly curation cycle.
 *
 * For every registered tenant (plus the profile-less `common` namespace),
 * reads the DA-05 asset ledger (`listAssets` — active latest versions only)
 * and flags assets whose landed card breaches the freshness SLO for its
 * `kind` (`knowledge-curation-slo.json` `freshness_days_by_kind`, same
 * thresholds the corpus scan uses; ingested cards typically carry
 * `kind: reference`). `last_updated` comes from the card's frontmatter and
 * falls back to the ledger's `ingested_at`, so an asset never escapes the
 * SLO just because its card omitted the field.
 *
 * KM-03 guardrail carried over from the report module: candidates only —
 * nothing is deleted, demoted, or re-ingested here. The section is rendered
 * into CURATION_REPORT.md for the knowledge_steward; the re-ingest itself is
 * the DA-03/DA-05 sync ceremony's job (staleness against live sources is
 * `stalenessReport` with caller-supplied observations — this module covers
 * the observation-less weekly pass).
 *
 * Deterministic and fail-open per tenant: a broken profile or ledger skips
 * that tenant instead of failing the weekly report.
 */

import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { readTextFile } from '../foundation/text.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import {
  COMMON_TENANT_SLUG,
  listAssets,
  type IngestLedgerPathOptions,
} from '../ingest-asset-ledger.js';
import { listTenantProfileSlugs } from '../tenant-registry.js';
import type { CurationSloConfig } from './knowledge-curation-report.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Frontmatter `kind` assumed for ingested cards that declare none. */
export const TENANT_INGEST_DEFAULT_KIND = 'reference';

export interface TenantIngestCurationEntry {
  tenant_slug: string;
  asset_id: string;
  target_path: string;
  kind: string;
  last_updated: string | null;
  age_days: number | null;
  threshold_days: number;
  reason: 'stale' | 'missing_last_updated';
}

export interface TenantIngestCurationSection {
  tenant_slug: string;
  /** Active (latest-version) ledger assets for the tenant. */
  active_asset_count: number;
  flagged: TenantIngestCurationEntry[];
}

function extractFrontmatterValue(content: string, key: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return undefined;
  const line = fmMatch[1]
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(`${key}:`));
  if (!line) return undefined;
  const value = line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  return value || undefined;
}

function sortCodepoint(values: string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Ledger path seam: hermetic tests point this at a fixture root via options
 * or `KYBERION_CURATION_TENANT_ROOTDIR` (the report module calls this with
 * no options, so the env override is what the weekly-pipeline tests use).
 */
function resolvePathOptions(options?: IngestLedgerPathOptions): IngestLedgerPathOptions {
  if (options && Object.keys(options).length > 0) return options;
  const override = getRegisteredEnvText('KYBERION_CURATION_TENANT_ROOTDIR')?.trim();
  return override
    ? {
        rootDir: assertSafeRepositoryPath(pathResolver.rootResolve(override), {
          allowMissingLeaf: true,
        }),
      }
    : {};
}

/**
 * Compute the DA-08 per-tenant ingest curation sections. Tenants with no
 * ledger (or an empty one) are omitted so the report stays stable while no
 * tenant has ingested anything. Codepoint-sorted (tenants, then asset ids) —
 * deterministic across platforms.
 */
export function computeTenantIngestCuration(input: {
  config: CurationSloConfig;
  now?: Date;
  /** Explicit tenant list (tests); defaults to registered profiles + 'common'. */
  tenants?: string[];
  pathOptions?: IngestLedgerPathOptions;
}): TenantIngestCurationSection[] {
  const now = input.now ?? new Date();
  const config = input.config;
  const pathOptions = resolvePathOptions(input.pathOptions);
  const rootDir = pathOptions.rootDir ?? pathResolver.rootDir();

  let tenants: string[];
  if (input.tenants && input.tenants.length > 0) {
    tenants = sortCodepoint([...new Set(input.tenants)]);
  } else {
    let registered: string[] = [];
    try {
      registered = listTenantProfileSlugs(pathOptions);
    } catch {
      registered = [];
    }
    tenants = sortCodepoint([...new Set([...registered, COMMON_TENANT_SLUG])]);
  }

  const sections: TenantIngestCurationSection[] = [];
  for (const tenant of tenants) {
    let assets;
    try {
      assets = listAssets(tenant, pathOptions).filter((asset) => asset.status === 'active');
    } catch {
      continue; // broken profile/ledger: advisory report, never fatal
    }
    if (assets.length === 0) continue;

    const flagged: TenantIngestCurationEntry[] = [];
    for (const asset of assets) {
      let kind = TENANT_INGEST_DEFAULT_KIND;
      let lastUpdated: string | undefined;
      const cardAbs = path.join(rootDir, ...asset.target_path.split('/'));
      if (safeExistsSync(cardAbs)) {
        try {
          if (safeLstat(cardAbs).isFile()) {
            const content = readTextFile(cardAbs);
            kind = extractFrontmatterValue(content, 'kind') ?? kind;
            lastUpdated = extractFrontmatterValue(content, 'last_updated');
          }
        } catch {
          /* unreadable card: fall back to the ledger below */
        }
      }
      // The ledger's ingested_at backstops a missing frontmatter date — an
      // ingested card is at least as old as its last ingest ceremony.
      const effective = lastUpdated ?? asset.ingested_at;
      const thresholdDays = config.freshness_days_by_kind[kind] ?? config.default_freshness_days;
      const parsed = effective ? Date.parse(effective) : NaN;
      if (!effective || Number.isNaN(parsed)) {
        flagged.push({
          tenant_slug: tenant,
          asset_id: asset.asset_id,
          target_path: asset.target_path,
          kind,
          last_updated: effective ?? null,
          age_days: null,
          threshold_days: thresholdDays,
          reason: 'missing_last_updated',
        });
        continue;
      }
      const ageDays = Math.floor((now.getTime() - parsed) / MS_PER_DAY);
      if (ageDays > thresholdDays) {
        flagged.push({
          tenant_slug: tenant,
          asset_id: asset.asset_id,
          target_path: asset.target_path,
          kind,
          last_updated: effective,
          age_days: ageDays,
          threshold_days: thresholdDays,
          reason: 'stale',
        });
      }
    }
    flagged.sort((a, b) => (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0));
    sections.push({ tenant_slug: tenant, active_asset_count: assets.length, flagged });
  }
  return sections;
}
