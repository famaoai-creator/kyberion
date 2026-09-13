/**
 * co_session.ts — CLI for same-checkout multi-provider coordination.
 *
 * @see knowledge/product/architecture/co-session-coordination.md
 */
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  CO_SESSION_HANDOFF_KINDS,
  CO_SESSION_PROVIDERS,
  acquireCoSessionLease,
  ackCoSessionHandoff,
  appendCoSessionBlackboard,
  buildCoSessionPromoteHint,
  closeCoSession,
  createCoSessionHandoff,
  getCoSessionStatus,
  heartbeatCoSession,
  joinCoSession,
  leaveCoSession,
  listCoSessionHandoffs,
  listCoSessionLeases,
  readCoSessionBlackboard,
  releaseCoSessionLease,
  startCoSession,
} from '@agent/core/co-session';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

function providerChoices(): string[] {
  return [...CO_SESSION_PROVIDERS];
}

function kindChoices(): string[] {
  return [...CO_SESSION_HANDOFF_KINDS];
}

export async function main(args: string[] = [], print: Print = console.log): Promise<unknown> {
  const yargs = createStandardYargs(['node', 'co_session', ...args])
    .scriptName('co-session')
    .usage('$0 <command> [options]')
    .command(
      'start',
      'Start a sticky co-session for this checkout',
      (cmd) =>
        cmd
          .option('goal', { type: 'string', demandOption: true })
          .option('as', { type: 'string', choices: providerChoices(), demandOption: true })
          .option('session-id', { type: 'string' })
          .option('no-sticky', { type: 'boolean', default: false }),
      (argv) => {
        print(
          startCoSession({
            goal: String(argv.goal),
            provider: String(argv.as),
            session_id: argv['session-id'] ? String(argv['session-id']) : undefined,
            sticky: !argv['no-sticky'],
          })
        );
      }
    )
    .command(
      'join',
      'Join an existing or sticky co-session',
      (cmd) =>
        cmd
          .option('as', { type: 'string', choices: providerChoices(), demandOption: true })
          .option('session-id', { type: 'string' })
          .option('participant-id', { type: 'string' })
          .option('note', { type: 'string' }),
      (argv) => {
        print(
          joinCoSession({
            provider: String(argv.as),
            session_id: argv['session-id'] ? String(argv['session-id']) : undefined,
            participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
            note: argv.note ? String(argv.note) : undefined,
          })
        );
      }
    )
    .command(
      'heartbeat',
      'Refresh presence heartbeat',
      (cmd) =>
        cmd
          .option('as', { type: 'string', choices: providerChoices(), demandOption: true })
          .option('session-id', { type: 'string' })
          .option('participant-id', { type: 'string' }),
      (argv) => {
        print(
          heartbeatCoSession({
            provider: String(argv.as),
            session_id: argv['session-id'] ? String(argv['session-id']) : undefined,
            participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
          })
        );
      }
    )
    .command(
      'leave',
      'Leave the session and release own path leases',
      (cmd) =>
        cmd
          .option('as', { type: 'string', choices: providerChoices(), demandOption: true })
          .option('session-id', { type: 'string' })
          .option('participant-id', { type: 'string' }),
      (argv) => {
        print(
          leaveCoSession({
            provider: String(argv.as),
            session_id: argv['session-id'] ? String(argv['session-id']) : undefined,
            participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
          })
        );
      }
    )
    .command(
      'close',
      'Close the co-session and release all leases',
      (cmd) =>
        cmd
          .option('as', { type: 'string', choices: providerChoices(), demandOption: true })
          .option('session-id', { type: 'string' }),
      (argv) => {
        print(
          closeCoSession({
            provider: String(argv.as),
            session_id: argv['session-id'] ? String(argv['session-id']) : undefined,
          })
        );
      }
    )
    .command(
      'status',
      'Show session, presence, active leases, pending handoffs',
      (cmd) => cmd.option('session-id', { type: 'string' }),
      (argv) => {
        print(getCoSessionStatus(argv['session-id'] ? String(argv['session-id']) : undefined));
      }
    )
    .command(
      'blackboard',
      'Show or append the shared blackboard',
      (cmd) =>
        cmd
          .option('session-id', { type: 'string' })
          .option('append', { type: 'string' })
          .option('as', { type: 'string', choices: providerChoices() }),
      (argv) => {
        const sessionId = argv['session-id'] ? String(argv['session-id']) : undefined;
        if (argv.append) {
          if (!argv.as) throw new Error('blackboard --append requires --as');
          print(
            appendCoSessionBlackboard({
              session_id: sessionId,
              provider: String(argv.as),
              text: String(argv.append),
            })
          );
          return;
        }
        print(readCoSessionBlackboard(sessionId));
      }
    )
    .command(
      'lease',
      'Path lease acquire / release / list',
      (cmd) =>
        cmd
          .option('action', {
            type: 'string',
            choices: ['acquire', 'release', 'list'],
            demandOption: true,
          })
          .option('as', { type: 'string', choices: providerChoices() })
          .option('path', { type: 'string' })
          .option('session-id', { type: 'string' })
          .option('participant-id', { type: 'string' })
          .option('purpose', { type: 'string' })
          .option('ttl-ms', { type: 'number' }),
      (argv) => {
        const sessionId = argv['session-id'] ? String(argv['session-id']) : undefined;
        const action = String(argv.action);
        if (action === 'list') {
          print(listCoSessionLeases(sessionId));
          return;
        }
        if (!argv.as || !argv.path) throw new Error(`lease ${action} requires --as and --path`);
        if (action === 'acquire') {
          print(
            acquireCoSessionLease({
              session_id: sessionId,
              provider: String(argv.as),
              path: String(argv.path),
              participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
              purpose: argv.purpose ? String(argv.purpose) : undefined,
              ttl_ms: typeof argv['ttl-ms'] === 'number' ? argv['ttl-ms'] : undefined,
            })
          );
          return;
        }
        print(
          releaseCoSessionLease({
            session_id: sessionId,
            provider: String(argv.as),
            path: String(argv.path),
            participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
          })
        );
      }
    )
    .command(
      'handoff',
      'Create / list / ack Mesh-aligned handoffs',
      (cmd) =>
        cmd
          .option('action', {
            type: 'string',
            choices: ['create', 'list', 'ack'],
            demandOption: true,
          })
          .option('as', { type: 'string', choices: providerChoices() })
          .option('kind', { type: 'string', choices: kindChoices() })
          .option('to', { type: 'string', choices: providerChoices() })
          .option('to-participant-id', { type: 'string' })
          .option('from-participant-id', { type: 'string' })
          .option('participant-id', { type: 'string' })
          .option('subject', { type: 'string' })
          .option('body', { type: 'string' })
          .option('handoff-id', { type: 'string' })
          .option('session-id', { type: 'string' })
          .option('pending-only', { type: 'boolean', default: false }),
      (argv) => {
        const sessionId = argv['session-id'] ? String(argv['session-id']) : undefined;
        const action = String(argv.action);
        if (action === 'list') {
          print(
            listCoSessionHandoffs(sessionId, {
              pendingOnly: Boolean(argv['pending-only']),
              to_provider: argv.to ? String(argv.to) : undefined,
              to_participant_id: argv['to-participant-id']
                ? String(argv['to-participant-id'])
                : undefined,
            })
          );
          return;
        }
        if (action === 'ack') {
          if (!argv.as || !argv['handoff-id']) {
            throw new Error('handoff ack requires --as and --handoff-id');
          }
          print(
            ackCoSessionHandoff({
              session_id: sessionId,
              provider: String(argv.as),
              handoff_id: String(argv['handoff-id']),
              participant_id: argv['participant-id'] ? String(argv['participant-id']) : undefined,
            })
          );
          return;
        }
        if (!argv.as || !argv.kind || !argv.body) {
          throw new Error('handoff create requires --as --kind --body');
        }
        print(
          createCoSessionHandoff({
            session_id: sessionId,
            from_provider: String(argv.as),
            from_participant_id: argv['from-participant-id']
              ? String(argv['from-participant-id'])
              : argv['participant-id']
                ? String(argv['participant-id'])
                : undefined,
            kind: String(argv.kind),
            to_provider: argv.to ? String(argv.to) : undefined,
            to_participant_id: argv['to-participant-id']
              ? String(argv['to-participant-id'])
              : undefined,
            subject: argv.subject ? String(argv.subject) : undefined,
            body: String(argv.body),
          })
        );
      }
    )
    .command(
      'promote-hint',
      'Show how to lift this co-session to peer messaging or a mission (does not execute)',
      (cmd) => cmd.option('session-id', { type: 'string' }),
      (argv) => {
        print(
          buildCoSessionPromoteHint(argv['session-id'] ? String(argv['session-id']) : undefined)
        );
      }
    )
    .demandCommand(1)
    .strict()
    .help();

  await yargs.parseAsync();
  return undefined;
}

export const runCoSessionCli = defineScript({
  name: 'co-session',
  flags: ['json', 'quiet'],
  run: async ({ argv, print, json }) => {
    const forwarded = argv.filter((arg) => arg !== '--json' && arg !== '--quiet');
    const out: unknown[] = [];
    const capture: Print = (value) => {
      out.push(value);
      if (json) print(value);
      else if (typeof value === 'string') print(value);
      else print(value);
    };
    await main(forwarded, capture);
    return out.length === 1 ? out[0] : out;
  },
});

if (
  isDirectScript(import.meta.url, 'co_session.ts') ||
  isDirectScript(import.meta.url, 'co_session.js')
) {
  void runCoSessionCli();
}
