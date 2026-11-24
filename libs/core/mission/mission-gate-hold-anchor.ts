/**
 * libs/core/mission/mission-gate-hold-anchor.ts
 *
 * Audit-chain anchor for the required human holds of a mission.
 *
 * The local anchors of the hold set (mission state type fields, stored gate
 * definitions) are files the agent can write. When the process template is
 * planned, the resolved hold set is also recorded in the audit chain
 * (`mission.human_holds_anchored`). The chain is append-only and hash-linked:
 * a later record can only add holds, and removing or editing one breaks
 * `audit verify`. The terminal checks (`finish`, `gate-pass`) unite this
 * anchor with the local ones, so rewriting state and deleting gate
 * definitions after planning no longer drops a hold.
 *
 * Reading the anchor scans the whole chain, so the frequent checks
 * (record-evidence, dispatch, phase advance) keep using the local anchors.
 * Limits: missions planned before the anchor existed have none, and audit
 * daily files archived by retention (storage-retention-catalog.json) are no
 * longer read, so a mission finishing after that window falls back to its
 * local anchors.
 */
import { auditChain } from '../governance/audit-chain.js';

export const MISSION_HUMAN_HOLDS_ANCHOR_ACTION = 'mission.human_holds_anchored';

export interface AnchoredHumanHold {
  gateId: string;
  phase: string;
  position: 'entry' | 'exit';
  phaseOrder: string[];
}

function anchorEntry(missionId: string, holds: readonly AnchoredHumanHold[], source: string) {
  const upper = missionId.trim().toUpperCase();
  return {
    agentId: 'mission_controller',
    action: MISSION_HUMAN_HOLDS_ANCHOR_ACTION,
    operation: `anchor:${upper}`,
    result: 'completed' as const,
    metadata: {
      mission_id: upper,
      source,
      holds: holds.map((hold) => ({
        gate_id: hold.gateId,
        phase: hold.phase,
        position: hold.position,
        phase_order: [...hold.phaseOrder],
      })),
    },
  };
}

/**
 * Throws when the anchor could not be recorded (chain key, scope), so planning
 * refuses before it writes anything instead of leaving a half-planned mission.
 */
export function assertMissionHumanHoldAnchorRecordable(missionId: string, source: string): void {
  auditChain.assertRecordable(anchorEntry(missionId, [], source));
}

/**
 * Record the mission's required hold set in the audit chain. No-op for an
 * empty set. Durable: a lost write throws, because a silently missing anchor
 * would leave only the agent-writable anchors.
 */
export function recordMissionHumanHoldAnchor(
  missionId: string,
  holds: readonly AnchoredHumanHold[],
  source: string
): void {
  if (holds.length === 0) return;
  auditChain.recordDurable(anchorEntry(missionId, holds, source));
}

function parseAnchoredHold(value: unknown): AnchoredHumanHold | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const gateId = typeof record.gate_id === 'string' ? record.gate_id.trim() : '';
  const phase = typeof record.phase === 'string' ? record.phase.trim() : '';
  if (!gateId || !phase) return null;
  const phaseOrder = Array.isArray(record.phase_order)
    ? record.phase_order.filter((entry): entry is string => typeof entry === 'string')
    : [];
  // Anything but an explicit exit hold is read as an entry hold: it holds
  // more phases, so a malformed record fails closed.
  const position = record.position === 'exit' ? 'exit' : 'entry';
  return { gateId, phase, position, phaseOrder };
}

/**
 * Every hold anchored for the mission, first record per gate id. Throws when
 * the chain cannot be read: callers fail closed instead of treating an
 * unreadable anchor as "no holds".
 */
export function loadAnchoredHumanHolds(missionId: string): AnchoredHumanHold[] {
  const upper = missionId.trim().toUpperCase();
  const holds = new Map<string, AnchoredHumanHold>();
  for (const entry of auditChain.loadAll()) {
    if (entry.action !== MISSION_HUMAN_HOLDS_ANCHOR_ACTION) continue;
    if (String(entry.metadata?.mission_id || '').toUpperCase() !== upper) continue;
    const listed = entry.metadata?.holds;
    for (const value of Array.isArray(listed) ? listed : []) {
      const hold = parseAnchoredHold(value);
      if (hold && !holds.has(hold.gateId)) holds.set(hold.gateId, hold);
    }
  }
  return [...holds.values()];
}
