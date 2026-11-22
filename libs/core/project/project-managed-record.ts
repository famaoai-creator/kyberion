import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import type { ProjectRecord } from './project-registry.js';

export interface ManagedProjectCreateInput {
  project_id: string;
  name: string;
  summary: string;
  tier: ProjectRecord['tier'];
  organization_id?: string;
  tenant_slug?: string;
  status?: ProjectRecord['status'];
  primary_locale?: string;
  project_path?: string;
  metadata?: Record<string, unknown>;
  pipeline_refs?: string[];
  objective_ids?: string[];
  rootDir?: string;
}

export function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function assertManagedProjectId(value: string): string {
  const normalized = normalizeId(value, 'project_id');
  if (!/^PRJ-[A-Z0-9][A-Z0-9._-]*$/.test(normalized)) {
    throw new Error(
      `Invalid project_id '${value}'. Managed projects must use PRJ-<UPPER_SNAKE_OR_DASH_ID>.`
    );
  }
  return normalized;
}

export function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

export function buildManagedProjectRecord(input: ManagedProjectCreateInput): ProjectRecord {
  const projectId = assertManagedProjectId(input.project_id);
  if (input.tier === 'confidential' && !input.tenant_slug?.trim()) {
    throw new Error(`tenant_slug is required for confidential project records (${projectId}).`);
  }
  if (input.tier === 'confidential' && input.tenant_slug === 'shared') {
    throw new Error(
      `tenant_slug 'shared' is not a tenant for confidential project records (${projectId}): ` +
        `'shared' is a reserved partition name, not a tenant. ` +
        `Run 'KYBERION_BASE_ROLE=sovereign pnpm tenant list' to see registered tenant slugs and pass one via --tenant-slug.`
    );
  }
  if (
    input.tier === 'confidential' &&
    input.tenant_slug &&
    (getRegisteredEnvText('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !isVitestProcess())
  ) {
    resolveTenant(input.tenant_slug, { rootDir: input.rootDir });
  }
  return {
    project_id: projectId,
    name: normalizeId(input.name, 'name'),
    summary: normalizeId(input.summary, 'summary'),
    status: input.status || 'draft',
    tier: input.tier,
    ...(input.organization_id ? { organization_id: input.organization_id } : {}),
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    ...(input.primary_locale ? { primary_locale: input.primary_locale } : {}),
    ...(input.project_path
      ? {
          repositories: [
            {
              repo_id: `REPO-${projectId.replace(/^PRJ-/, '')}`,
              kind: 'project-root',
              root_path: input.project_path,
            },
          ],
        }
      : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.pipeline_refs ? { pipeline_refs: sortedUnique(input.pipeline_refs) } : {}),
    ...(input.objective_ids?.length ? { objective_ids: sortedUnique(input.objective_ids) } : {}),
  };
}
