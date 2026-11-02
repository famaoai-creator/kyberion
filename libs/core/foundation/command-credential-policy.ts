/**
 * Declarative per-verb credential requirements for command bootstrap.
 *
 * The bootstrap gate must key on `verb requirement × binding presence`, not
 * `tenant scope × bootstrap`: a persisted tenant scope is ambient context, not
 * a demand for credentials. Verbs declare how they relate to tenant
 * credentials and model backends:
 *
 * - `'none'`: never consumes tenant credentials or a model. Bootstrap is
 *   skipped entirely (also keeps per-spawn probes cheap).
 * - `'degrading'`: may use a model/backend when one is bound, but must complete
 *   without one. Under `binding_required` the bootstrap leaves the
 *   deterministic stub chain in place instead of throwing; point-of-use
 *   credential checks remain fail-closed.
 * - `'required'`: consumes tenant credentials or a real model backend. Under
 *   `binding_required` the bootstrap fails closed at install time.
 *
 * Unclassified verbs default to `'required'`: unknown actions fail safe toward
 * binding — delegation must never silently fall back to the stub.
 */
export type CredentialRequirement = 'none' | 'degrading' | 'required';

/**
 * mission_controller action → requirement. Journal/state/view verbs that never
 * invoke a model are 'none'. `memory-promote`/`memory-promote-pending` reach a
 * reasoning backend only for the optional contradiction check and already
 * degrade on the stub backend, so they are 'degrading'. Dispatch verbs are not
 * listed: their bootstrap variant (`prepareReasoningExecutionHost`) binds
 * credentials only after a WorkItem claim and is handled separately.
 */
const MISSION_ACTION_REQUIREMENTS: Readonly<Record<string, CredentialRequirement>> = {
  help: 'none',
  // Persist/activate agreed intent; execution and delegation occur later.
  create: 'none',
  start: 'none',
  kickoff: 'none',
  'record-task': 'none',
  'record-evidence': 'none',
  // Registers an already performed review; it does not run model inference.
  'review-task': 'none',
  // Journal/state-only verbs: they never delegate to a reasoning backend.
  triage: 'none',
  'scope-approve': 'none',
  // Owner lifecycle verbs: deterministic gates + governed audit writes. The
  // distill LLM path shells out to egress-attested provider profiles, never the
  // in-process backend chain. None of them consume tenant task credentials.
  verify: 'none',
  distill: 'none',
  finish: 'none',
  // Thin alias of verify for operator review flows — same code path.
  'review-worker-output': 'none',
  // Read-only views over mission/organization/outbox/memory state.
  list: 'none',
  status: 'none',
  outbox: 'none',
  suggestions: 'none',
  hygiene: 'none',
  'organization-catalogs': 'none',
  'organization-profiles': 'none',
  'organization-profile': 'none',
  'organization-discovery': 'none',
  'memory-queue': 'none',
  'memory-review': 'none',
  // Deterministic queue/audit mutations; they never invoke a model.
  'memory-approve': 'none',
  'memory-reject': 'none',
  // Optional LLM contradiction check over similar knowledge; the workflow
  // already completes on the stub backend when no model is bound.
  'memory-promote': 'degrading',
  'memory-promote-pending': 'degrading',
};

export function missionActionCredentialRequirement(
  action: string | undefined
): CredentialRequirement {
  return (action && MISSION_ACTION_REQUIREMENTS[action]) || 'required';
}

/**
 * kyberion CLI readiness observations never need the reasoning bootstrap: their
 * probes only observe host binaries/state. `list` (including `--check`) and the
 * pure status subcommands stay 'none'; a noun with no subcommand or `help` is
 * also 'none' (discovery view). Real connection verbs keep 'required'.
 */
const CLI_READINESS_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  calendar: new Set(['status']),
  email: new Set(['status', 'latest-draft']),
};

const CLI_NONE_COMMANDS: ReadonlySet<string> = new Set(['list']);

export function cliCommandCredentialRequirement(input: {
  command: string;
  subcommand?: string;
}): CredentialRequirement {
  const { command, subcommand } = input;
  if (CLI_NONE_COMMANDS.has(command)) return 'none';
  if (command === 'task' && subcommand === 'scenario') return 'none';
  const readiness = CLI_READINESS_SUBCOMMANDS[command];
  if (
    readiness &&
    (subcommand === undefined || subcommand === 'help' || readiness.has(subcommand))
  ) {
    return 'none';
  }
  return 'required';
}
