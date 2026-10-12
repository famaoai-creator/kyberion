import { safeExistsSync, safeUnlinkSync } from '../secure-io.js';
import { writeJson } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { resolveIdentityContext } from '../authority.js';
import { recordGovernanceAction } from '../governance/governance-action-recorder.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import { getReasoningProviderDescriptor } from './reasoning-provider-registry.js';
import {
  loadReasoningBackendPolicy,
  resolveScopedBackendPolicy,
  type ReasoningBackendMode,
} from './reasoning-backend-policy.js';
import { currentScope } from '../scope-context.js';
import { peekReasoningSelectionReadiness } from './reasoning-selection-readiness.js';
import {
  loadReasoningRoutePolicy,
  loadReasoningRouteUserConfigAtPath,
  normalizeReasoningRole,
  reasoningRouteUserConfigPath,
  resolveReasoningRoute,
  resolveScopedReasoningRoutePolicy,
  saveReasoningRouteUserConfig,
  validateReasoningRouteUserConfig,
  ReasoningSelectionError,
  withReasoningRouteConfigLock,
  type ReasoningRoleSelection,
  type ReasoningRouteUserConfig,
  type ReasoningSelectionDecision,
  type ResolveReasoningRouteInput,
} from './reasoning-route-resolver.js';

export interface ReasoningSelectionPreview {
  role: string;
  requested?: ReasoningRoleSelection;
  effective: ReasoningSelectionDecision['effective'] | null;
  source: ReasoningSelectionDecision['source'] | 'legacy';
  reason: string;
  reasonCode:
    ReasoningSelectionDecision['reasonCode'] | 'legacy' | 'conflict' | 'unavailable' | 'invalid';
  rejectedCandidates: Array<{ profile: string; reason: string }>;
  valid: boolean;
  fallback: boolean;
}
export interface ReasoningSelectionChoice {
  runtime_mode: string;
  provider?: string;
  label: string;
  models: string[];
  profiles: string[];
  available: boolean;
  reason: string;
}
export interface ReasoningSelectionSettings {
  revision: number;
  roles: ReasoningSelectionPreview[];
  choices: ReasoningSelectionChoice[];
}

function readCurrentConfig(): ReasoningRouteUserConfig {
  const filePath = reasoningRouteUserConfigPath();
  return safeExistsSync(filePath) ? loadReasoningRouteUserConfigAtPath(filePath) : {};
}

export function previewReasoningSelection(input: {
  role: string;
  selection?: ReasoningRoleSelection;
  /** Internal seams for CLI validation and hermetic tests; never trust an HTTP body here. */
  config?: ReasoningRouteUserConfig;
  context?: Omit<ResolveReasoningRouteInput, 'role' | 'userConfig'>;
}): ReasoningSelectionPreview {
  const current = input.config ?? readCurrentConfig();
  const role = normalizeReasoningRole(input.role, input.context?.policy);
  const selection = input.selection ?? current.roles?.[role]?.selection;
  const config = {
    ...current,
    roles: {
      ...current.roles,
      [role]: { ...current.roles?.[role], ...(selection ? { selection } : {}) },
    },
  };
  try {
    validateReasoningRouteUserConfig(config);
    const route = resolveReasoningRoute({ ...input.context, role, userConfig: config });
    return {
      role,
      requested: selection,
      effective: route.selection?.effective ?? {
        profile: route.profileRef,
        runtime_mode: route.mode,
        provider: getReasoningProviderDescriptor(route.mode as ReasoningBackendMode)?.provider,
        ...(route.model ? { model: route.model } : {}),
      },
      source: route.selection?.source ?? 'legacy',
      reason:
        route.selection?.reason ??
        'Existing route behavior is unchanged; legacy strict is not a fixed model guarantee',
      reasonCode: route.selection?.reasonCode ?? 'legacy',
      rejectedCandidates: route.rejectedCandidates,
      valid: true,
      fallback: route.selection?.fallback ?? false,
    };
  } catch (error) {
    return {
      role,
      requested: selection,
      effective: null,
      source: selection ? 'user' : 'legacy',
      reason:
        error instanceof ReasoningSelectionError
          ? error.message
          : 'Reasoning configuration could not be validated.',
      reasonCode: error instanceof ReasoningSelectionError ? error.reasonCode : 'invalid',
      rejectedCandidates: error instanceof ReasoningSelectionError ? error.rejectedCandidates : [],
      valid: false,
      fallback: false,
    };
  }
}

/** Read-only UI/CLI snapshot. It deliberately never calls the route doctor's live probes. */
export function getReasoningSelectionSettings(): ReasoningSelectionSettings {
  const config = readCurrentConfig();
  const policy = resolveScopedReasoningRoutePolicy(loadReasoningRoutePolicy(), currentScope());
  const backendPolicy = resolveScopedBackendPolicy(loadReasoningBackendPolicy(), currentScope());
  const readiness = peekReasoningSelectionReadiness(policy);
  const models = loadModelRegistry().models.filter(
    (model) => model.status !== 'blocked' && model.status !== 'deprecated'
  );
  const profiles = { ...policy.profiles, ...config.profiles };
  return {
    revision: config.revision ?? 0,
    roles: Object.keys(policy.roles).map((role) =>
      previewReasoningSelection({ role, config, context: { policy, backendPolicy, readiness } })
    ),
    choices: Object.entries(policy.runtime_adapters)
      .filter(([mode]) => backendPolicy.allowed_modes.includes(mode as ReasoningBackendMode))
      .map(([mode, adapter]) => ({
        runtime_mode: mode,
        provider: getReasoningProviderDescriptor(mode as ReasoningBackendMode)?.provider,
        label: adapter.selection?.display_name || mode,
        models: adapter.selection?.model_provider
          ? models
              .filter((model) => model.provider === adapter.selection?.model_provider)
              .map((model) => model.model_id)
          : [],
        profiles: Object.entries(profiles)
          .filter(([, profile]) => profile.mode === mode)
          .map(([ref]) => ref),
        available: readiness[mode]?.available ?? false,
        reason: readiness[mode]?.reason || 'No cached readiness evidence',
      })),
  };
}

export class ReasoningSelectionRevisionConflict extends Error {
  readonly code = 'REASONING_SELECTION_REVISION_CONFLICT';
  constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number
  ) {
    super(
      'Reasoning settings changed; reload before saving (expected revision ' +
        expectedRevision +
        ', current ' +
        currentRevision +
        ')'
    );
    this.name = 'ReasoningSelectionRevisionConflict';
  }
}
function assertRevision(expected: number, current: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new Error('expectedRevision must be a nonnegative safe integer');
  if (expected !== current) throw new ReasoningSelectionRevisionConflict(expected, current);
}

/** Shared backup/audit publication path for CLI and Operator. Called only under its store lock. */
function publishConfig(
  config: ReasoningRouteUserConfig,
  current: ReasoningRouteUserConfig,
  change: string,
  dryRun: boolean,
  actorId?: string
): ReasoningRouteUserConfig {
  const next: ReasoningRouteUserConfig = {
    ...config,
    version: config.version || '1.0.0',
    revision: (current.revision ?? 0) + 1,
    updated_at: nowIso(),
    last_change: change,
  };
  validateReasoningRouteUserConfig(next);
  const policy = loadReasoningRoutePolicy();
  for (const role of Object.keys(next.roles || {})) {
    if (!policy.roles[role]) throw new Error('Unknown role in user config: ' + role);
  }
  for (const role of Object.keys(policy.roles)) {
    const preview = previewReasoningSelection({ role, config: next });
    if (!preview.valid)
      throw new ReasoningSelectionError(
        preview.reasonCode === 'conflict' ? 'conflict' : 'invalid',
        preview.reason,
        preview.rejectedCandidates
      );
  }
  if (dryRun) return next;
  const filePath = reasoningRouteUserConfigPath();
  const oldBackup = safeExistsSync(filePath + '.previous')
    ? loadReasoningRouteUserConfigAtPath(filePath + '.previous')
    : undefined;
  let backupPublished = false;
  try {
    writeJson(filePath + '.previous', current);
    backupPublished = true;
    writeJson(
      filePath +
        '.history/reasoning-route-user-config-' +
        next.revision +
        '-' +
        Date.now() +
        '.json',
      current
    );
    saveReasoningRouteUserConfig(next, current.revision ?? 0);
  } catch (error) {
    if (backupPublished) {
      try {
        if (oldBackup) writeJson(filePath + '.previous', oldBackup);
        else safeUnlinkSync(filePath + '.previous');
      } catch {
        throw new Error(
          'Reasoning settings publication failed and the previous rollback snapshot could not be restored',
          { cause: error }
        );
      }
    }
    throw error;
  }
  recordGovernanceAction(
    actorId || resolveIdentityContext().persona,
    'reasoning_route_config_update',
    change + ':revision=' + next.revision
  );
  return next;
}

export function commitReasoningRouteConfig(
  config: ReasoningRouteUserConfig,
  options: { expectedRevision: number; change: string; dryRun?: boolean; actorId?: string }
): ReasoningRouteUserConfig {
  const run = () => {
    const current = readCurrentConfig();
    assertRevision(options.expectedRevision, current.revision ?? 0);
    return publishConfig(config, current, options.change, options.dryRun === true, options.actorId);
  };
  return options.dryRun ? run() : withReasoningRouteConfigLock(run);
}

export function saveReasoningSelection(input: {
  role: string;
  selection: ReasoningRoleSelection;
  expectedRevision: number;
  actorId?: string;
}): ReasoningSelectionSettings {
  withReasoningRouteConfigLock(() => {
    const current = readCurrentConfig();
    assertRevision(input.expectedRevision, current.revision ?? 0);
    const role = normalizeReasoningRole(input.role);
    publishConfig(
      {
        ...current,
        roles: {
          ...current.roles,
          [role]: { ...current.roles?.[role], selection: input.selection },
        },
      },
      current,
      'select-role:' + role,
      false,
      input.actorId
    );
  });
  return getReasoningSelectionSettings();
}

export function rollbackReasoningSelection(input: {
  expectedRevision: number;
  dryRun?: boolean;
  actorId?: string;
}): ReasoningSelectionSettings | ReasoningRouteUserConfig {
  const run = () => {
    const current = readCurrentConfig();
    assertRevision(input.expectedRevision, current.revision ?? 0);
    const backup = reasoningRouteUserConfigPath() + '.previous';
    if (!safeExistsSync(backup)) throw new Error('No reasoning configuration rollback snapshot');
    const restored = loadReasoningRouteUserConfigAtPath(backup);
    return publishConfig(restored, current, 'rollback', input.dryRun === true, input.actorId);
  };
  if (input.dryRun) return run();
  withReasoningRouteConfigLock(run);
  return getReasoningSelectionSettings();
}
