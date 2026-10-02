/**
 * Persist an organization digest as organization-owned deliverables.
 *
 * The cross-tenant digest itself is a sovereign view and is never stored as
 * one file; each organization's entry is written into that organization's own
 * scope (`active/organizations/<tier>/<tenant|shared>/<org>/artifacts/report/
 * digests/<YYYY-MM-DD>.json`) and published, so a tenant viewer only ever sees
 * its own organizations' digests in surfaces.
 */
import { calendarDateInZone } from '../business-calendar.js';
import { createLogger } from '../logger.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import type { OrganizationDigest, OrganizationDigestEntry } from './organization-digest.js';

const logger = createLogger('organization-digest-artifacts');

export interface PersistedOrganizationDigestEntry {
  organization_id: string;
  tier: OrganizationDigestEntry['tier'];
  tenant_slug?: string;
  path: string;
  artifact_id?: string;
}

export interface OrganizationDigestPersistence {
  persisted: PersistedOrganizationDigestEntry[];
  failed: { organization_id: string; error: string }[];
}

function digestDateStamp(digest: OrganizationDigest): string {
  const date = calendarDateInZone(new Date(digest.generated_at), digest.timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * One record per organization scope and local day, so a same-day re-run
 * updates it. Tier and tenant are part of the id: organization ids are only
 * unique within their tenant, and a shared id would let one tenant's digest
 * overwrite another's record.
 */
function digestArtifactId(entry: OrganizationDigestEntry, stamp: string): string {
  const segment = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  return [
    'ART-ORGDIGEST',
    segment(entry.tier),
    segment(entry.tenant_slug || 'shared'),
    segment(entry.organization_id),
    stamp.replace(/-/gu, ''),
  ].join('-');
}

/**
 * Write one published report artifact per digest entry, scoped to the entry's
 * organization, tier and tenant. Best-effort per organization: a failed write
 * is reported and does not stop the others. Re-running on the same local day
 * overwrites that day's file and updates the same ArtifactRecord.
 */
export function persistOrganizationDigest(
  digest: OrganizationDigest
): OrganizationDigestPersistence {
  const stamp = digestDateStamp(digest);
  const result: OrganizationDigestPersistence = { persisted: [], failed: [] };
  for (const entry of digest.organizations) {
    try {
      const written = writeScopedArtifact({
        scope: {
          organization: entry.organization_id,
          ...(entry.tenant_slug ? { tenant: entry.tenant_slug } : {}),
        },
        tier: entry.tier,
        artifact_class: 'report',
        name: `digests/${stamp}.json`,
        content: {
          kind: 'organization_digest_entry',
          generated_at: digest.generated_at,
          timezone: digest.timezone,
          ...entry,
        },
        format: 'json',
        publish: {
          artifact_id: digestArtifactId(entry, stamp),
          kind: 'report',
          preview_text: `${entry.name} digest ${stamp}`,
          metadata: { digest_date: stamp },
        },
      });
      result.persisted.push({
        organization_id: entry.organization_id,
        tier: entry.tier,
        ...(entry.tenant_slug ? { tenant_slug: entry.tenant_slug } : {}),
        path: written.repo_relative_path,
        ...(written.artifact_id ? { artifact_id: written.artifact_id } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `organization digest artifact not written — ${message} | the digest text is still delivered | organization=${entry.organization_id}`
      );
      result.failed.push({ organization_id: entry.organization_id, error: message });
    }
  }
  return result;
}
