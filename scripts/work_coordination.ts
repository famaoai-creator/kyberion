import { createStandardYargs, logger } from '@agent/core';
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
  releaseWorkItem,
  renewWorkItemLease,
  updateWorkItem,
  importGitHubIssueWithEvent,
  importJiraIssueWithEvent,
  type WorkBoardType,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStatus,
} from '@agent/core';
import { safeReadFile } from '@agent/core';

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
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
    .command('list-events', 'List coordination events', () => undefined)
    .command('list-leases', 'List active leases', () => undefined)
    .command('import-github-issue-file', 'Import a GitHub issue JSON file', () => undefined)
    .command('import-jira-issue-file', 'Import a Jira issue JSON file', () => undefined)
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
    .parseSync();

  const command = String(argv._[0]);

  switch (command) {
    case 'create-item': {
      const item = createWorkItem({
        title: String(argv.title || ''),
        description: String(argv.description || ''),
        status: argv.status ? (String(argv.status) as WorkItemStatus) : undefined,
        priority: argv.priority ? (String(argv.priority) as WorkItemPriority) : undefined,
        source: argv.source ? (String(argv.source) as WorkItemSource) : undefined,
        sourceRef: argv['source-ref'] ? String(argv['source-ref']) : undefined,
        projectId: argv['project-id'] ? String(argv['project-id']) : undefined,
        assigneePeerId: argv['assignee-peer-id'] ? String(argv['assignee-peer-id']) : undefined,
        assigneeUserId: argv['assignee-user-id'] ? String(argv['assignee-user-id']) : undefined,
        labels: csv(argv.labels),
        dependencies: csv(argv.dependencies),
        metadata: json(argv.metadata),
      });
      print(item);
      break;
    }
    case 'create-board': {
      const board = createBoard({
        boardId: argv['board-id'] ? String(argv['board-id']) : undefined,
        name: String(argv['board-name'] || argv.title || argv['board-id'] || ''),
        type: (argv['board-type'] ? String(argv['board-type']) : 'project') as WorkBoardType,
        filters: json(argv.filters) as any,
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
        assigneePeerId: argv['assignee-peer-id'] ? String(argv['assignee-peer-id']) : undefined,
        assigneeUserId: argv['assignee-user-id'] ? String(argv['assignee-user-id']) : undefined,
        labels: csv(argv.labels),
        dependencies: csv(argv.dependencies),
        metadata: json(argv.metadata),
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
        payload: json(argv.payload),
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
    case 'import-github-issue-file': {
      if (!argv.input) throw new Error('Missing --input issue JSON file');
      const issue = JSON.parse(String(safeReadFile(String(argv.input), { encoding: 'utf8' }) || '{}'));
      const result = importGitHubIssueWithEvent(issue, argv.project ? String(argv.project) : 'github');
      print(result);
      break;
    }
    case 'import-jira-issue-file': {
      if (!argv.input) throw new Error('Missing --input issue JSON file');
      const issue = JSON.parse(String(safeReadFile(String(argv.input), { encoding: 'utf8' }) || '{}'));
      const result = importJiraIssueWithEvent(issue, argv.project ? String(argv.project) : undefined);
      print(result);
      break;
    }
    default:
      throw new Error(`unknown command '${command}'`);
  }
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
