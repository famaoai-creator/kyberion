import {
  triageNeedsYouAttention,
  type AttentionReasonKey,
  type AttentionTriagePlan,
  type AttentionTriagedItem,
} from '@agent/core/surface/attention-triage';
import type { NeedsYouItem } from './needs-you-client';

export type { AttentionReasonKey, AttentionTriagePlan, AttentionTriagedItem };

export function buildInboxFocusPlan(
  items: readonly NeedsYouItem[],
  now?: number
): AttentionTriagePlan {
  return triageNeedsYouAttention(items, { now, focusLimit: 3 });
}

export function selectInboxVisibleItems(
  items: readonly NeedsYouItem[],
  options: { focusMode: boolean; filtered: boolean; now?: number }
): {
  visible: NeedsYouItem[];
  plan: AttentionTriagePlan;
  triagedById: Map<string, AttentionTriagedItem>;
} {
  const plan = buildInboxFocusPlan(items, options.now);
  const triagedById = new Map(plan.all_items.map((entry) => [entry.item.id, entry]));
  if (options.focusMode && !options.filtered && plan.focus.length > 0) {
    return {
      visible: plan.focus.map((entry) => entry.item),
      plan,
      triagedById,
    };
  }
  return {
    visible: [...items],
    plan,
    triagedById,
  };
}
