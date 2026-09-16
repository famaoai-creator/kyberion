/** Surface seams shared by the menu shell and the localhost transport. */
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import type { EventScope } from '@agent/core/event-scope';
import {
  executePadAction,
  getPadActionAvailability,
  type PadActionAvailability,
  type PadActionInput,
  type PadActionResult,
} from './actions.js';
import { getPadAdapter, publicPadAdapterConfigs, type PadAdapter } from './adapters.js';
import {
  getPadRegistryEntry,
  isPadId,
  publicPadRegistry,
  type PadId,
  type PadTier,
} from './registry.js';
import {
  PAD_STORAGE_POLICIES,
  PadRecordStore,
  type PadHistoryQuery,
  type PadRecord,
} from './storage.js';

export interface PadMenuItem {
  id: PadId;
  label: string;
  description: string;
  input_kind: string;
  storage_label: string;
}

export interface PadTop {
  title: string;
  subtitle: string;
  scope: EventScope;
  viewer_principal: string;
}

export interface PadContent {
  entry: NonNullable<ReturnType<typeof getPadRegistryEntry>>;
  adapter: PadAdapter;
}

export interface PadHistoryResult {
  records: PadRecord[];
  next_cursor?: string;
  storage_label: string;
}

export interface PadSurfaceContract {
  menu: readonly PadMenuItem[];
  content: ReturnType<typeof publicPadAdapterConfigs>;
}

/** Replaceable presentation seam for another shell or an embedded surface. */
export interface PersonalPadsSurface {
  getMenu(): readonly PadMenuItem[];
  getContent(padId: unknown): PadContent;
  resolveStoragePolicyId(padId: PadId, tier: EventScope['tier']): string | undefined;
  getHistory(
    context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
    padId: PadId,
    query?: PadHistoryQuery,
    storageRoot?: string
  ): PadHistoryResult;
  getTop(context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>): PadTop;
  getSurfaceContract(): PadSurfaceContract;
  /** Optional host override for capability readiness; transport still validates the declaration. */
  getActionAvailability?: (padId: PadId, actionId: string) => PadActionAvailability;
  /** Optional host override for pad actions; transport and scope checks stay shared. */
  executeAction?: (input: PadActionInput) => Promise<PadActionResult>;
}

export function getMenu(): readonly PadMenuItem[] {
  return publicPadRegistry();
}

export function getContent(padId: unknown): PadContent {
  if (!isPadId(padId)) throw new Error('unknown pad');
  const entry = getPadRegistryEntry(padId);
  if (!entry) throw new Error('unknown pad');
  return { entry, adapter: getPadAdapter(padId) };
}

/** Resolve the registry's pad policy family to the server-selected tier. */
export function resolvePadPolicyId(padId: PadId, tier: EventScope['tier']): string | undefined {
  const { entry } = getContent(padId);
  if (!['public', 'confidential', 'personal'].includes(tier)) throw new Error('invalid tier');
  const policyId = entry.storage_policy_ids[tier as PadTier];
  const policy = PAD_STORAGE_POLICIES.find((candidate) => candidate.id === policyId);
  if (!policy || policy.tier !== tier) throw new Error('pad storage policy is invalid');
  return policy.id;
}

export function getTop(context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>): PadTop {
  return {
    title: 'Capture desk',
    subtitle: 'ひとつの作業場所から記録し、あとで安全に振り返る',
    scope: context.scope,
    viewer_principal: context.viewer_principal,
  };
}

export function getHistory(
  context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
  padId: PadId,
  query: PadHistoryQuery = {},
  storageRoot?: string
): PadHistoryResult {
  const { entry } = getContent(padId);
  const store = new PadRecordStore(
    context.scope,
    context.viewer_principal,
    padId,
    resolvePadPolicyId(padId, context.scope.tier),
    storageRoot
  );
  return {
    ...store.list(query),
    storage_label:
      context.scope.tier === 'personal'
        ? 'このテナントの個人記録'
        : context.scope.tier === 'confidential'
          ? 'このテナントの共有記録'
          : `公開 scope の ${entry.label}`,
  };
}

export function getSurfaceContract(): PadSurfaceContract {
  return { menu: getMenu(), content: publicPadAdapterConfigs() };
}

export function executeAction(input: PadActionInput): Promise<PadActionResult> {
  return executePadAction(input);
}

/** Named seam used by hosts that want to inject or compose the pad surface. */
export const PERSONAL_PADS_SURFACE: PersonalPadsSurface = {
  getMenu,
  getContent,
  resolveStoragePolicyId: resolvePadPolicyId,
  getHistory,
  getTop,
  getSurfaceContract,
  getActionAvailability: (padId, actionId) => getPadActionAvailability(padId, actionId),
  executeAction,
};
