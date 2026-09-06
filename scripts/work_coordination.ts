import { auditChain } from '@agent/core/audit-chain';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  appendCoordinationEvent,
  claimWorkItem,
  createBoard,
  createWorkItem,
  handoffWorkItem,
  listActiveWorkLeases,
  listBoardItems,
  listBoards,
  listCoordinationEvents,
  listWorkItems,
  migrateLegacyWorkItemContexts,
  releaseWorkItem,
  renewWorkItemLease,
  updateWorkItem,
  type WorkBoardType,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemContext,
} from '@agent/core/work-coordination';
import {
  getWorkCoordinationImportCatalogEntryByCommand,
  listWorkCoordinationImportCatalogEntries,
} from '@agent/core/work-coordination-import-catalog';
import type { GitHubIssueLike } from '@agent/core/work-integrations/github-issues';
import type { JiraIssueLike } from '@agent/core/work-integrations/jira-issues';
import { importGitHubIssueWithEvent } from '@agent/core/work-integrations/github-issues';
import { importJiraIssueWithEvent } from '@agent/core/work-integrations/jira-issues';
import {
  buildIntegratedHandoffHistory,
  formatIntegratedHandoffHistory,
} from '@agent/core/handoff-history';
import { loadAiDlcPhaseState } from '@agent/core/aidlc-phase-state';
import { loadStateAtPath } from '@agent/core/mission-state';
import { projectWorkGraphToNextTasks } from '@agent/core/work-graph-projection';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import * as path from 'node:path';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

type Print = (value: unknown) => void;

let workCoordinationPrint: Print = () => undefined;

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseWorkCoordinationJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return parseSafeJsonObjectInput(value, 'work coordination context');
  } catch {
    throw new Error('Expected a safe JSON object.');
  }
}

const WORK_SHAPES = new Set<NonNullable<WorkItemContext['work_shape']>>([
  'solution_project',
  'service_operation',
  'routine_operation',
  'incident_response',
  'governance_cadence',
  'improvement_experiment',
]);

function context(argv: Record<string, unknown>): WorkItemContext | undefined {
  const parsed = parseWorkCoordinationJson(argv.context);
  const value = { ...(parsed || {}) } as Record<string, unknown>;
  const mappings: Array<[string, keyof WorkItemContext & string]> = [
    ['organization-id', 'organization_id'],
    ['tenant-slug', 'tenant_slug'],
    ['mission-id', 'mission_id'],
    ['project-id', 'project_id'],
    ['task-id', 'task_id'],
  ];
  for (const [option, key] of mappings) {
    if (argv[option] !== undefined) value[key] = String(argv[option]);
  }
  if (argv['work-shape'] !== undefined) value.work_shape = String(argv['work-shape']);
  const result: WorkItemContext = {};
  for (const key of [
    'organization_id',
    'tenant_slug',
    'mission_id',
    'project_id',
    'task_id',
  ] as const) {
    if (value[key] !== undefined && String(value[key]).trim())
      result[key] = String(value[key]).trim();
  }
  if (value.work_shape !== undefined) {
    const workShape = String(value.work_shape).trim() as NonNullable<WorkItemContext['work_shape']>;
    if (!WORK_SHAPES.has(workShape)) throw new Error(`Invalid --work-shape: ${workShape}`);
    result.work_shape = workShape;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function print(value: unknown): void {
  workCoordinationPrint(JSON.stringify(value, null, 2));
}

function printText(value: string): void {
  workCoordinationPrint(value);
}

export function resolveWorkCoordinationInputPath(inputPath: string): string {
  return assertSafeRepositoryPath(inputPath);
}

export function loadWorkCoordinationIssue(inputPath: string): GitHubIssueLike | JiraIssueLike {
  return readSafeJsonFile<GitHubIssueLike | JiraIssueLike>(
    resolveWorkCoordinationInputPath(inputPath),
    'work coordination issue input'
  );
}

function discoverReadableMissionStates(): Array<{ missionId: string; state: any }> {
  const roots = [pathResolver.active('missions'), pathResolver.active('archive/missions')];
  const states: Array<{ missionId: string; state: any }> = [];
  const seen = new Set<string>();
  const visit = (root: string, nested = false): void => {
    let safeRoot: string;
    try {
      safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
      if (!safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) return;
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = safeReaddir(safeRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      try {
        const missionDir = assertSafeRepositoryPath(path.join(safeRoot, entry), {
          allowMissingLeaf: true,
        });
        if (!safeLstat(missionDir).isDirectory()) continue;
        const candidate = assertSafeRepositoryPath(path.join(missionDir, 'mission-state.json'), {
          allowMissingLeaf: true,
        });
        if (safeExistsSync(candidate)) {
          try {
            const state = loadStateAtPath(candidate);
            if (state) {
              const missionId = String(state.mission_id || path.basename(missionDir));
              if (!seen.has(missionId)) {
                seen.add(missionId);
                states.push({ missionId, state });
              }
            }
          } catch {
            // Ignore malformed mission state; the history view remains best-effort.
          }
          continue;
        }
        if (!nested) visit(missionDir, true);
      } catch {
        // Ignore unsafe or malformed mission entries; keep safe history visible.
      }
    }
  };
  for (const root of roots) visit(root);
  return states;
}

async function runMain(args: string[] = []): Promise<void> {
  const yargs = createStandardYargs(['node', 'work_coordination', ...args])
    .command('create-item', 'Create a new work item', () => undefined)
    .command('create-board', 'Create or update a board', () => undefined)
    .command('list-board', 'List board items or boards', () => undefined)
    .command('claim-item', 'Claim a work item lease', () => undefined)
    .command('release-item', 'Release a work item lease', () => undefined)
    .command('handoff-item', 'Hand off a leased item to another peer', () => undefined)
    .command('renew-lease', 'Renew a work item lease', () => undefined)
    .command('update-status', 'Update work item fields', () => undefined)
    .command('record-event', 'Append a coordination event', () => undefined)
    .command('list-items', 'List work items', () => undefined)
    .command(
      'project-next-tasks',
      'Project canonical Work Graph into NEXT_TASKS.json',
      () => undefined
    )
    .command(
      'migrate-context',
      'Backfill typed WorkItem context from legacy snapshots',
      () => undefined
    )
    .command('list-events', 'List coordination events', () => undefined)
    .command('list-leases', 'List active leases', () => undefined)
    .command('history <correlationId>', 'Show the integrated handoff history', () => undefined)
    .demandCommand(1)
    .option('item-id', { type: 'string' })
    .option('board-id', { type: 'string' })
    .option('title', { type: 'string' })
    .option('description', { type: 'string' })
    .option('status', { type: 'string' })
    .option('priority', { type: 'string' })
    .option('source', { type: 'string' })
    .option('source-ref', { type: 'string' })
    .option('project-id', { type: 'string' })
    .option('organization-id', { type: 'string' })
    .option('tenant-slug', { type: 'string' })
    .option('mission-id', { type: 'string' })
    .option('task-id', { type: 'string' })
    .option('work-shape', { type: 'string' })
    .option('context', { type: 'string' })
    .option('assignee-peer-id', { type: 'string' })
    .option('assignee-user-id', { type: 'string' })
    .option('labels', { type: 'string' })
    .option('dependencies', { type: 'string' })
    .option('metadata', { type: 'string' })
    .option('board-name', { type: 'string' })
    .option('board-type', { type: 'string' })
    .option('filters', { type: 'string' })
    .option('sort-by', { type: 'string' })
    .option('lane', { type: 'array' })
    .option('lease-id', { type: 'string' })
    .option('actor-peer-id', { type: 'string' })
    .option('actor-user-id', { type: 'string' })
    .option('from-lease-id', { type: 'string' })
    .option('from-peer-id', { type: 'string' })
    .option('to-peer-id', { type: 'string' })
    .option('to-user-id', { type: 'string' })
    .option('purpose', { type: 'string', default: 'implementation' })
    .option('ttl-ms', { type: 'number' })
    .option('expected-version', { type: 'number' })
    .option('idempotency-key', { type: 'string' })
    .option('event-type', { type: 'string' })
    .option('command-id', { type: 'string' })
    .option('note', { type: 'string' })
    .option('payload', { type: 'string' })
    .option('project', { type: 'string' })
    .option('apply', { type: 'boolean', default: false })
    .option('json', { type: 'boolean', default: false });
  for (const entry of listWorkCoordinationImportCatalogEntries()) {
    yargs.command(
      entry.command,
      entry.summary || `Import a ${entry.source} issue JSON file`,
      () => undefined
    );
  }

  const argv = await yargs.parseSync();

  const command = String(argv._[0]);

  switch (command) {
    case 'migrate-context': {
      print({
        quality: migrateLegacyWorkItemContexts({ apply: Boolean(argv.apply) }),
        applied: Boolean(argv.apply),
      });
      break;
    }
    case 'create-item': {
      const item = createWorkItem({
        itemId: argv['item-id'] ? String(argv['item-id']) : undefined,
        title: String(argv.title || ''),
        description: String(argv.description || ''),
        status: argv.status ? (String(argv.status) as WorkItemStatus) : undefined,
        priority: argv.priority ? (String(argv.priority) as WorkItemPriority) : undefined,
        source: argv.source ? (String(argv.source) as WorkItemSource) : undefined,
        sourceRef: argv['source-ref'] ? String(argv['source-ref']) : undefined,
        projectId: argv['project-id'] ? String(argv['project-id']) : undefined,
        context: context(argv as Record<string, unknown>),
        assigneePeerId: argv['assignee-peer-id'] ? String(argv['assignee-peer-id']) : undefined,
        assigneeUserId: argv['assignee-user-id'] ? String(argv['assignee-user-id']) : undefined,
        labels: argv.labels !== undefined ? csv(argv.labels) : undefined,
        dependencies: argv.dependencies !== undefined ? csv(argv.dependencies) : undefined,
        metadata: parseWorkCoordinationJson(argv.metadata),
      });
      print(item);
      break;
    }
    case 'create-board': {
      const board = createBoard({
        boardId: argv['board-id'] ? String(argv['board-id']) : undefined,
        name: String(argv['board-name'] || argv.title || argv['board-id'] || ''),
        type: (argv['board-type'] ? String(argv['board-type']) : 'project') as WorkBoardType,
        filters: parseWorkCoordinationJson(argv.filters) as any,
        sortBy: argv['sort-by'] ? (String(argv['sort-by']) as any) : undefined,
        lanes: Array.isArray(argv.lane) ? argv.lane.map(String) : undefined,
        description: argv.description ? String(argv.description) : undefined,
      });
      print(board);
      break;
    }
    case 'list-board': {
      if (argv['board-id']) {
        print({
          board: argv['board-id'],
          items: listBoardItems(String(argv['board-id'])),
        });
      } else {
        print({
          boards: listBoards(),
        });
      }
      break;
    }
    case 'list-items':
      print({ items: listWorkItems() });
      break;
    case 'project-next-tasks': {
      const missionId = String(argv['mission-id'] || argv['project-id'] || '').trim();
      if (!missionId) throw new Error('project-next-tasks requires --mission-id');
      print(
        projectWorkGraphToNextTasks({
          missionId,
          projectId: argv['project-id'] ? String(argv['project-id']) : undefined,
          tenantSlug: argv['tenant-slug'] ? String(argv['tenant-slug']) : undefined,
          apply: argv.apply === true,
        })
      );
      break;
    }
    case 'claim-item': {
      const result = claimWorkItem({
        itemId: String(argv['item-id'] || ''),
        actorPeerId: String(argv['actor-peer-id'] || ''),
        actorUserId: argv['actor-user-id'] ? String(argv['actor-user-id']) : undefined,
        purpose: String(argv.purpose || 'implementation'),
        ttlMs: argv['ttl-ms'] ? Number(argv['ttl-ms']) : undefined,
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
        idempotencyKey: argv['idempotency-key'] ? String(argv['idempotency-key']) : undefined,
      });
      print(result);
      break;
    }
    case 'release-item': {
      const result = releaseWorkItem({
        itemId: String(argv['item-id'] || ''),
        leaseId: String(argv['lease-id'] || ''),
        actorPeerId: String(argv['actor-peer-id'] || ''),
        actorUserId: argv['actor-user-id'] ? String(argv['actor-user-id']) : undefined,
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
        nextStatus: argv.status ? (String(argv.status) as WorkItemStatus) : undefined,
      });
      print(result);
      break;
    }
    case 'handoff-item': {
      const result = handoffWorkItem({
        itemId: String(argv['item-id'] || ''),
        fromLeaseId: String(argv['from-lease-id'] || ''),
        fromPeerId: String(argv['from-peer-id'] || ''),
        toPeerId: String(argv['to-peer-id'] || ''),
        toUserId: argv['to-user-id'] ? String(argv['to-user-id']) : undefined,
        purpose: String(argv.purpose || 'implementation'),
        ttlMs: argv['ttl-ms'] ? Number(argv['ttl-ms']) : undefined,
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
        idempotencyKey: argv['idempotency-key'] ? String(argv['idempotency-key']) : undefined,
      });
      print(result);
      break;
    }
    case 'renew-lease': {
      const lease = renewWorkItemLease({
        leaseId: String(argv['lease-id'] || ''),
        ttlMs: argv['ttl-ms'] ? Number(argv['ttl-ms']) : undefined,
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
      });
      print(lease);
      break;
    }
    case 'update-status': {
      const item = updateWorkItem({
        itemId: String(argv['item-id'] || ''),
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
        status: argv.status ? (String(argv.status) as WorkItemStatus) : undefined,
        title: argv.title ? String(argv.title) : undefined,
        description: argv.description ? String(argv.description) : undefined,
        priority: argv.priority ? (String(argv.priority) as WorkItemPriority) : undefined,
        projectId: argv['project-id'] ? String(argv['project-id']) : undefined,
        context: context(argv as Record<string, unknown>),
        assigneePeerId: argv['assignee-peer-id'] ? String(argv['assignee-peer-id']) : undefined,
        assigneeUserId: argv['assignee-user-id'] ? String(argv['assignee-user-id']) : undefined,
        labels: argv.labels !== undefined ? csv(argv.labels) : undefined,
        dependencies: argv.dependencies !== undefined ? csv(argv.dependencies) : undefined,
        metadata: parseWorkCoordinationJson(argv.metadata),
      });
      print(item);
      break;
    }
    case 'record-event': {
      const event = appendCoordinationEvent({
        eventType: String(argv['event-type'] || 'item_updated') as any,
        itemId: argv['item-id'] ? String(argv['item-id']) : undefined,
        boardId: argv['board-id'] ? String(argv['board-id']) : undefined,
        leaseId: argv['lease-id'] ? String(argv['lease-id']) : undefined,
        actorPeerId: argv['actor-peer-id'] ? String(argv['actor-peer-id']) : undefined,
        actorUserId: argv['actor-user-id'] ? String(argv['actor-user-id']) : undefined,
        commandId: argv['command-id'] ? String(argv['command-id']) : undefined,
        idempotencyKey: argv['idempotency-key'] ? String(argv['idempotency-key']) : undefined,
        expectedVersion: argv['expected-version'] ? Number(argv['expected-version']) : undefined,
        note: argv.note ? String(argv.note) : undefined,
        payload: parseWorkCoordinationJson(argv.payload),
      });
      print(event);
      break;
    }
    case 'list-events':
      print({ events: listCoordinationEvents() });
      break;
    case 'list-leases':
      print({ leases: listActiveWorkLeases() });
      break;
    case 'history': {
      const correlationId = String(argv.correlationId || '').trim();
      if (!correlationId) throw new Error('Missing correlation id');
      const missions = discoverReadableMissionStates().flatMap(({ missionId, state }) => {
        let aidlcState = null;
        try {
          aidlcState = loadAiDlcPhaseState(missionId);
        } catch {
          // Keep the mission row; its phase state may be in a restricted tier.
        }
        return [
          {
            missionId,
            state,
            aidlcState,
          },
        ];
      });
      const rows = buildIntegratedHandoffHistory({
        correlationId,
        missions,
        coordinationEvents: listCoordinationEvents(),
        auditEntries: auditChain.loadAll(),
      });
      if (argv.json) print({ correlationId, rows });
      else printText(formatIntegratedHandoffHistory(correlationId, rows));
      break;
    }
    default: {
      const importEntry = getWorkCoordinationImportCatalogEntryByCommand(command);
      if (!importEntry) {
        throw new Error(`unknown command '${command}'`);
      }
      if (!argv.input) throw new Error('Missing --input issue JSON file');
      const issue = loadWorkCoordinationIssue(String(argv.input));
      const projectId = argv.project
        ? String(argv.project)
        : importEntry.default_project_id || undefined;
      const result =
        importEntry.source === 'github'
          ? importGitHubIssueWithEvent(issue as GitHubIssueLike, projectId || 'github')
          : importJiraIssueWithEvent(issue as JiraIssueLike, projectId);
      print(result);
      break;
    }
  }
}

export async function main(args: string[] = [], output: Print = () => undefined): Promise<void> {
  const previousPrint = workCoordinationPrint;
  workCoordinationPrint = output;
  try {
    await runMain(args);
  } finally {
    workCoordinationPrint = previousPrint;
  }
}

export const runWorkCoordination = defineScript({
  name: 'work:coordination',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'work_coordination.ts') ||
  isDirectScript(import.meta.url, 'work_coordination.js')
)
  void runWorkCoordination();
