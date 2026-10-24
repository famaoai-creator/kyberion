/**
 * customer_decision.ts — the governed facade of customer decision hearing
 * (CD-05 / CD-06 / CD-08, plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
 *
 * The only writer of agendas, receipts, switches, invites and the customer
 * decisions they put in the SSOD ledger. The customer-room display runs the
 * built script (`dist/scripts/customer_decision.js`) as a child process for
 * `view` / `respond` and never touches the stores itself.
 *
 * Operator verbs (all take --tenant <slug> --case <id>; --json for machine output):
 *   draft    --customer <slug> [--template aidlc-inception] [--title <t>] [--from <text>] [--locale ja|en] [--deal <id>] [--project <id>]
 *   draft    --agenda <id> --file <agenda.json>        replace title/from/entries (an approved/sent agenda becomes a new revision)
 *   draft    --from-tasks [--agenda <draft id>] [--customer <slug>]   collect mission tasks' customer-judgment proposals (CD-09) into a draft agenda
 *   generate --agenda <id> --intent-file <path> [--grounding-file <path>]
 *   submit   --agenda <id> --by user:<member> [--role owner|approver]
 *   actor-add --customer <slug> --actor customer:<id> --name <text> [--confirm-target <text>]
 *   send     --agenda <id> --name <participant> --role decider|contributor --actor customer:<id> [--ttl-days 14] [--by user:<member>]
 *   status   [--agenda <id>]                            also completes interrupted responses; lists task proposals and held tasks
 *   confirm  --agenda <id> --entry <entry_id> --by user:<member>   confirm a customer decision on a requires_customer entry (approval gate)
 *   close    --agenda <id> --by user:<member> [--reason <text>]   stop taking answers; links answer `closed`
 *   withdraw --agenda <id> --by user:<member> [--reason <text>]   revoke the agenda's open invites and withdraw it
 *   revoke   --invite <id> --reason <text>
 *
 * Customer-room verbs (token on STDIN only, never argv; --case is optional and
 * must match the invite when given):
 *   view     --tenant <slug>    stdin {"token"}
 *   respond  --tenant <slug>    stdin {"token","content_hash","answers":[...]}
 *
 * `send` prints the invite link once on stdout; the token is never written to
 * disk, logs or the audit chain. Delivering the link through a bound customer
 * channel (`sendToCustomer`) needs a bridge-supplied `deliver` and is not part
 * of stage 1 — the operator forwards the link.
 *
 * `--dir <path>` (test runs only: refused unless VITEST or NODE_ENV=test)
 * replaces the case directory; invites still live in the tenant's runtime
 * partition.
 *
 * Modules: `scripts/customer-decision/` — `common.ts` (arguments, roles,
 * audit, agenda helpers), `operator.ts` (draft … send), `operator-lifecycle.ts`
 * (status, confirm, close / withdraw, revoke), `reconcile.ts` (respond
 * completion and recovery), `customer-facing.ts` (view / respond),
 * `task-proposals.ts` (draft --from-tasks, the task part of status). This file
 * is the entry point; the room spawns `dist/scripts/customer_decision.js`.
 *
 * Consistency: every read → plan → write sequence on a case runs under the
 * case lock (`withCustomerDecisionCaseLock`), which also holds the decision
 * ledger lock that every ledger writer (this facade and `pnpm decisions`)
 * takes inside `appendDecisions` / `applyPromotions`. `respond` writes a write-ahead
 * journal record before the ledger append (receipt with pre-assigned decision
 * ids + the effective decisions before), then ledger → receipt → audit →
 * switches → brief input, and removes the record. A run that stopped part way
 * is completed by the next respond / confirm / submit / status of the case
 * (`reconcileCase`). The deal note is best-effort and never fails a respond.
 */
import { nowIso } from '@agent/core/foundation';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import {
  type CustomerDecisionIo,
  parseCustomerDecisionArgs,
  usage,
  usageError,
} from './customer-decision/common.js';
import {
  runDraft,
  runGenerate,
  runSubmit,
  runActorAdd,
  runSend,
} from './customer-decision/operator.js';
import {
  runStatus,
  runConfirm,
  runEnd,
  runRevoke,
} from './customer-decision/operator-lifecycle.js';
import { runCustomerFacing } from './customer-decision/customer-facing.js';
import { runCollectTaskProposals } from './customer-decision/task-proposals.js';

export {
  AGENDA_APPROVE_OPERATION,
  OPERATOR_CONFIRM_OPERATION,
  diagnosticCode,
  parseCustomerDecisionArgs,
  type CustomerDecisionIo,
} from './customer-decision/common.js';
export type { CustomerFacingFailure } from './customer-decision/customer-facing.js';

export async function runCustomerDecision(
  argv: readonly string[],
  io: CustomerDecisionIo = {}
): Promise<unknown> {
  const { verb, opts, flags } = parseCustomerDecisionArgs(argv);
  const now = io.now ? io.now() : nowIso();
  switch (verb) {
    case 'help':
    case '--help':
    case '-h':
      return usage();
    case 'draft':
      return flags.has('from-tasks') ? runCollectTaskProposals(opts, now) : runDraft(opts, now);
    case 'generate':
      return runGenerate(opts, now);
    case 'submit':
      return runSubmit(opts, now);
    case 'actor-add':
      return runActorAdd(opts);
    case 'send':
      return runSend(opts, now);
    case 'status':
      return runStatus(opts, now);
    case 'confirm':
      return runConfirm(opts, now);
    case 'close':
    case 'withdraw':
      return runEnd(verb, opts, now);
    case 'revoke':
      return runRevoke(opts, now);
    case 'view':
    case 'respond':
      return runCustomerFacing(verb, opts, io, now);
    default:
      throw usageError(`unknown verb '${verb}'`);
  }
}

export const runCustomerDecisionScript = defineScript({
  name: 'customer-decision',
  flags: ['json', 'quiet'],
  run: async (context) => {
    try {
      const result = await runCustomerDecision(
        context.argv.filter((arg) => arg !== '--json' && arg !== '--quiet')
      );
      context.print(result);
      return result;
    } catch (error) {
      if (error instanceof ScriptExitError) {
        if (error.returnValue !== undefined) context.print(error.returnValue);
        throw error;
      }
      throw new ScriptExitError(2, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'customer_decision.ts') ||
  isDirectScript(import.meta.url, 'customer_decision.js')
) {
  void runCustomerDecisionScript(currentProcessArgv().slice(2));
}
