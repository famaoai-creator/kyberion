/**
 * decisions.ts — the governed facade of the per-tenant decision ledger (SD-01).
 *
 * Every write to `knowledge/confidential/<tenant>/decisions/<case>/` goes
 * through this script — the hearing surface invokes it as a built subprocess
 * (`dist/scripts/decisions.js`), never as library code, the same boundary
 * `hearing-mission-routes.ts` keeps for `mission_controller`.
 *
 *   pnpm decisions ask     --tenant <slug> --case <id> [--actor product|customer] [--json]
 *   pnpm decisions list    --tenant <slug> --case <id> [--json]
 *   pnpm decisions propose --tenant <slug> --case <id> --item <id> --key <k> --level <level>
 *                     [--value <json>] [--options <json>] [--basis ref@ver[,ref@ver]] [--note <text>]
 *   pnpm decisions decide  --tenant <slug> --case <id> --item <id> --key <k> --level <level> --value <json>
 *                     --by user:<member> --role owner|approver --basis ref@ver[,..]
 *                     [--supersedes D-0001] [--on-behalf-of customer:<slug> --evidence <ref> --customer <slug>]
 *   pnpm decisions import  --tenant <slug> --case <id> --file <jsonl> [--customer <slug>] [--dry-run] [--json]
 *                     lines: {promote,value,decided_by,basis,...} | {append:{...}} | {concept:{...}}
 *   pnpm decisions check   --tenant <slug> --case <id> [--observed <json>] [--json]   exit 1 when red
 *
 * `--dir <path>` (tests only) replaces `--tenant/--case` with a ledger
 * directory; it is still confined to the repository root by secure-io.
 * Confidential writes need the confidential/sovereign persona
 * (`KYBERION_PERSONA`) and the tenant-bound scope like every other tenant write.
 */
import * as path from 'node:path';
import { humanActor } from '@agent/core/actor';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso, readJson, readJsonLines } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import {
  DECISION_LEDGER_ROLES,
  appendDecisions,
  loadDecisionAuthorityPolicy,
  applyPromotions,
  askLedger,
  buildLock,
  checkConformance,
  isDecisionLevel,
  readCustomerActors,
  readLedger,
  readObserved,
  readProbes,
  runProbes,
  writeConformance,
  writeObserved,
  writeProductConcept,
  type ProductConcept,
  type DecisionAppendInput,
  type DecisionBasis,
  type DecisionDecidedBy,
  type DecisionLedgerLocation,
  type DecisionObservedSet,
  type DecisionProbeSet,
  type DecisionPromotionRequest,
} from '@agent/core/decision-ledger';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

/** Writes run as the ledger's write role (see `DECISION_LEDGER_ROLES` in the model). */
const LEDGER_WRITE_ROLE = DECISION_LEDGER_ROLES.write;

/**
 * Run `fn` as the ledger write role bound to the request's tenant: the role's grant is
 * `knowledge/confidential/${KYBERION_TENANT}/decisions/`, so without a tenant it writes nothing.
 */
function asLedgerWriter<T>(opts: Record<string, string>, fn: () => T): T {
  return withExecutionContext(LEDGER_WRITE_ROLE, fn, undefined, opts.tenant);
}

interface ParsedArgs {
  verb: string;
  opts: Record<string, string>;
  flags: Set<string>;
}

export function parseDecisionsArgs(argv: readonly string[]): ParsedArgs {
  const [verb = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
    } else {
      opts[name] = next;
      index += 1;
    }
  }
  return { verb, opts, flags };
}

function usage(): string {
  return [
    'pnpm decisions ask     --tenant <slug> --case <id> [--actor product|customer] [--json]',
    'pnpm decisions list    --tenant <slug> --case <id> [--json]',
    'pnpm decisions propose --tenant <slug> --case <id> --item <id> --key <k> --level <level> [--value <json>] [--options <json>] [--basis ref@ver,..]',
    'pnpm decisions decide  --tenant <slug> --case <id> --item <id> --key <k> --level <level> --value <json> --by user:<member> --role owner|approver --basis ref@ver,.. [--supersedes D-0001] [--on-behalf-of customer:<slug> --evidence <ref> --customer <slug>]',
    'pnpm decisions import  --tenant <slug> --case <id> --file <jsonl> [--customer <slug>] [--dry-run] [--json]',
    'pnpm decisions probe   --tenant <slug> --case <id> --impl <checkout inside repo> [--probes <json>] [--commit <sha>] [--dry-run]',
    'pnpm decisions check   --tenant <slug> --case <id> [--observed <json>] [--json]',
  ].join('\n');
}

function locationOf(opts: Record<string, string>): DecisionLedgerLocation {
  if (opts.dir) return { dir: opts.dir };
  if (!opts.tenant || !opts.case) {
    throw new ScriptExitError(2, `--tenant and --case are required\n${usage()}`);
  }
  return { tenantSlug: opts.tenant, caseId: opts.case };
}

function caseIdOf(opts: Record<string, string>): string | undefined {
  return opts.case;
}

export function parseBasis(text: string | undefined): DecisionBasis[] {
  if (!text) return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const at = item.indexOf('@');
      return at > 0
        ? { ref: item.slice(0, at), version: item.slice(at + 1) || 'unversioned' }
        : { ref: item, version: 'unversioned' };
    });
}

function parseValue(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function decidedByOf(opts: Record<string, string>): DecisionDecidedBy {
  if (!opts.by) throw new ScriptExitError(2, '--by user:<member> is required');
  const actor = humanActor(opts.by.replace(/^user:/u, ''));
  const role = opts.role === 'approver' || opts.role === 'viewer' ? opts.role : 'owner';
  const decidedBy: DecisionDecidedBy = { kind: 'human', id: actor.id, role };
  if (opts['on-behalf-of']) {
    decidedBy.on_behalf_of = {
      actor_id: opts['on-behalf-of'],
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
      ...(opts['confirm-target'] ? { confirm_target: opts['confirm-target'] } : {}),
    };
  }
  return decidedBy;
}

function readJsonFile<T>(file: string, label: string): T {
  const safe = assertSafeRepositoryPath(file);
  if (!safeExistsSync(safe)) throw new ScriptExitError(2, `${label} not found: ${file}`);
  return readJson<T>(safe);
}

function readJsonl(file: string): unknown[] {
  const safe = assertSafeRepositoryPath(file);
  if (!safeExistsSync(safe)) throw new ScriptExitError(2, `file not found: ${file}`);
  return readJsonLines<unknown>(safe, { onMalformed: 'throw' });
}

export interface DecisionImportSummary {
  dry_run: boolean;
  promoted: Array<{ promote: string; outcome: string; reason?: string; ask?: string; id?: string }>;
  appended: string[];
  concepts: string[];
  superseded: string[];
}

export async function runDecisions(argv: readonly string[]): Promise<unknown> {
  const { verb, opts, flags } = parseDecisionsArgs(argv);
  const dryRun = flags.has('dry-run');
  switch (verb) {
    case 'help':
      return usage();
    case 'list': {
      return readLedger(locationOf(opts));
    }
    case 'ask': {
      const actor = opts.actor === 'customer' || opts.actor === 'product' ? opts.actor : undefined;
      return askLedger(readLedger(locationOf(opts)), actor ? { actor } : {}).map((item) => ({
        id: item.decision.id,
        item: item.decision.item,
        key: item.decision.key,
        level: item.decision.level,
        state: item.decision.state,
        ask: item.ask,
        pending_reason: item.decision.pending_reason,
      }));
    }
    case 'propose': {
      if (!opts.item || !opts.key || !isDecisionLevel(opts.level)) {
        throw new ScriptExitError(2, '--item, --key and a valid --level are required');
      }
      const record: DecisionAppendInput = {
        item: opts.item,
        key: opts.key,
        level: opts.level,
        state: 'proposed',
        value: parseValue(opts.value),
        ...(opts.options ? { options: parseValue(opts.options) as unknown[] } : {}),
        basis: parseBasis(opts.basis),
        origin: 'facade',
        proposed_at: nowIso(),
        ...(opts.by ? { proposed_by: humanActor(opts.by.replace(/^user:/u, '')) } : {}),
        ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      };
      return asLedgerWriter(opts, () =>
        appendDecisions(locationOf(opts), [record], { dryRun, caseId: caseIdOf(opts) })
      );
    }
    case 'decide': {
      if (!opts.item || !opts.key || !isDecisionLevel(opts.level)) {
        throw new ScriptExitError(2, '--item, --key and a valid --level are required');
      }
      const decidedBy = decidedByOf(opts);
      const location = locationOf(opts);
      const now = nowIso();
      const request: DecisionPromotionRequest = {
        promote: opts.supersedes ?? '',
        value: parseValue(opts.value),
        decided_by: decidedBy,
        basis: parseBasis(opts.basis),
        origin: 'hearing',
      };
      const customerActors = readCustomerActors(location, opts.customer);
      const policy = loadDecisionAuthorityPolicy();
      if (opts.supersedes) {
        return asLedgerWriter(opts, () =>
          applyPromotions(location, [request], { now, dryRun, customerActors, policy })
        );
      }
      // No open record to promote: seed one as proposed, then promote it in the same run.
      return asLedgerWriter(opts, () => {
        const seeded = appendDecisions(
          location,
          [
            {
              item: opts.item,
              key: opts.key,
              level: opts.level as DecisionAppendInput['level'],
              state: 'proposed',
              value: parseValue(opts.value),
              ...(opts.options ? { options: parseValue(opts.options) as unknown[] } : {}),
              basis: parseBasis(opts.basis),
              origin: 'facade',
              proposed_at: now,
            },
          ],
          { dryRun, caseId: caseIdOf(opts) }
        );
        if (dryRun) return { dry_run: true, seeded: seeded.appended.map((d) => d.id) };
        return applyPromotions(
          location,
          [{ ...request, promote: seeded.appended[0].id, origin: 'facade' as never }],
          { now, dryRun, customerActors, policy }
        );
      });
    }
    case 'import': {
      if (!opts.file) throw new ScriptExitError(2, '--file <jsonl> is required');
      const location = locationOf(opts);
      const lines = readJsonl(opts.file) as Array<Record<string, unknown>>;
      const promotions = lines.filter(
        (line) => typeof line.promote === 'string'
      ) as unknown as DecisionPromotionRequest[];
      const appends = lines
        .filter((line) => line.append && typeof line.append === 'object')
        .map((line) => line.append as DecisionAppendInput);
      const concepts = lines
        .filter((line) => line.concept && typeof line.concept === 'object')
        .map((line) => line.concept as ProductConcept);
      const now = nowIso();
      const customerActors = readCustomerActors(location, opts.customer);
      const policy = loadDecisionAuthorityPolicy();
      return asLedgerWriter(opts, () => {
        const summary: DecisionImportSummary = {
          dry_run: dryRun,
          promoted: [],
          appended: [],
          concepts: [],
          superseded: [],
        };
        if (appends.length) {
          const result = appendDecisions(location, appends, { dryRun, caseId: caseIdOf(opts) });
          summary.appended.push(...result.appended.map((d) => d.id));
          summary.superseded.push(...result.superseded);
        }
        if (promotions.length) {
          const result = applyPromotions(location, promotions, {
            now,
            dryRun,
            customerActors,
            policy,
          });
          result.results.forEach((entry, index) => {
            const appended = result.append.appended[index];
            summary.promoted.push({
              promote: entry.promote,
              outcome: entry.result.outcome,
              ...('reason' in entry.result && entry.result.reason
                ? { reason: entry.result.reason }
                : {}),
              ...('ask' in entry.result && entry.result.ask ? { ask: entry.result.ask } : {}),
              ...(appended ? { id: appended.id } : {}),
            });
          });
          summary.superseded.push(...result.append.superseded);
        }
        for (const concept of concepts) {
          if (!dryRun) writeProductConcept(location, concept);
          summary.concepts.push(concept.id);
        }
        return summary;
      });
    }
    case 'probe': {
      // SD-06: run the case's declarative probes against an implementation
      // checkout *inside the repository* (secure-io refuses anything else) and
      // store the result as this case's observation set.
      if (!opts.impl)
        throw new ScriptExitError(2, '--impl <checkout inside the repository> is required');
      const location = locationOf(opts);
      const implDir = assertSafeRepositoryPath(opts.impl);
      const probes = opts.probes
        ? readJsonFile<DecisionProbeSet>(opts.probes, 'probe set')
        : readProbes(location);
      if (!probes)
        throw new ScriptExitError(2, 'no probes.json for this case (pass --probes <file>)');
      const read = (relative: string): string | undefined => {
        const file = assertSafeRepositoryPath(path.join(implDir, relative), {
          allowMissingLeaf: true,
        });
        return safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : undefined;
      };
      const result = runProbes(probes, read, { commit: opts.commit ?? 'unknown', now: nowIso() });
      if (!dryRun) asLedgerWriter(opts, () => writeObserved(location, result.observed));
      return {
        dry_run: dryRun,
        observed: result.observed.observations.length,
        misses: result.misses,
        impl: result.observed.impl,
      };
    }
    case 'check': {
      const location = locationOf(opts);
      const decisions = readLedger(location);
      const observed = opts.observed
        ? asLedgerWriter(opts, () =>
            writeObserved(
              location,
              readJsonFile<DecisionObservedSet>(opts.observed, 'observed set')
            )
          )
        : readObserved(location);
      const report = checkConformance(decisions, observed, { now: nowIso() });
      const lock = buildLock(decisions, report);
      asLedgerWriter(opts, () => writeConformance(location, report, lock));
      if (report.status === 'red') {
        throw new ScriptExitError(1, '', false, report);
      }
      return report;
    }
    default:
      throw new ScriptExitError(2, `unknown verb '${verb}'\n${usage()}`);
  }
}

export const runDecisionsScript = defineScript({
  name: 'decisions',
  flags: ['json', 'dry-run', 'quiet'],
  run: async (context) => {
    try {
      const result = await runDecisions(
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
  isDirectScript(import.meta.url, 'decisions.ts') ||
  isDirectScript(import.meta.url, 'decisions.js')
) {
  void runDecisionsScript(currentProcessArgv().slice(2));
}
