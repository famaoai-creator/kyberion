import {
  ControlPlaneClientError,
  createNextActionContract,
  createControlPlaneClient,
  createStandardYargs,
  findIntentOutcomePattern,
  getControlPlaneRemediationPlan,
  listMemoryPromotionCandidates,
  loadIntentOutcomePatterns,
  logger,
  pathResolver,
  safeExec,
  summarizeMissionSeedAssessment,
  validateNextActionContract,
} from '@agent/core';
import * as path from 'node:path';
import { readJsonFile } from './refactor/cli-input.js';

export { summarizeMissionSeedAssessment };

type SurfaceKind = 'presence' | 'chronos';
type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
type SurfaceActionHandler = (
  client: ControlPlaneClient,
  args: string[],
  json: boolean
) => Promise<void>;
type CatalogActionHandler = (args: string[], json: boolean) => Promise<void>;
const ARTIFACT_LIBRARY_INDEX_PATH = pathResolver.knowledge(
  'public/design-patterns/media-templates/artifact-library/index.json'
);
const ARTIFACT_LIBRARY_DIR = pathResolver.knowledge(
  'public/design-patterns/media-templates/artifact-library'
);
const DESIGN_MD_INDEX_PATH = pathResolver.knowledge(
  'public/design-patterns/media-templates/design-md-catalog/index.json'
);
const DESIGN_MD_THEME_PATH = pathResolver.knowledge(
  'public/design-patterns/media-templates/themes/design-md-imports.json'
);
const DESIGN_MD_SYSTEM_PATH = pathResolver.knowledge(
  'public/design-patterns/media-templates/media-design-systems/design-md-imports.json'
);

function loadArtifactLibraryIndex(): any {
  return readJsonFile(ARTIFACT_LIBRARY_INDEX_PATH);
}

function loadDesignMdIndex(): any {
  return readJsonFile(DESIGN_MD_INDEX_PATH);
}

function loadDesignMdThemes(): any {
  return readJsonFile(DESIGN_MD_THEME_PATH);
}

function loadDesignMdSystems(): any {
  return readJsonFile(DESIGN_MD_SYSTEM_PATH);
}

function normalizeCatalogQuery(input: unknown): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function searchArtifactLibraryProfiles(query?: string): any[] {
  const index = loadArtifactLibraryIndex();
  const normalized = normalizeCatalogQuery(query);
  const items = asArray(index.packs).flatMap((pack: any) =>
    asArray<string>(pack.profiles).map((profileId) => ({
      profile_id: profileId,
      domain: pack.domain,
      file: pack.file,
    }))
  );
  if (!normalized) return items;
  return items.filter((item) => {
    const haystack = [item.profile_id, item.domain, item.file].map(normalizeCatalogQuery).join(' ');
    return haystack.includes(normalized);
  });
}

function resolveArtifactLibraryProfile(profileId: string): any {
  const index = loadArtifactLibraryIndex();
  const normalizedProfileId = String(profileId || '').trim();
  for (const pack of asArray(index.packs)) {
    if (!asArray<string>(pack.profiles).includes(normalizedProfileId)) continue;
    const fullPath = path.resolve(ARTIFACT_LIBRARY_DIR, String(pack.file));
    const doc = readJsonFile<any>(fullPath);
    return {
      profile_id: normalizedProfileId,
      domain: pack.domain,
      file: pack.file,
      definition: doc?.profiles?.[normalizedProfileId] || null,
    };
  }
  return null;
}

function searchImportedDesignSystems(query?: string): any[] {
  const index = loadDesignMdIndex();
  const normalized = normalizeCatalogQuery(query);
  const items = asArray(index.systems);
  if (!normalized) return items;
  return items.filter((item) => {
    const haystack = [
      item.design_system_id,
      item.theme_id,
      item.slug,
      item.name,
      item.category,
      item.description,
    ]
      .map(normalizeCatalogQuery)
      .join(' ');
    return haystack.includes(normalized);
  });
}

function recommendImportedDesignSystems(query?: string): any[] {
  const normalized = normalizeCatalogQuery(query);
  if (!normalized) return [];
  const items = searchImportedDesignSystems();
  return items
    .map((item) => {
      const terms = [
        item.design_system_id,
        item.theme_id,
        item.slug,
        item.name,
        item.category,
        item.description,
        ...asArray<string>(item.keywords),
      ]
        .map(normalizeCatalogQuery)
        .filter(Boolean);
      let score = 0;
      for (const term of terms) {
        if (normalized === term) score += 10;
        else if (normalized.includes(term))
          score += Math.min(6, Math.max(2, term.split(' ').length + 1));
        else if (term.includes(normalized)) score += 1;
      }
      return { ...item, recommendation_score: score };
    })
    .filter((item) => item.recommendation_score > 0)
    .sort((left, right) => {
      if (right.recommendation_score !== left.recommendation_score)
        return right.recommendation_score - left.recommendation_score;
      return String(left.design_system_id || '').localeCompare(
        String(right.design_system_id || '')
      );
    })
    .slice(0, 10);
}

function resolveImportedDesignSystem(designSystemId: string): any {
  const normalizedId = String(designSystemId || '').trim();
  const index = loadDesignMdIndex();
  const summary = asArray(index.systems).find((item) => item.design_system_id === normalizedId);
  if (!summary) return null;
  const themes = loadDesignMdThemes();
  const systems = loadDesignMdSystems();
  return {
    ...summary,
    theme: themes?.themes?.[summary.theme_id] || null,
    system: systems?.systems?.[normalizedId] || null,
  };
}

interface DoctorCheckResult {
  surface: SurfaceKind;
  ok: boolean;
  status: 'ok' | 'error';
  detail: string;
  suggestedCommand?: string;
  baseUrl?: string;
  fixAttempted?: boolean;
  fixResult?: string;
}

function summarizeSurfaceRuntimeOutput(output: unknown, fallback: string): string {
  const text = String(output || '').trim();
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const status = String(parsed.status || 'ok');
    const id = parsed.id ? String(parsed.id) : undefined;
    const detail = parsed.detail ? String(parsed.detail) : undefined;
    const port = parsed.port ? String(parsed.port) : undefined;
    return [status, id, detail, port ? `port ${port}` : undefined].filter(Boolean).join(' · ');
  } catch (_) {
    return formatExecTail(text, fallback);
  }
}

function formatExecTail(output: unknown, fallback: string): string {
  const text = String(output || '').trim();
  if (!text) {
    return fallback;
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || fallback;
}

function attemptSurfaceFix(surface: SurfaceKind): string {
  const runtimeId = getControlPlaneRemediationPlan(surface).runtimeId;
  const actions: Array<{ args: string[]; fallback: string }> = [
    {
      args: ['dist/scripts/surface_runtime.js', '--action', 'stop', '--surface', runtimeId],
      fallback: `stop ${runtimeId} completed`,
    },
    {
      args: ['dist/scripts/surface_runtime.js', '--action', 'start', '--surface', runtimeId],
      fallback: `start ${runtimeId} completed`,
    },
  ];

  const steps: string[] = [];
  try {
    for (const action of actions) {
      const output = safeExec('node', action.args, {
        cwd: pathResolver.rootDir(),
        timeoutMs: 120_000,
      });
      steps.push(summarizeSurfaceRuntimeOutput(output, action.fallback));
    }
    return steps.join(' -> ');
  } catch (error) {
    const reconcileOutput = safeExec('pnpm', ['surfaces:reconcile'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 120_000,
    });
    const reconcileTail = formatExecTail(reconcileOutput, 'reconcile completed');
    const reason = error instanceof Error ? error.message : String(error);
    steps.push(`fallback to reconcile after targeted restart failed: ${reason}`);
    steps.push(reconcileTail);
    return steps.join(' -> ');
  }
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function printItems(title: string, items: unknown[], projector: (item: any) => string[]): void {
  if (!items.length) {
    process.stdout.write(`${title}: none\n`);
    return;
  }
  process.stdout.write(`${title} (${items.length})\n`);
  for (const item of items) {
    const lines = projector(item);
    process.stdout.write(`- ${lines[0] || 'item'}\n`);
    for (const line of lines.slice(1)) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function filterByProjectId<T extends { project_id?: string }>(items: T[], projectId?: string): T[] {
  if (!projectId) return items;
  return items.filter((item) => item.project_id === projectId);
}

function isKnowledgePath(logicalPath: string): boolean {
  return /^knowledge\//.test(String(logicalPath || '').trim());
}

function listChronosMemoryCandidates(status?: string): any[] {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();
  return listMemoryPromotionCandidates()
    .filter((item) => (normalized ? item.status === normalized : true))
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at));
}

export function buildChronosNextActions(input: {
  pendingApprovals: number;
  missionSeeds: any[];
  memoryCandidates: any[];
}): Array<ReturnType<typeof createNextActionContract>> {
  const actions = [];
  if (input.pendingApprovals > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-approve-pending',
        type: 'approve',
        reason: `${input.pendingApprovals} pending approval request(s) require a decision.`,
        risk: 'medium',
        suggestedCommand: 'pnpm control chronos approvals',
        suggestedSurfaceAction: 'approvals',
        approvalRequired: true,
      })
    );
  }

  const approvedMemory = input.memoryCandidates.filter((item) => item.status === 'approved');
  if (approvedMemory.length > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-promote-memory',
        type: 'inspect_evidence',
        reason: `${approvedMemory.length} approved memory candidate(s) are ready for promotion.`,
        risk: 'low',
        suggestedCommand:
          'node dist/scripts/mission_controller.js memory-promote-pending --dry-run',
        suggestedSurfaceAction: 'memory-promotion-queue',
        approvalRequired: false,
      })
    );
  }

  const flaggedSeeds = input.missionSeeds.filter(
    (seed) =>
      seed?.metadata?.mission_seed_assessment && !seed.metadata.mission_seed_assessment.eligible
  );
  if (flaggedSeeds.length > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-review-flagged-seed',
        type: 'inspect_evidence',
        reason: `${flaggedSeeds.length} mission seed(s) were flagged by assessment and should be reviewed before promotion.`,
        risk: 'medium',
        suggestedCommand: 'pnpm control chronos mission-seeds',
        suggestedSurfaceAction: 'mission-seeds',
        approvalRequired: false,
      })
    );
  }

  const promotableSeeds = input.missionSeeds.filter(
    (seed) =>
      !seed.promoted_mission_id &&
      (!seed?.metadata?.mission_seed_assessment || seed.metadata.mission_seed_assessment.eligible)
  );
  if (promotableSeeds.length > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-promote-seed',
        type: 'promote_mission_seed',
        reason: `${promotableSeeds.length} mission seed(s) can be promoted into active missions.`,
        risk: 'low',
        suggestedCommand: 'pnpm control chronos mission-seeds',
        suggestedSurfaceAction: 'mission-seeds',
        approvalRequired: false,
      })
    );
  }

  return actions.filter((action) => validateNextActionContract(action).valid);
}

async function executeSurfaceAction(
  surface: Exclude<SurfaceKind | 'catalog', 'catalog'>,
  action: string,
  args: string[],
  json: boolean,
  handlers: Record<string, SurfaceActionHandler>
): Promise<void> {
  const handler = handlers[action];
  if (!handler) {
    throw new Error(`Unsupported ${surface} action: ${action}`);
  }
  const client = createControlPlaneClient(surface, { timeoutMs: 5000, retryCount: 1 });
  await handler(client, args, json);
}

async function executeCatalogAction(
  action: string,
  args: string[],
  json: boolean,
  handlers: Record<string, CatalogActionHandler>
): Promise<void> {
  const handler = handlers[action];
  if (!handler) {
    throw new Error(`Unsupported catalog action: ${action}`);
  }
  await handler(args, json);
}

async function runDoctor(input: {
  json: boolean;
  verbose: boolean;
  fix: boolean;
  surface?: SurfaceKind;
}): Promise<void> {
  const checks: DoctorCheckResult[] = [];
  const surfaces: Array<{ surface: SurfaceKind; run: () => Promise<unknown>; baseUrl: string }> = [
    {
      surface: 'presence' as SurfaceKind,
      baseUrl: String(process.env.PRESENCE_STUDIO_URL || 'http://127.0.0.1:3031'),
      run: async () =>
        createControlPlaneClient('presence', { timeoutMs: 3000, retryCount: 0 }).listProjects(),
    },
    {
      surface: 'chronos' as SurfaceKind,
      baseUrl: String(process.env.CHRONOS_URL || 'http://127.0.0.1:3000'),
      run: async () =>
        createControlPlaneClient('chronos', {
          timeoutMs: 3000,
          retryCount: 0,
        }).getChronosOverview(),
    },
  ].filter((entry) => !input.surface || entry.surface === input.surface);

  for (const entry of surfaces) {
    try {
      const result = await entry.run();
      if (entry.surface === 'presence') {
        checks.push({
          surface: entry.surface,
          ok: true,
          status: 'ok',
          detail: `reachable · projects=${asArray(result).length}`,
          baseUrl: entry.baseUrl,
        });
      } else {
        const overview = result as {
          accessRole?: string;
          projects?: unknown[];
          pendingApprovals?: unknown[];
        };
        checks.push({
          surface: entry.surface,
          ok: true,
          status: 'ok',
          detail: `reachable · access=${overview.accessRole || 'unknown'} · projects=${asArray(overview.projects).length} · approvals=${asArray(overview.pendingApprovals).length}`,
          baseUrl: entry.baseUrl,
        });
      }
    } catch (error) {
      const suggestedCommand =
        error instanceof ControlPlaneClientError ? error.suggestedCommand : undefined;
      const record: DoctorCheckResult = {
        surface: entry.surface,
        ok: false,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
        suggestedCommand,
        baseUrl: entry.baseUrl,
      };
      if (input.fix && suggestedCommand) {
        record.fixAttempted = true;
        try {
          const attempted = attemptSurfaceFix(entry.surface);
          try {
            await entry.run();
            record.fixResult = `${attempted} -> verified`;
          } catch (retryError) {
            const retryDetail =
              retryError instanceof Error ? retryError.message : String(retryError);
            record.fixResult = `${attempted} -> still failing: ${retryDetail}`;
          }
        } catch (fixError) {
          record.fixResult = fixError instanceof Error ? fixError.message : String(fixError);
        }
      }
      checks.push(record);
    }
  }

  const summary = {
    ok: checks.every((check) => check.ok),
    checked_at: new Date().toISOString(),
    surfaces: checks,
  };

  if (input.json) {
    printJson(summary);
    if (!summary.ok) {
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write('Control Plane Doctor\n');
  for (const check of checks) {
    process.stdout.write(`- ${check.surface}: ${check.ok ? 'ok' : 'error'}\n`);
    process.stdout.write(`  ${check.detail}\n`);
    if (input.verbose && check.baseUrl) {
      process.stdout.write(`  url: ${check.baseUrl}\n`);
    }
    if (check.suggestedCommand) {
      process.stdout.write(`  suggested fix: ${check.suggestedCommand}\n`);
    }
    if (check.fixAttempted) {
      process.stdout.write(`  fix attempted: ${check.fixResult || 'completed'}\n`);
    }
  }
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

async function handlePresence(action: string, args: string[], json: boolean): Promise<void> {
  const handlers: Record<string, SurfaceActionHandler> = {
    projects: async (client, _args, outputJson) => {
      const items = await client.listProjects();
      if (outputJson) return printJson(items);
      return printItems('Projects', items, (item) => [
        `${item.name || item.project_id} [${item.status || 'unknown'}]`,
        `id: ${item.project_id || 'unknown'}`,
        `tier: ${item.tier || 'unknown'} · locale: ${item.primary_locale || 'n/a'}`,
        `missions: ${asArray(item.active_missions).length} · bindings: ${asArray(item.service_bindings).length}`,
      ]);
    },
    bindings: async (client, _args, outputJson) => {
      const body = await client.getJson('/api/service-bindings');
      if (outputJson) return printJson(body.items || []);
      return printItems('Service Bindings', asArray(body.items), (item) => [
        `${item.binding_id || 'binding'} [${item.service_type || 'service'}]`,
        `target: ${item.target || 'unknown'}`,
        `scope: ${item.scope || 'unknown'}`,
        `actions: ${asArray(item.allowed_actions).join(', ') || 'n/a'}`,
      ]);
    },
    'mission-seeds': async (client, _args, outputJson) => {
      const items = await client.listMissionSeeds();
      if (outputJson) return printJson(items);
      return printItems('Mission Seeds', items, (item) => [
        `${item.title || item.seed_id} [${item.status || 'unknown'}]`,
        `project: ${item.project_id || 'standalone'} · specialist: ${item.specialist_id || 'unknown'}`,
        `type: ${item.mission_type_hint || 'general'} · source: ${item.source_work_id || '-'}`,
        item.promoted_mission_id ? `mission: ${item.promoted_mission_id}` : 'mission: -',
      ]);
    },
    tracks: async (client, currentArgs, outputJson) => {
      const [projectId] = currentArgs;
      const items = filterByProjectId(await client.listProjectTracks(), projectId);
      if (outputJson) return printJson(items);
      return printItems('Project Tracks', items, (item) => [
        `${item.name || item.track_id} [${item.status || 'unknown'}]`,
        `track: ${item.track_id} · project: ${item.project_id || 'unknown'}`,
        `type: ${item.track_type || 'unknown'} · lifecycle: ${item.lifecycle_model || 'unknown'}`,
        item.gate_readiness
          ? `gates: ${item.gate_readiness.ready_gate_count || 0}/${item.gate_readiness.total_gate_count || 0} · current: ${item.gate_readiness.current_gate_id || '-'}`
          : 'gates: -',
        asArray(item.gate_readiness?.next_required_artifacts).length
          ? `next required: ${asArray(item.gate_readiness?.next_required_artifacts)
              .map((entry) => entry.artifact_id || 'artifact')
              .join(', ')}`
          : 'next required: -',
      ]);
    },
    approvals: async (client, _args, outputJson) => {
      const items = await client.listApprovals();
      if (outputJson) return printJson(items);
      return printItems('Approvals', items, (item) => [
        `${item.title || item.id} [${item.status || 'pending'}]`,
        `id: ${item.id}`,
        `risk: ${item.risk?.level || item.severity || 'unknown'} · requested by: ${item.requestedBy || 'system'}`,
        item.expected_outcome
          ? `expected outcome: ${item.expected_outcome}`
          : 'expected outcome: -',
      ]);
    },
    approve: async (client, currentArgs) => {
      const [requestId, decision] = currentArgs;
      if (!requestId || !['approved', 'rejected'].includes(String(decision))) {
        throw new Error('Usage: control presence approve <requestId> <approved|rejected>');
      }
      const body = await client.postJson(
        `/api/approvals/${encodeURIComponent(requestId)}/decision`,
        { decision }
      );
      return printJson(body);
    },
    outcomes: async (client, _args, outputJson) => {
      const items = await client.listOutcomes();
      if (outputJson) return printJson(items);
      return printItems('Latest Outcomes', items, (item) => [
        `${item.preview_text || item.kind || 'outcome'} [${item.kind || 'artifact'}]`,
        `artifact: ${item.artifact_id || 'unknown'} · project: ${item.project_id || 'standalone'}`,
        `storage: ${item.storage_class || 'unknown'}`,
        asArray(item.promoted_refs).length
          ? `promoted: ${asArray(item.promoted_refs).join(', ')}`
          : 'promoted: -',
      ]);
    },
    tasks: async (client, _args, outputJson) => {
      const items = await client.listTaskSessions();
      if (outputJson) return printJson(items);
      return printItems('Requested Work', items, (item) => [
        `${item.goal?.summary || item.session_id} [${item.status || 'unknown'}]`,
        `id: ${item.session_id}`,
        `type: ${item.task_type || 'unknown'} · project: ${item.project_context?.project_id || 'standalone'}`,
        `result: ${item.artifact?.preview_text || 'pending'}`,
      ]);
    },
    task: async (client, currentArgs) => {
      const [sessionId] = currentArgs;
      if (!sessionId) {
        throw new Error('Usage: control presence task <sessionId>');
      }
      const body = await client.getJson(`/api/task-sessions/${encodeURIComponent(sessionId)}`);
      return printJson(body.item || body);
    },
    memory: async (client, currentArgs) => {
      const [logicalPath] = currentArgs;
      if (!logicalPath) {
        throw new Error('Usage: control presence memory <knowledge/logical/path.md>');
      }
      const text = await client.getText(
        `/api/knowledge-ref?path=${encodeURIComponent(logicalPath)}`
      );
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    ref: async (client, currentArgs) => {
      const [logicalPath] = currentArgs;
      if (!logicalPath) {
        throw new Error('Usage: control presence ref <knowledge/...|active/projects/...>');
      }
      const pathname = isKnowledgePath(logicalPath)
        ? `/api/knowledge-ref?path=${encodeURIComponent(logicalPath)}`
        : `/api/runtime-ref?path=${encodeURIComponent(logicalPath)}`;
      const text = await client.getText(pathname);
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
  };

  await executeSurfaceAction('presence', action, args, json, handlers);
}

async function handleChronos(action: string, args: string[], json: boolean): Promise<void> {
  const handlers: Record<string, SurfaceActionHandler> = {
    overview: async (client, _args, outputJson) => {
      const body = await client.getChronosOverview();
      const missionSeedAssessment = summarizeMissionSeedAssessment(asArray(body.missionSeeds));
      const memoryCandidates =
        asArray(body.memoryCandidates).length > 0
          ? asArray(body.memoryCandidates)
          : listChronosMemoryCandidates();
      const nextActions =
        asArray(body.nextActions).length > 0
          ? asArray(body.nextActions)
          : buildChronosNextActions({
              pendingApprovals: asArray(body.pendingApprovals).length,
              missionSeeds: asArray(body.missionSeeds),
              memoryCandidates,
            });
      if (outputJson)
        return printJson({
          ...body,
          missionSeedAssessment,
          memoryCandidates,
          nextActions,
        });
      process.stdout.write(`Chronos overview\n`);
      process.stdout.write(`- access: ${body.accessRole}\n`);
      process.stdout.write(`- projects: ${asArray(body.projects).length}\n`);
      process.stdout.write(`- mission seeds: ${asArray(body.missionSeeds).length}\n`);
      process.stdout.write(
        `- mission seed assessment: eligible ${missionSeedAssessment.eligible} · flagged ${missionSeedAssessment.flagged} · unassessed ${missionSeedAssessment.unassessed}\n`
      );
      process.stdout.write(`- approvals: ${asArray(body.pendingApprovals).length}\n`);
      process.stdout.write(`- distill candidates: ${asArray(body.distillCandidates).length}\n`);
      process.stdout.write(`- memory candidates: ${memoryCandidates.length}\n`);
      if (nextActions.length > 0) {
        process.stdout.write(`- next action: ${nextActions[0]?.reason}\n`);
        if (nextActions[0]?.suggested_command) {
          process.stdout.write(`  command: ${nextActions[0].suggested_command}\n`);
        }
      }
    },
    approvals: async (client, _args, outputJson) => {
      const items = await client.listApprovals();
      if (outputJson) return printJson(items);
      return printItems('Chronos Approvals', items, (item) => [
        `${item.title || item.id} [${item.riskLevel || 'unknown'}]`,
        `id: ${item.id} · channel: ${item.channel || 'unknown'} · storage: ${item.storageChannel || 'unknown'}`,
        `mission: ${item.missionId || '-'} · service: ${item.serviceId || '-'}`,
      ]);
    },
    approve: async (client, currentArgs) => {
      const [requestId, storageChannel, channel, decision] = currentArgs;
      if (
        !requestId ||
        !storageChannel ||
        !channel ||
        !['approved', 'rejected'].includes(String(decision))
      ) {
        throw new Error(
          'Usage: control chronos approve <requestId> <storageChannel> <channel> <approved|rejected>'
        );
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'approval_decision',
        requestId,
        storageChannel,
        channel,
        decision,
      });
      return printJson(body);
    },
    'mission-seeds': async (client, _args, outputJson) => {
      const items = await client.listMissionSeeds();
      if (outputJson) return printJson(items);
      return printItems('Mission Seeds', items, (item) => [
        `${item.title || item.seed_id} [${item.status || 'unknown'}]`,
        `seed: ${item.seed_id} · project: ${item.project_id || 'standalone'} · track: ${item.track_name || item.track_id || '-'}`,
        `specialist: ${item.specialist_id || 'unknown'} · type: ${item.mission_type_hint || 'general'}`,
        item.promoted_mission_id ? `mission: ${item.promoted_mission_id}` : 'mission: -',
        item.metadata?.mission_seed_assessment
          ? `assessment: ${item.metadata.mission_seed_assessment.eligible ? 'eligible' : 'flagged'} · ${String(item.metadata.mission_seed_assessment.reason || '-')}`
          : 'assessment: -',
        item.metadata?.template_ref ? `template: ${item.metadata.template_ref}` : 'template: -',
        item.metadata?.skeleton_path ? `skeleton: ${item.metadata.skeleton_path}` : 'skeleton: -',
        item.metadata?.execution_contract && typeof item.metadata.execution_contract === 'object'
          ? `execution: ${String((item.metadata.execution_contract as any).recommended_action || '-')} -> ${String((item.metadata.execution_contract as any).review_target || (item.metadata.execution_contract as any).repository_id || '-')}`
          : 'execution: -',
      ]);
    },
    tracks: async (client, currentArgs, outputJson) => {
      const [projectId] = currentArgs;
      const items = filterByProjectId(await client.listProjectTracks(), projectId);
      if (outputJson) return printJson(items);
      return printItems('Chronos Tracks', items, (item) => [
        `${item.name || item.track_id} [${item.status || 'unknown'}]`,
        `track: ${item.track_id} · project: ${item.project_id || 'unknown'}`,
        `type: ${item.track_type || 'unknown'} · lifecycle: ${item.lifecycle_model || 'unknown'}`,
        item.gate_readiness
          ? `gates: ${item.gate_readiness.ready_gate_count || 0}/${item.gate_readiness.total_gate_count || 0} · current: ${item.gate_readiness.current_gate_id || '-'}`
          : 'gates: -',
        asArray(item.gate_readiness?.next_required_artifacts).length
          ? `next required: ${asArray(item.gate_readiness?.next_required_artifacts)
              .map((entry) => {
                const parts = [entry.artifact_id || 'artifact'];
                if (entry.template_ref) parts.push(`template=${entry.template_ref}`);
                return parts.join(' ');
              })
              .join(', ')}`
          : 'next required: -',
      ]);
    },
    'seed-track': async (client, currentArgs) => {
      const [trackId, artifactId] = currentArgs;
      if (!trackId) {
        throw new Error('Usage: control chronos seed-track <trackId> [artifactId]');
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'create_track_seed',
        trackId,
        artifactId,
      });
      return printJson(body);
    },
    'promote-seed': async (client, currentArgs) => {
      const [seedId] = currentArgs;
      if (!seedId) {
        throw new Error('Usage: control chronos promote-seed <seedId>');
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'promote_mission_seed',
        seedId,
      });
      return printJson(body);
    },
    'distill-candidates': async (client, _args, outputJson) => {
      const body = await client.getJson('/api/intelligence');
      const items = asArray(body.distillCandidates);
      if (outputJson) return printJson(items);
      return printItems('Distill Candidates', items, (item) => [
        `${item.title || item.candidate_id} [${item.status || 'proposed'}]`,
        `candidate: ${item.candidate_id} · kind: ${item.target_kind || 'unknown'} · tier: ${item.tier || 'unknown'}`,
        `project: ${item.project_id || 'standalone'} · mission: ${item.mission_id || '-'} · task: ${item.task_session_id || '-'}`,
        item.promoted_ref ? `promoted: ${item.promoted_ref}` : 'promoted: -',
      ]);
    },
    'memory-candidates': async (_client, currentArgs, outputJson) => {
      const [status] = currentArgs;
      const items = listChronosMemoryCandidates(status);
      if (outputJson) return printJson(items);
      return printItems('Memory Candidates', items, (item) => [
        `${item.candidate_id} [${item.status || 'queued'}]`,
        `kind: ${item.proposed_memory_kind || 'unknown'} · tier: ${item.sensitivity_tier || 'unknown'}`,
        `source: ${item.source_ref || 'unknown'}`,
        `evidence: ${asArray(item.evidence_refs).length}`,
        item.promoted_ref ? `promoted: ${item.promoted_ref}` : 'promoted: -',
      ]);
    },
    'next-actions': async (client, _currentArgs, outputJson) => {
      const body = await client.getChronosOverview();
      const memoryCandidates =
        asArray(body.memoryCandidates).length > 0
          ? asArray(body.memoryCandidates)
          : listChronosMemoryCandidates();
      const actions =
        asArray(body.nextActions).length > 0
          ? asArray(body.nextActions)
          : buildChronosNextActions({
              pendingApprovals: asArray(body.pendingApprovals).length,
              missionSeeds: asArray(body.missionSeeds),
              memoryCandidates,
            });
      if (outputJson) return printJson(actions);
      return printItems('Chronos Next Actions', actions, (item) => [
        `${item.action_id} [${item.next_action_type}]`,
        `risk: ${item.risk} · approval_required: ${item.approval_required ? 'yes' : 'no'}`,
        `reason: ${item.reason}`,
        item.suggested_command
          ? `command: ${item.suggested_command}`
          : `surface action: ${item.suggested_surface_action || '-'}`,
      ]);
    },
    'promote-memory': async (client, currentArgs) => {
      const dryRun = currentArgs.includes('--dry-run');
      const body = await client.postJson('/api/intelligence', {
        action: 'memory_promote_pending',
        dryRun,
      });
      return printJson(body);
    },
    distill: async (client, currentArgs) => {
      const [candidateId, decision] = currentArgs;
      if (!candidateId || !['promote', 'archive'].includes(String(decision))) {
        throw new Error('Usage: control chronos distill <candidateId> <promote|archive>');
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'distill_candidate_decision',
        candidateId,
        decision,
      });
      return printJson(body);
    },
    'mission-control': async (client, currentArgs) => {
      const [missionId, operation] = currentArgs;
      if (!missionId || !operation) {
        throw new Error(
          'Usage: control chronos mission-control <missionId> <resume|refresh_team|prewarm_team|staff_team|finish>'
        );
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'mission_control',
        missionId,
        operation,
      });
      return printJson(body);
    },
    'surface-control': async (client, currentArgs) => {
      const [operation, surfaceId] = currentArgs;
      if (!operation) {
        throw new Error(
          'Usage: control chronos surface-control <reconcile|status|start|stop> [surfaceId]'
        );
      }
      const body = await client.postJson('/api/intelligence', {
        action: 'surface_control',
        operation,
        surfaceId,
      });
      return printJson(body);
    },
    ref: async (client, currentArgs) => {
      const [logicalPath] = currentArgs;
      if (!logicalPath) {
        throw new Error('Usage: control chronos ref <knowledge/...|active/projects/...>');
      }
      const pathname = isKnowledgePath(logicalPath)
        ? `/api/knowledge-ref?path=${encodeURIComponent(logicalPath)}`
        : `/api/runtime-file?path=${encodeURIComponent(logicalPath)}`;
      const text = await client.getText(pathname);
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
  };

  await executeSurfaceAction('chronos', action, args, json, handlers);
}

async function handleCatalog(action: string, args: string[], json: boolean): Promise<void> {
  const handlers: Record<string, CatalogActionHandler> = {
    intents: async (currentArgs, outputJson) => {
      const [query] = currentArgs;
      const normalized = normalizeCatalogQuery(query);
      const items = loadIntentOutcomePatterns().filter((item) => {
        if (!normalized) return true;
        const haystack = [
          item.intent_id,
          ...(item.primary_outcome_ids || []),
          ...(item.contract_layers || []),
        ]
          .map(normalizeCatalogQuery)
          .join(' ');
        return haystack.includes(normalized);
      });
      if (outputJson) return printJson(items);
      return printItems('Intent Outcome Patterns', items, (item) => [
        `${item.intent_id}`,
        `outcomes: ${(item.primary_outcome_ids || []).join(', ') || '-'}`,
        `flow: ${(item.canonical_flow || []).slice(0, 3).join(' -> ') || '-'}`,
      ]);
    },
    intent: async (currentArgs) => {
      const [intentId] = currentArgs;
      if (!intentId) {
        throw new Error('Usage: control catalog intent <intentId>');
      }
      const item = findIntentOutcomePattern(intentId);
      if (!item) {
        throw new Error(`Unknown intent-outcome pattern: ${intentId}`);
      }
      return printJson(item);
    },
    profiles: async (currentArgs, outputJson) => {
      const [query] = currentArgs;
      const items = searchArtifactLibraryProfiles(query);
      if (outputJson) return printJson(items);
      return printItems('Artifact Library Profiles', items, (item) => [
        `${item.profile_id} [${item.domain || 'unknown'}]`,
        `pack: ${item.file || '-'}`,
      ]);
    },
    profile: async (currentArgs) => {
      const [profileId] = currentArgs;
      if (!profileId) {
        throw new Error('Usage: control catalog profile <profileId>');
      }
      const item = resolveArtifactLibraryProfile(profileId);
      if (!item) {
        throw new Error(`Unknown artifact-library profile: ${profileId}`);
      }
      return printJson(item);
    },
    'design-systems': async (currentArgs, outputJson) => {
      const [query] = currentArgs;
      const items = searchImportedDesignSystems(query);
      if (outputJson) return printJson(items);
      return printItems('Imported Design Systems', items, (item) => [
        `${item.design_system_id} [${item.category || 'unknown'}]`,
        `theme: ${item.theme_id || '-'}`,
        `source: ${item.source_path || '-'}`,
      ]);
    },
    'design-system': async (currentArgs) => {
      const [designSystemId] = currentArgs;
      if (!designSystemId) {
        throw new Error('Usage: control catalog design-system <designSystemId>');
      }
      const item = resolveImportedDesignSystem(designSystemId);
      if (!item) {
        throw new Error(`Unknown imported design system: ${designSystemId}`);
      }
      return printJson(item);
    },
    'design-recommend': async (currentArgs, outputJson) => {
      const query = currentArgs.join(' ');
      if (!query.trim()) {
        throw new Error('Usage: control catalog design-recommend <query>');
      }
      const items = recommendImportedDesignSystems(query);
      if (outputJson) return printJson(items);
      return printItems('Recommended Imported Design Systems', items, (item) =>
        [
          `${item.design_system_id} [score=${item.recommendation_score}]`,
          `theme: ${item.theme_id || '-'}`,
          item.category ? `category: ${item.category}` : '',
          item.description ? `description: ${item.description}` : '',
        ].filter(Boolean)
      );
    },
  };

  await executeCatalogAction(action, args, json, handlers);
}

function printHelp(): void {
  process.stdout.write(`Kyberion Control Plane CLI

Usage:
  pnpm control doctor
  pnpm control doctor --surface presence --verbose
  pnpm control doctor --fix
  pnpm control catalog intents [query]
  pnpm control catalog intent <intentId>
  pnpm control catalog profiles [query]
  pnpm control catalog profile <profileId>
  pnpm control catalog design-systems [query]
  pnpm control catalog design-system <designSystemId>
  pnpm control catalog design-recommend <query>
  pnpm control presence projects
  pnpm control presence tracks [projectId]
  pnpm control presence approvals
  pnpm control presence approve <requestId> <approved|rejected>
  pnpm control presence outcomes
  pnpm control presence tasks
  pnpm control presence task <sessionId>
  pnpm control presence memory <knowledge/logical/path.md>
  pnpm control presence ref <knowledge/...|active/projects/...>

  pnpm control chronos overview
  pnpm control chronos tracks [projectId]
  pnpm control chronos approvals
  pnpm control chronos approve <requestId> <storageChannel> <channel> <approved|rejected>
  pnpm control chronos mission-seeds
  pnpm control chronos seed-track <trackId> [artifactId]
  pnpm control chronos promote-seed <seedId>
  pnpm control chronos distill-candidates
  pnpm control chronos memory-candidates [status]
  pnpm control chronos next-actions
  pnpm control chronos promote-memory [--dry-run]
  pnpm control chronos distill <candidateId> <promote|archive>
  pnpm control chronos mission-control <missionId> <operation>
  pnpm control chronos surface-control <operation> [surfaceId]
  pnpm control chronos ref <knowledge/...|active/projects/...>

Environment:
  PRESENCE_STUDIO_URL  default http://127.0.0.1:3031
  CHRONOS_URL          default http://127.0.0.1:3000
  KYBERION_LOCALADMIN_TOKEN / KYBERION_API_TOKEN for Chronos API
  Requests use a short timeout/retry and report stale surface processes explicitly.
`);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false, description: 'Print raw JSON' })
    .option('surface', {
      type: 'string',
      choices: ['presence', 'chronos'],
      description: 'Filter doctor to one surface',
    })
    .option('verbose', {
      type: 'boolean',
      default: false,
      description: 'Show endpoint details in doctor output',
    })
    .option('fix', {
      type: 'boolean',
      default: false,
      description: 'Attempt suggested remediation for doctor failures',
    })
    .parseSync();
  const positional = (argv._ || []).map((value) => String(value));
  const [surface, action, ...rest] = positional;
  if (!surface || surface === 'help' || surface === '--help') {
    printHelp();
    return;
  }
  if (surface === 'doctor') {
    await runDoctor({
      json: Boolean(argv.json),
      verbose: Boolean(argv.verbose),
      fix: Boolean(argv.fix),
      surface: argv.surface as SurfaceKind | undefined,
    });
    return;
  }
  if (surface !== 'presence' && surface !== 'chronos' && surface !== 'catalog') {
    throw new Error(`Unsupported surface "${surface}". Use "presence", "chronos", or "catalog".`);
  }
  if (!action) {
    printHelp();
    return;
  }
  if (surface === 'catalog') {
    await handleCatalog(action, rest, Boolean(argv.json));
    return;
  }
  if (surface === 'presence') {
    await handlePresence(action, rest, Boolean(argv.json));
    return;
  }
  await handleChronos(action, rest, Boolean(argv.json));
}

main().catch((error) => {
  logger.error(error?.message || String(error));
  if (error instanceof ControlPlaneClientError && error.suggestedCommand) {
    process.stderr.write(`Suggested fix: ${error.suggestedCommand}\n`);
  }
  process.exit(1);
});
