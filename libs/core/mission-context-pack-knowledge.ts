import * as path from 'node:path';
import {
  findRelevantDistilledKnowledge,
  type DistilledKnowledgeEntry,
} from './distill-knowledge-injector.js';
import {
  resolveKnowledgeSlice,
  isKnowledgePathExcluded,
  isKnowledgePathInSearchRoots,
} from './knowledge-slices.js';
import { queryTenantKnowledge } from './tenant-knowledge-retrieval.js';
import { loadProjectRecord } from './project-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import type { ProjectOperationalState } from './project-operational-state-registry.js';
import type { WorkItem } from './work-coordination.js';
import type {
  LoadKnowledgeHintsInput,
  MissionContextPackKnowledgeHint,
  MissionStateSummary,
  MissionTier,
} from './mission-context-pack-types.js';

export type { LoadKnowledgeHintsInput } from './mission-context-pack-types.js';

export const SCOPE_KNOWLEDGE_BUDGETS: Record<
  'S' | 'M' | 'L',
  { hintLimit: number; contextBudgetChars: number }
> = {
  S: { hintLimit: 2, contextBudgetChars: 4000 },
  M: { hintLimit: 3, contextBudgetChars: 6000 },
  L: { hintLimit: 5, contextBudgetChars: 9000 },
};

export function resolveScopeBudget(scope?: 'S' | 'M' | 'L'): {
  hintLimit: number;
  contextBudgetChars: number;
} {
  return SCOPE_KNOWLEDGE_BUDGETS[scope ?? 'M'] ?? SCOPE_KNOWLEDGE_BUDGETS.M;
}

function normalizeTier(tier: unknown, fallback: MissionTier = 'public'): MissionTier {
  return tier === 'personal' || tier === 'confidential' || tier === 'public' ? tier : fallback;
}

const PINNED_EXCERPT_MAX_CHARS = 400;

function pinnedFrontmatterTitle(text: string): { title?: string; body: string } {
  if (!text.startsWith('---\n')) return { body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { body: text };
  const block = text.slice(4, end);
  const body = text.slice(end + 5);
  const match = block.match(/^title\s*:\s*(.+)$/m);
  const title = match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
  return { title, body };
}

function firstMarkdownHeading(text: string): string | undefined {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function truncatePinnedExcerpt(body: string, max = PINNED_EXCERPT_MAX_CHARS): string {
  const trimmed = body.trim();
  const idx = trimmed.indexOf('\n\n');
  const para = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  return para.replace(/\s+/g, ' ').slice(0, max);
}

function resolveSafePinnedKnowledgePath(repoRelativePath: string): string | null {
  const normalized = repoRelativePath.replaceAll('\\', '/');
  if (!normalized.startsWith('knowledge/')) return null;
  const root = path.resolve(pathResolver.knowledge());
  const absolute = path.resolve(pathResolver.rootResolve(normalized));
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return null;
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) break;
    if (safeLstat(current).isSymbolicLink()) return null;
  }
  return absolute;
}

function loadPinnedKnowledgeHint(repoRelativePath: string): MissionContextPackKnowledgeHint | null {
  try {
    const abs = resolveSafePinnedKnowledgePath(repoRelativePath);
    if (!abs) return null;
    if (!safeExistsSync(abs)) return null;
    if (!safeLstat(abs).isFile()) return null;
    const raw = safeReadFile(abs, { encoding: 'utf8' }) as string;
    const { title: frontmatterTitle, body } = pinnedFrontmatterTitle(raw);
    const bodyWithoutHeading = body.replace(/^#\s+.+\n/, '');
    const title = frontmatterTitle || firstMarkdownHeading(body) || path.basename(repoRelativePath);
    return {
      path: repoRelativePath,
      title,
      excerpt: truncatePinnedExcerpt(bodyWithoutHeading),
      tags: [],
    };
  } catch {
    return null;
  }
}

const GOVERNANCE_PHASES: ReadonlySet<string> = new Set([
  'alignment',
  'execution',
  'onboarding',
  'recovery',
  'review',
]);

export function deriveGovernancePhaseFromMissionState(
  missionState: MissionStateSummary,
  workItem?: WorkItem | null
): string | undefined {
  const metadataPhase =
    workItem?.metadata && typeof workItem.metadata === 'object'
      ? String((workItem.metadata as Record<string, unknown>).phase || '').trim()
      : '';
  if (metadataPhase && GOVERNANCE_PHASES.has(metadataPhase)) return metadataPhase;

  switch (missionState.status) {
    case 'planned':
      return 'alignment';
    case 'active':
      return 'execution';
    case 'validating':
    case 'distilling':
    case 'completed':
    case 'archived':
      return 'review';
    case 'paused':
    case 'failed':
      return 'recovery';
    default:
      return undefined;
  }
}

function tenantSlugFromContext(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
}): string | undefined {
  const slug = String(
    input.missionState.tenant_slug || input.projectState?.tenant_slug || ''
  ).trim();
  if (!slug || slug === 'shared') return undefined;
  return slug;
}

export function organizationIdFromContext(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
}): string | undefined {
  const fromMission = input.missionState.relationships?.project?.organization_id;
  const fromProject = input.projectState?.metadata?.organization_id;
  const projectId = String(
    input.projectState?.project_id || input.missionState.relationships?.project?.project_id || ''
  ).trim();
  const projectRecord = projectId ? loadProjectRecord(projectId) : null;
  const missionTenant = String(input.missionState.tenant_slug || '').trim();
  const registryMatchesScope = Boolean(
    projectRecord &&
    projectRecord.tier === input.missionState.tier &&
    (!missionTenant || projectRecord.tenant_slug === missionTenant)
  );
  const fromRegistry = registryMatchesScope ? projectRecord?.organization_id : undefined;
  const value = String(fromRegistry || fromMission || fromProject || '').trim();
  return value || undefined;
}

function tenantSlugForKnowledgeRetrieval(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
}): string | undefined {
  if (normalizeTier(input.missionState.tier) !== 'confidential') return undefined;
  return tenantSlugFromContext(input);
}

export function knowledgeHintFragment(hint: MissionContextPackKnowledgeHint, index: number) {
  const normalized = hint.path.replace(/\\/g, '/');
  const confidential = normalized.match(/(?:^|\/)confidential\/([^/]+)/);
  const customer = normalized.match(/(?:^|\/)customer\/([^/]+)/);
  const tenant = confidential?.[1] || customer?.[1];
  const sourceTier: MissionTier = confidential || customer ? 'confidential' : 'public';
  const organization = normalized.match(/\/organizations\/([^/]+)/)?.[1];
  const project = normalized.match(/\/projects\/([^/]+)/)?.[1];
  const mission = normalized.match(/\/missions\/([^/]+)/)?.[1];
  const task = normalized.match(/\/tasks\/([^/]+)/)?.[1];
  const session = normalized.match(/\/sessions\/([^/]+)/)?.[1];
  return {
    fragment_id: `knowledge-hint-${index}`,
    source_ref: hint.path,
    source_tier: sourceTier,
    ...(tenant && tenant !== 'common' ? { tenant_slug: tenant } : {}),
    ...(organization ? { organization_id: organization } : {}),
    ...(project ? { project_id: project } : {}),
    ...(mission ? { mission_id: mission } : {}),
    ...(task ? { task_id: task } : {}),
    ...(session ? { session_id: session } : {}),
    content: hint,
  };
}

function mergeTenantKnowledgeHints(input: {
  distill: MissionContextPackKnowledgeHint[];
  tenant: MissionContextPackKnowledgeHint[];
  cap: number;
  deliveredPaths: ReadonlySet<string>;
}): MissionContextPackKnowledgeHint[] {
  const out: MissionContextPackKnowledgeHint[] = [];
  const seen = new Set(input.deliveredPaths);
  let d = 0;
  let t = 0;
  while (out.length < input.cap && (d < input.distill.length || t < input.tenant.length)) {
    const distillHead = input.distill[d];
    const tenantHead = input.tenant[t];
    let takeTenant: boolean;
    if (!distillHead) takeTenant = true;
    else if (!tenantHead) takeTenant = false;
    else takeTenant = (tenantHead.score ?? 0) >= (distillHead.score ?? 0);
    const next = takeTenant ? tenantHead! : distillHead!;
    if (takeTenant) t += 1;
    else d += 1;
    if (seen.has(next.path)) continue;
    seen.add(next.path);
    out.push(next);
  }
  return out;
}

export async function loadKnowledgeHintsIfPossible(
  input: LoadKnowledgeHintsInput
): Promise<MissionContextPackKnowledgeHint[]> {
  const topic = [
    input.missionState.mission_type,
    input.teamRole,
    input.projectState?.name,
    input.projectState?.summary,
    input.trackRecord?.name,
    input.workItem?.title,
    input.workItem?.description,
    input.taskSession?.goal?.summary,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!topic) return [];

  const tags = new Set<string>(
    [
      input.missionState.tier,
      input.missionState.mission_type || '',
      input.teamRole || '',
      input.projectState?.project_id || '',
      input.trackRecord?.track_type || '',
    ]
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );

  const phase =
    input.phase ?? deriveGovernancePhaseFromMissionState(input.missionState, input.workItem);
  const sliceTenant = tenantSlugFromContext(input);
  const sliceProject = String(
    input.projectState?.project_id ||
      input.missionState.relationships?.project?.project_id ||
      input.workItem?.project_id ||
      ''
  ).trim();
  const sliceOrganization = organizationIdFromContext(input);

  const slice = resolveKnowledgeSlice({
    teamRole: input.teamRole,
    phase,
    missionType: input.missionState.mission_type,
    ...(sliceTenant ? { tenant: sliceTenant } : {}),
    ...(sliceProject ? { project: sliceProject } : {}),
    slicesPath: input.knowledgeSlicesPath,
  });

  const hintLimit = resolveScopeBudget(input.estimatedScope).hintLimit;
  const pinnedHints: MissionContextPackKnowledgeHint[] = [];
  for (const pinnedPath of slice.pinned) {
    if (pinnedHints.length >= hintLimit) break;
    const hint = loadPinnedKnowledgeHint(pinnedPath);
    if (hint) pinnedHints.push(hint);
  }

  const remaining = hintLimit - pinnedHints.length;
  if (remaining <= 0) return pinnedHints;

  const searchLimit = slice.exclude.length > 0 ? remaining * 2 : remaining;
  const relevant = await findRelevantDistilledKnowledge({
    topic,
    tags: Array.from(tags),
    limit: searchLimit,
    minScore: 0.08,
    ...(sliceTenant && normalizeTier(input.missionState.tier) === 'confidential'
      ? {
          scope: {
            tier: 'confidential' as const,
            tenant_slug: sliceTenant,
            ...(sliceOrganization ? { organization_id: sliceOrganization } : {}),
            ...(sliceProject ? { project_id: sliceProject } : {}),
            mission_id: input.missionState.mission_id,
          },
        }
      : {}),
  });

  const filtered =
    slice.exclude.length > 0
      ? relevant.filter((entry) => !isKnowledgePathExcluded(entry.path, slice.exclude))
      : relevant;

  const prioritized =
    slice.searchRoots.length > 0
      ? [
          ...filtered.filter((entry) =>
            isKnowledgePathInSearchRoots(entry.path, slice.searchRoots)
          ),
          ...filtered.filter(
            (entry) => !isKnowledgePathInSearchRoots(entry.path, slice.searchRoots)
          ),
        ]
      : filtered;

  const distillHints = prioritized.map((entry: DistilledKnowledgeEntry) => ({
    path: entry.path,
    title: entry.title,
    excerpt: entry.excerpt,
    tags: entry.tags,
    ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.source_mission ? { source_mission: entry.source_mission } : {}),
    ...(entry.last_updated ? { last_updated: entry.last_updated } : {}),
  }));

  const tenantSlug = tenantSlugForKnowledgeRetrieval(input);
  let tenantHints: MissionContextPackKnowledgeHint[] = [];
  if (tenantSlug) {
    const tenantFetchLimit = slice.exclude.length > 0 ? remaining * 2 : remaining;
    const tenantHits = await queryTenantKnowledge({
      tenantSlug,
      topic,
      limit: tenantFetchLimit,
      scope: {
        tier: 'confidential',
        tenant_slug: tenantSlug,
        mission_id: input.missionState.mission_id,
      },
      ...(input.tenantKnowledgeRootDir ? { rootDir: input.tenantKnowledgeRootDir } : {}),
    });
    tenantHints = tenantHits
      .filter((hit) => !isKnowledgePathExcluded(hit.path, slice.exclude))
      .map((hit) => ({
        path: hit.path,
        title: hit.title,
        excerpt: hit.excerpt,
        tags: hit.tags,
        score: hit.score,
      }));
  }

  if (tenantHints.length === 0) {
    return [...pinnedHints, ...distillHints.slice(0, remaining)];
  }

  const merged = mergeTenantKnowledgeHints({
    distill: distillHints,
    tenant: tenantHints,
    cap: remaining,
    deliveredPaths: new Set(pinnedHints.map((hint) => hint.path)),
  });
  return [...pinnedHints, ...merged];
}
