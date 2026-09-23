/** Surface seams shared by the menu shell and the localhost transport. */
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import type { EventScope } from '@agent/core/event-scope';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  executePadAction,
  getPadActionAvailability,
  type PadActionAvailability,
  type PadActionInput,
  type PadActionResult,
} from './actions.js';
import { getPadAdapter, publicPadAdapterConfigs, type PadAdapter } from './adapters.js';
import { padsT } from './i18n.js';
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

/**
 * Replaceable presentation seam for another shell or an embedded surface.
 * Every text-bearing method takes the request locale (PA-07); a host may
 * ignore it, and callers without one get the process default.
 */
export interface PersonalPadsSurface {
  getMenu(locale?: SupportedLocale): readonly PadMenuItem[];
  getContent(padId: unknown, locale?: SupportedLocale): PadContent;
  resolveStoragePolicyId(padId: PadId, tier: EventScope['tier']): string | undefined;
  getHistory(
    context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
    padId: PadId,
    query?: PadHistoryQuery,
    storageRoot?: string,
    locale?: SupportedLocale
  ): PadHistoryResult;
  getTop(
    context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
    locale?: SupportedLocale
  ): PadTop;
  getSurfaceContract(locale?: SupportedLocale): PadSurfaceContract;
  /** Optional host override for capability readiness; transport still validates the declaration. */
  getActionAvailability?: (
    padId: PadId,
    actionId: string,
    locale?: SupportedLocale
  ) => PadActionAvailability;
  /** Optional host override for pad actions; transport and scope checks stay shared. */
  executeAction?: (input: PadActionInput) => Promise<PadActionResult>;
}

export function getMenu(locale?: SupportedLocale): readonly PadMenuItem[] {
  return publicPadRegistry(locale);
}

export function getContent(padId: unknown, locale?: SupportedLocale): PadContent {
  if (!isPadId(padId)) throw new Error('unknown pad');
  const entry = getPadRegistryEntry(padId);
  if (!entry) throw new Error('unknown pad');
  return { entry, adapter: getPadAdapter(padId, locale) };
}

/** The shell's storage wording for a tier (no physical path is ever shown). */
export function storageLabelForTier(
  tier: string,
  padLabel: string,
  locale?: SupportedLocale
): string {
  const t = padsT(locale);
  if (tier === 'personal') return t('personal_pads:storage_personal');
  if (tier === 'confidential') return t('personal_pads:storage_confidential');
  return t('personal_pads:storage_public', { pad: padLabel });
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

export function getTop(
  context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
  locale?: SupportedLocale
): PadTop {
  const t = padsT(locale);
  return {
    title: t('personal_pads:top_title'),
    subtitle: t('personal_pads:top_subtitle'),
    scope: context.scope,
    viewer_principal: context.viewer_principal,
  };
}

export function getHistory(
  context: Pick<LocalPadContext, 'scope' | 'viewer_principal'>,
  padId: PadId,
  query: PadHistoryQuery = {},
  storageRoot?: string,
  locale?: SupportedLocale
): PadHistoryResult {
  const { entry } = getContent(padId, locale);
  const store = new PadRecordStore(
    context.scope,
    context.viewer_principal,
    padId,
    resolvePadPolicyId(padId, context.scope.tier),
    storageRoot
  );
  return {
    ...store.list(query),
    storage_label: storageLabelForTier(context.scope.tier, padsT(locale)(entry.label_key), locale),
  };
}

export function getSurfaceContract(locale?: SupportedLocale): PadSurfaceContract {
  return { menu: getMenu(locale), content: publicPadAdapterConfigs(locale) };
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
  getActionAvailability: (padId, actionId, locale) =>
    getPadActionAvailability(padId, actionId, undefined, locale),
  executeAction,
};
