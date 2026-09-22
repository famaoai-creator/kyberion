/**
 * WI-07 (docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
 * §3/§6): `pnpm inventory` — the governed CLI over the work-inventory.v1
 * record type and its decomposition / harvest / consent / observation /
 * scoring / promotion modules.
 *
 * Every subcommand accepts `--tenant <slug>` (tenant scope; absent ->
 * personal scope) and `--json` (machine output; absent -> short
 * human-readable text). All writes go through the governed
 * `libs/core/work-inventory*.ts` storage functions, which never write
 * outside the caller's tenant/personal scope (WI-07 acceptance §6).
 *
 * Kept intentionally thin: argv parsing lives in
 * `scripts/lib/work-inventory-cli-shared.ts`, and each command area's logic
 * lives in its own `scripts/lib/work-inventory-cli-*.ts` module so no file
 * here grows past the ~600 line guideline.
 */
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  formatCandidates,
  formatEntryList,
  formatMigrate,
  formatShow,
  formatStepsTable,
  runAdd,
  runCandidates,
  runClassify,
  runList,
  runMigrate,
  runOverride,
  runShow,
  runStatus,
  type WorkInventoryCliOptions,
} from './lib/work-inventory-cli-entries.js';
import { formatHarvest, runHarvest } from './lib/work-inventory-cli-harvest.js';
import {
  formatConsent,
  formatConsentList,
  formatObservationSummary,
  formatObservationSummaryList,
  runConsentGrant,
  runConsentList,
  runConsentRevoke,
  runObserveAttach,
  runObserveConfirm,
  runObserveDiscard,
  runObserveList,
  runObserveSummarize,
} from './lib/work-inventory-cli-consent.js';
import { runLearn, runPromote } from './lib/work-inventory-cli-promotion.js';
import {
  governed,
  resolveRootDir,
  WorkInventoryCliUsageError,
} from './lib/work-inventory-cli-shared.js';

export type WorkInventoryPrint = (value: unknown) => void;

export interface WorkInventoryRunOptions extends WorkInventoryCliOptions {
  now?: Date;
  print?: WorkInventoryPrint;
  /** Forces json/human formatting instead of scanning argv for `--json`. */
  json?: boolean;
}

/** Boolean (no-value) flags across every subcommand — every other `--xxx` token consumes the next token as its value. */
const BOOLEAN_FLAGS = new Set([
  '--no-model',
  '--include-unscoped',
  '--suggest',
  '--execute',
  '--json',
  '--dry-run',
  '--quiet',
]);

/** Non-flag tokens, in order (subcommand chain + positional ids), independent of flag ordering. */
function extractPositionals(argv: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(token)) index += 1; // skip this flag's value
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

function requirePositional(value: string | undefined, usage: string): string {
  if (!value) throw new WorkInventoryCliUsageError(usage);
  return value;
}

/**
 * Testable core of `pnpm inventory`. `options.rootDir` (also accepted as an
 * undocumented `--root-dir <path>` argv flag) isolates storage for hermetic
 * tests without an env var; production runs always default to the real repo
 * root via the core modules' own `pathResolver.rootDir()` fallback.
 */
export async function run(argv: string[], options: WorkInventoryRunOptions = {}): Promise<void> {
  const print = options.print ?? (() => undefined);
  const json = options.json ?? argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const rootDir = options.rootDir ?? resolveRootDir(argv);
  const now = options.now;
  const coreOptions: WorkInventoryCliOptions = { rootDir };

  const emit = (structured: unknown, human: string): void => print(json ? structured : human);

  const positionals = extractPositionals(argv);
  const [command, sub] = positionals;

  switch (command) {
    case 'add': {
      const result = await runAdd(argv, { ...coreOptions, now });
      emit(
        result,
        [
          `${result.entry.entry_id} (${result.source})`,
          ...(result.warnings.length > 0 ? [`warnings: ${result.warnings.join('; ')}`] : []),
          '',
          'Steps:',
          formatStepsTable(result.entry.steps),
        ].join('\n')
      );
      return;
    }
    case 'list': {
      const entries = governed(() => runList(argv, coreOptions));
      emit({ entries }, formatEntryList(entries));
      return;
    }
    case 'show': {
      const entryId = requirePositional(sub, 'Usage: inventory show <entry_id>');
      const result = governed(() => runShow(entryId, argv, coreOptions));
      emit(result, formatShow(result));
      return;
    }
    case 'classify': {
      const entryId = requirePositional(
        sub,
        'Usage: inventory classify <entry_id> [--api-systems a,b]'
      );
      const entry = governed(() => runClassify(entryId, argv, coreOptions));
      emit(entry, [`${entry.entry_id} reclassified`, formatStepsTable(entry.steps)].join('\n'));
      return;
    }
    case 'override': {
      const entryId = requirePositional(
        sub,
        'Usage: inventory override <entry_id> --step S1 --method human --reason "..." --decided-by user:<id>'
      );
      const entry = governed(() => runOverride(entryId, argv, coreOptions));
      emit(entry, [`${entry.entry_id} overridden`, formatStepsTable(entry.steps, true)].join('\n'));
      return;
    }
    case 'status': {
      const entryId = requirePositional(
        sub,
        'Usage: inventory status <entry_id> --to confirmed|candidate|retired --decided-by user:<id>'
      );
      const entry = governed(() => runStatus(entryId, argv, coreOptions));
      emit(entry, `${entry.entry_id} -> ${entry.status}`);
      return;
    }
    case 'harvest': {
      const result = governed(() => runHarvest(argv, { ...coreOptions, dryRun, now }));
      emit(result, formatHarvest(result));
      return;
    }
    case 'consent': {
      switch (sub) {
        case 'grant': {
          const consent = governed(() => runConsentGrant(argv, { ...coreOptions, now }));
          emit(consent, formatConsent(consent));
          return;
        }
        case 'revoke': {
          const consent = governed(() => runConsentRevoke(argv, { ...coreOptions, now }));
          emit(consent, formatConsent(consent));
          return;
        }
        case 'list': {
          const consents = governed(() => runConsentList(argv, coreOptions));
          emit({ consents }, formatConsentList(consents));
          return;
        }
        default:
          throw new WorkInventoryCliUsageError('Usage: inventory consent grant|revoke|list ...');
      }
    }
    case 'observe': {
      switch (sub) {
        case 'summarize': {
          const summary = governed(() => runObserveSummarize(argv, { ...coreOptions, now }));
          emit(summary, formatObservationSummary(summary));
          return;
        }
        case 'confirm': {
          const summary = governed(() => runObserveConfirm(argv, { ...coreOptions, now }));
          emit(summary, formatObservationSummary(summary));
          return;
        }
        case 'discard': {
          const summary = governed(() => runObserveDiscard(argv, { ...coreOptions, now }));
          emit(summary, formatObservationSummary(summary));
          return;
        }
        case 'list': {
          const summaries = governed(() => runObserveList(argv, coreOptions));
          emit({ summaries }, formatObservationSummaryList(summaries));
          return;
        }
        case 'attach': {
          const entry = governed(() => runObserveAttach(argv, { ...coreOptions, now }));
          emit(entry, `${entry.entry_id} <- observation attached`);
          return;
        }
        default:
          throw new WorkInventoryCliUsageError(
            'Usage: inventory observe summarize|confirm|discard|list|attach ...'
          );
      }
    }
    case 'candidates': {
      const results = governed(() => runCandidates(argv, coreOptions));
      emit({ candidates: results }, formatCandidates(results));
      return;
    }
    case 'promote': {
      const entryId = requirePositional(
        sub,
        'Usage: inventory promote <entry_id> --kind mission|pipeline --decided-by user:<id> [--execute]'
      );
      const result = governed(() => runPromote(entryId, argv, { ...coreOptions, now }));
      const human =
        result.plan.kind === 'pipeline'
          ? [`plan: ${result.plan.kind} for ${entryId}`, `run: ${result.pipeline_command}`].join(
              '\n'
            )
          : [
              `plan: mission ${result.plan.mission_id} for ${entryId}`,
              result.executed ? `executed: ${result.ref}` : 'not executed (pass --execute)',
            ].join('\n');
      emit(result, human);
      return;
    }
    case 'learn': {
      const result = governed(() => runLearn(argv, { ...coreOptions, dryRun, now }));
      emit(
        result,
        [
          `${result.dry_run ? '(dry-run) ' : ''}measured: ${result.measured}`,
          `calibrated methods: ${result.calibrated_methods.join(', ') || '(none)'}`,
          `learning signals: ${result.learning_signals.length}`,
          `enqueued: ${result.enqueued.length}`,
        ].join('\n')
      );
      return;
    }
    case 'migrate': {
      const result = governed(() => runMigrate(argv, { ...coreOptions, dryRun }));
      emit(result, formatMigrate(result));
      return;
    }
    default:
      throw new WorkInventoryCliUsageError(
        'Usage: inventory <add|list|show|classify|override|status|harvest|consent|observe|candidates|promote|learn|migrate> ...'
      );
  }
}

export const runWorkInventory = defineScript({
  name: 'inventory',
  flags: ['json', 'dry-run', 'quiet'],
  async run(context) {
    try {
      await run(context.argv, { print: context.print, json: context.json });
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ScriptExitError(1, message, false);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'work_inventory.ts') ||
  isDirectScript(import.meta.url, 'work_inventory.js')
)
  void runWorkInventory();
