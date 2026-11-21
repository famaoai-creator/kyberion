import {
  LANE_ORDER,
  type AgentTile,
  type DeckSnapshot,
  type Lane,
  type DeckMissionRow,
  type Phase,
  type RailGroup,
  type RailItem,
} from './types.js';

/** Mission lifecycle status → the lane it occupies when nothing waits on a human. */
export function laneForMission(status: string): Lane {
  switch (status.toLowerCase()) {
    case 'validating':
      return 'review';
    case 'paused':
    case 'failed':
      return 'blocked';
    case 'completed':
    case 'archived':
    case 'distilling':
      return 'done';
    default:
      return 'running';
  }
}

/** Mission lifecycle status → position on the intent → learning strip. */
export function phaseForMission(status: string, hasGoal: boolean): Phase {
  switch (status.toLowerCase()) {
    case 'planned':
      return hasGoal ? 'agreed' : 'intent';
    case 'active':
    case 'paused':
    case 'failed':
      return 'executing';
    case 'validating':
      return 'review';
    case 'distilling':
      return 'learning';
    case 'completed':
    case 'archived':
      return 'done';
    default:
      return 'intent';
  }
}

function newestFirst(a?: string, b?: string): number {
  return (b ?? '').localeCompare(a ?? '');
}

/**
 * Build the attention rail: everything that waits on the human first
 * (governed decisions, agents blocked on input), then missions by lane.
 * Ordering inside a lane is deterministic so selection-by-key stays stable
 * across refreshes.
 */
export function buildRail(
  snapshot: DeckSnapshot,
  options: { doneLimit?: number } = {}
): RailGroup[] {
  const doneLimit = options.doneLimit ?? 5;
  const groups = new Map<Lane, RailItem[]>(LANE_ORDER.map((lane) => [lane, []]));
  const agentsByMission = new Map<string, AgentTile[]>();
  for (const agent of snapshot.agents) {
    if (!agent.missionId) continue;
    const list = agentsByMission.get(agent.missionId) ?? [];
    list.push(agent);
    agentsByMission.set(agent.missionId, list);
  }

  for (const decision of [...snapshot.decisions].sort((a, b) =>
    newestFirst(a.requestedAt, b.requestedAt)
  )) {
    groups.get('decide')!.push({
      kind: 'decision',
      key: `decision:${decision.id}`,
      lane: 'decide',
      decision,
    });
  }
  for (const agent of snapshot.agents) {
    if (agent.state !== 'blocked') continue;
    groups
      .get('decide')!
      .push({ kind: 'agent', key: `agent:${agent.target}`, lane: 'decide', agent });
  }

  const missions = [...snapshot.missions].sort(
    (a, b) => newestFirst(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id)
  );
  for (const mission of missions) {
    const lane = laneForMission(mission.status);
    groups.get(lane)!.push({
      kind: 'mission',
      key: `mission:${mission.id}`,
      lane,
      mission,
      agents: agentsByMission.get(mission.id) ?? [],
    });
  }

  const done = groups.get('done')!;
  if (done.length > doneLimit) done.splice(doneLimit);

  return LANE_ORDER.map((lane) => ({ lane, items: groups.get(lane)! })).filter(
    (group) => group.items.length > 0
  );
}

export function flattenRail(groups: RailGroup[]): RailItem[] {
  return groups.flatMap((group) => group.items);
}

/** Items that wait on the human: governed decisions + agents blocked on input. */
export function attentionCount(snapshot: DeckSnapshot): number {
  return (
    snapshot.decisions.length + snapshot.agents.filter((agent) => agent.state === 'blocked').length
  );
}

export interface DeckCounts {
  decide: number;
  running: number;
  review: number;
  done: number;
}

export function deckCounts(snapshot: DeckSnapshot): DeckCounts {
  const counts: DeckCounts = { decide: attentionCount(snapshot), running: 0, review: 0, done: 0 };
  for (const mission of snapshot.missions) {
    const lane = laneForMission(mission.status);
    if (lane === 'running') counts.running += 1;
    else if (lane === 'review') counts.review += 1;
    else if (lane === 'done') counts.done += 1;
  }
  return counts;
}

/**
 * Keep the cursor on the same item across refreshes; if it disappeared,
 * stay at the same index (clamped) so the cursor never jumps to the top.
 */
export function reconcileSelection(
  items: readonly { key: string }[],
  selectedKey: string | undefined,
  previousIndex: number
): { key: string | undefined; index: number } {
  if (items.length === 0) return { key: undefined, index: 0 };
  if (selectedKey) {
    const index = items.findIndex((item) => item.key === selectedKey);
    if (index >= 0) return { key: selectedKey, index };
  }
  const index = Math.max(0, Math.min(previousIndex, items.length - 1));
  return { key: items[index]!.key, index };
}

export function missionById(
  snapshot: DeckSnapshot,
  id: string | undefined
): DeckMissionRow | undefined {
  return id ? snapshot.missions.find((mission) => mission.id === id) : undefined;
}
