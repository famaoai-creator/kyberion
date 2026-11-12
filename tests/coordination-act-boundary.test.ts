import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import {
  COORDINATION_ACTS,
  isCoordinationAct,
  type CoordinationActMapping,
} from '@agent/core/foundation/coordination-act';
import * as actMap from '@agent/core/mesh/coordination-act-map';
import { A2A_PERFORMATIVES } from '@agent/core/mesh/a2a-bridge';
import { PEER_MESSAGE_TYPES } from '@agent/core/mesh/peer-messaging';
import { PEER_CONVERSATION_MESSAGE_KINDS } from '@agent/core/mesh/peer-conversation';
import { MESH_DELIVERY_STATUSES, MESH_REQUEST_KINDS } from '@agent/core/mesh/mesh-hub-contract';
import {
  PEER_TASK_REQUEST_KIND,
  PEER_TASK_RESULT_KIND,
  PEER_TASK_RESULT_STATUSES,
  PEER_TASK_STATES,
} from '@agent/core/mesh/peer-task-exchange';
import { CO_SESSION_HANDOFF_KINDS } from '@agent/core/co-session';
import { AGENT_EXECUTION_RECEIPT_STATUSES } from '@agent/core/agent/agent-execution-port';

/**
 * Coordination-act gate (agent-communication-layer-model §11).
 *
 * Each communication layer keeps its own wire kinds; each kind maps to one
 * canonical coordination act or to an explicit "not an act" with a reason in
 * libs/core/mesh/coordination-act-map.ts. The compiler already rejects a table
 * that misses a kind, adds one, or targets a non-act (the tables are built from
 * `Record<LayerKind, …>` literals). This gate adds the runtime side:
 *
 * 1. every layer that exports a const array has a table with exactly its members;
 * 2. every table value is a canonical act or a reasoned non-act;
 * 3. known copies of a layer vocabulary (schema enum, re-declared unions) still
 *    equal the exported array;
 * 4. no module in the communication directories declares an act-like literal
 *    union or string array without being registered below.
 */

type Table = Readonly<Record<string, CoordinationActMapping>>;

/** Layers whose kinds are an exported const array: table keys must equal the array. */
const ARRAY_LAYERS: ReadonlyArray<{ name: string; kinds: readonly string[]; table: Table }> = [
  { name: 'A2A performative', kinds: A2A_PERFORMATIVES, table: actMap.A2A_PERFORMATIVE_ACTS },
  { name: 'peer message type', kinds: PEER_MESSAGE_TYPES, table: actMap.PEER_MESSAGE_TYPE_ACTS },
  {
    name: 'peer conversation message kind',
    kinds: PEER_CONVERSATION_MESSAGE_KINDS,
    table: actMap.PEER_CONVERSATION_MESSAGE_KIND_ACTS,
  },
  { name: 'mesh request kind', kinds: MESH_REQUEST_KINDS, table: actMap.MESH_REQUEST_KIND_ACTS },
  {
    name: 'mesh delivery status',
    kinds: MESH_DELIVERY_STATUSES,
    table: actMap.MESH_DELIVERY_STATUS_ACTS,
  },
  {
    name: 'peer task message kind',
    kinds: [PEER_TASK_REQUEST_KIND, PEER_TASK_RESULT_KIND],
    table: actMap.PEER_TASK_MESSAGE_KIND_ACTS,
  },
  { name: 'peer task state', kinds: PEER_TASK_STATES, table: actMap.PEER_TASK_STATE_ACTS },
  {
    name: 'peer task result status',
    kinds: PEER_TASK_RESULT_STATUSES,
    table: actMap.PEER_TASK_RESULT_STATUS_ACTS,
  },
  {
    name: 'co-session handoff kind',
    kinds: CO_SESSION_HANDOFF_KINDS,
    table: actMap.CO_SESSION_HANDOFF_KIND_ACTS,
  },
  {
    name: 'agent execution receipt status',
    kinds: AGENT_EXECUTION_RECEIPT_STATUSES,
    table: actMap.AGENT_EXECUTION_RECEIPT_STATUS_ACTS,
  },
];

const rootDir = process.cwd();

/** Directories whose modules declare communication vocabularies. */
const COMMUNICATION_DIRS = [
  'libs/core/mesh',
  'libs/core/workforce',
  'libs/core/mission',
  'libs/core/agent',
  'libs/core/discussion',
  'libs/actuators/network-actuator/src',
  'libs/actuators/orchestrator-actuator/src',
];

/** Word segments that make a literal look like a speech act or message kind. */
const ACT_WORDS = new Set([
  'request',
  'propose',
  'proposal',
  'accept',
  'reject',
  'inform',
  'notification',
  'notify',
  'query',
  'result',
  'reply',
  'response',
  'handoff',
]);

/**
 * Every module whose source declares an act-like literal set, with what that
 * set is. A layer vocabulary names its table in coordination-act-map.ts; a set
 * that is not a coordination vocabulary says why.
 */
const REGISTERED_DECLARATIONS: Readonly<Record<string, string>> = {
  'libs/core/mesh/a2a-bridge.ts': 'A2A_PERFORMATIVE_ACTS',
  'libs/core/mesh/peer-messaging.ts': 'PEER_MESSAGE_TYPE_ACTS',
  'libs/core/mesh/mesh-hub-contract.ts':
    'MESH_REQUEST_KIND_ACTS (MESH_RECEIVE_MODES is receive-side configuration, not a message kind)',
  'libs/core/mesh/peer-conversation.ts': 'PEER_CONVERSATION_MESSAGE_KIND_ACTS',
  'libs/core/workforce/co-session.ts': 'CO_SESSION_HANDOFF_KIND_ACTS',
  'libs/core/mesh/mesh-hub-peer-messaging-adapter.ts':
    'MESH_WORKITEM_COMMAND_ACTS (command_type of the stored workitem-command payload)',
  'libs/core/discussion/discussion-types.ts': 'DISCUSSION_PERFORMATIVE_ACTS',
  'libs/core/discussion/discussion-speaker.ts':
    'DISCUSSION_PERFORMATIVE_ACTS (zod enum copy of DiscussionPerformative)',
  'libs/actuators/orchestrator-actuator/src/super-nerve/index.ts':
    'A2A_PERFORMATIVE_ACTS (re-declared A2AMessage; members checked against A2A_PERFORMATIVES)',
  // Not coordination vocabularies:
  'libs/actuators/network-actuator/src/op-catalog.ts':
    'not a vocabulary: network op names (json_query, distill_response)',
  'libs/core/workforce/review-reentry.ts':
    'not a vocabulary: a human review verdict on a deliverable, recorded for re-entry, not an inter-agent message',
  'libs/core/workforce/work-coordination-evidence.ts':
    'not a vocabulary: WorkItem evidence event types (handoff_written, review_requested, …) record what happened',
  'libs/core/workforce/work-coordination-types.ts':
    'not a vocabulary: WorkItem event types and categories, same ledger as work-coordination-evidence',
  'libs/core/workforce/worker-event-stream.ts':
    'not a vocabulary: one worker’s observability events; approval_request/response belong to the approval domain',
};

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

const LITERAL = `'[A-Za-z0-9_.-]+'`;
const UNION_RUN = new RegExp(`${LITERAL}(?:\\s*\\|\\s*${LITERAL})+`, 'g');
const ARRAY_RUN = new RegExp(`\\[\\s*${LITERAL}(?:\\s*,\\s*${LITERAL})+\\s*,?\\s*\\]`, 'g');

function isActLike(member: string): boolean {
  return member.split(/[._-]/).some((segment) => ACT_WORDS.has(segment));
}

/** Literal unions and string-literal arrays with two or more act-like members. */
export function actLikeDeclarations(source: string): string[][] {
  const stripped = stripComments(source);
  const runs = [...(stripped.match(UNION_RUN) ?? []), ...(stripped.match(ARRAY_RUN) ?? [])];
  return runs
    .map((run) => [...run.matchAll(/'([A-Za-z0-9_.-]+)'/g)].map((match) => match[1]))
    .filter((members) => members.filter(isActLike).length >= 2);
}

function literalUnionMembers(source: string, anchor: RegExp): string[] {
  const match = stripComments(source).match(anchor);
  if (!match) return [];
  return [...match[1].matchAll(/'([A-Za-z0-9_.-]+)'/g)].map((entry) => entry[1]);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function communicationModules(): string[] {
  return COMMUNICATION_DIRS.flatMap((dir) => getAllFiles(path.join(rootDir, dir)))
    .map((filePath) => normalize(path.relative(rootDir, filePath)))
    .filter((relPath) => /\.(ts|tsx)$/.test(relPath))
    .filter((relPath) => !/\.test\.tsx?$/.test(relPath) && !relPath.endsWith('.d.ts'))
    .filter((relPath) => !relPath.includes('/dist/') && !relPath.includes('/node_modules/'))
    .sort();
}

const ALL_TABLES = Object.entries(actMap).filter(
  (entry): entry is [string, Table] => entry[0].endsWith('_ACTS') && typeof entry[1] === 'object'
);

describe('coordination-act gate', () => {
  it('declares a closed, duplicate-free canonical act set', () => {
    expect(COORDINATION_ACTS.length).toBeGreaterThan(0);
    expect(new Set(COORDINATION_ACTS).size).toBe(COORDINATION_ACTS.length);
    expect(Object.isFrozen(COORDINATION_ACTS)).toBe(true);
  });

  it('maps every member of each exported layer array, and nothing else', () => {
    for (const layer of ARRAY_LAYERS) {
      expect(sorted(Object.keys(layer.table)), layer.name).toEqual(sorted(layer.kinds));
    }
  });

  it('maps every kind to a canonical act or to a non-act with a reason', () => {
    expect(ALL_TABLES.length).toBeGreaterThanOrEqual(ARRAY_LAYERS.length);
    for (const [name, table] of ALL_TABLES) {
      for (const [kind, mapping] of Object.entries(table)) {
        if (typeof mapping === 'string') {
          expect(isCoordinationAct(mapping), `${name}.${kind} -> ${mapping}`).toBe(true);
        } else {
          expect(mapping.act, `${name}.${kind}`).toBeNull();
          expect(mapping.reason.trim().length, `${name}.${kind} reason`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('maps the kinds Co-Session shares with Mesh Hub the same way', () => {
    for (const kind of CO_SESSION_HANDOFF_KINDS) {
      if (!(MESH_REQUEST_KINDS as readonly string[]).includes(kind)) continue;
      expect(actMap.CO_SESSION_HANDOFF_KIND_ACTS[kind], kind).toEqual(
        actMap.MESH_REQUEST_KIND_ACTS[kind]
      );
    }
  });

  it('maps a Mesh workitem request kind and the stored command it records the same way', () => {
    const commandFor = {
      'workitem.claim': 'claim_request',
      'workitem.handoff': 'handoff_request',
      'workitem.status_update': 'status_update',
    } as const;
    for (const [kind, command] of Object.entries(commandFor)) {
      expect(actMap.MESH_WORKITEM_COMMAND_ACTS[command], command).toEqual(
        actMap.MESH_REQUEST_KIND_ACTS[kind as keyof typeof commandFor]
      );
    }
  });

  it('names an existing table for every registered layer declaration', () => {
    for (const [relPath, entry] of Object.entries(REGISTERED_DECLARATIONS)) {
      if (entry.startsWith('not a vocabulary:')) continue;
      const tableName = entry.split(' ')[0];
      expect(
        ALL_TABLES.some(([name]) => name === tableName),
        `${relPath} -> ${tableName}`
      ).toBe(true);
    }
  });

  it('keeps known copies of the A2A performative set equal to A2A_PERFORMATIVES', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/schemas/a2a-envelope.schema.json'), {
        encoding: 'utf8',
      }) as string
    ) as { properties: { header: { properties: { performative: { enum: string[] } } } } };
    expect(sorted(schema.properties.header.properties.performative.enum)).toEqual(
      sorted(A2A_PERFORMATIVES)
    );
    const superNerve = safeReadFile(
      path.join(rootDir, 'libs/actuators/orchestrator-actuator/src/super-nerve/index.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(sorted(literalUnionMembers(superNerve, /performative:\s*([^;]+);/))).toEqual(
      sorted(A2A_PERFORMATIVES)
    );
    const responseBlocks = safeReadFile(
      path.join(rootDir, 'libs/core/surface/surface-response-blocks.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(
      sorted(literalUnionMembers(responseBlocks, /const performatives = new Set\(\[([^\]]+)\]/))
    ).toEqual(sorted(A2A_PERFORMATIVES));
  });

  it('detects act-like declarations and ignores unrelated literal sets', () => {
    expect(actLikeDeclarations("type K = 'request' | 'reply' | 'close';")).toHaveLength(1);
    expect(
      actLikeDeclarations("const K = ['review.request', 'capability_query'] as const;")
    ).toHaveLength(1);
    expect(actLikeDeclarations("type S = 'pending' | 'accepted' | 'rejected';")).toHaveLength(0);
    expect(actLikeDeclarations("type D = 'inbound' | 'outbound';")).toHaveLength(0);
    expect(actLikeDeclarations("// type K = 'request' | 'reply';")).toHaveLength(0);
  });

  it('registers every communication module that declares an act-like literal set', () => {
    const declaring = communicationModules().filter(
      (relPath) =>
        actLikeDeclarations(
          safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string
        ).length > 0
    );
    const unregistered = declaring.filter((relPath) => !(relPath in REGISTERED_DECLARATIONS));
    expect(
      unregistered,
      'add a table to libs/core/mesh/coordination-act-map.ts and register the module here'
    ).toEqual([]);
    const stale = Object.keys(REGISTERED_DECLARATIONS).filter(
      (relPath) => !declaring.includes(relPath)
    );
    expect(stale, 'remove registrations whose module no longer declares an act-like set').toEqual(
      []
    );
  });
});
