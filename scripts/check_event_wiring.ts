/**
 * EV-10: keep the event layer's declarations aligned with its actual wiring.
 *
 * Every defect this repository accumulated in the event layer had the same
 * shape: a vocabulary value, a capability, or a documented feature existed in
 * declaration but had no production call site. A dead declaration reads as a
 * working feature, so it is worse than an absent one. This checker fails when a
 * declared thing has no wiring, and equally when a document promises a feature
 * whose wiring is gone.
 *
 * It reads sources as text rather than importing them: the checker must be able
 * to report on a tree that does not compile.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput, readTextFile } from '@agent/core/foundation';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface EventWiringSources {
  /** Repo-relative path → file contents, for every scanned .ts/.md/.json file. */
  files: Record<string, string>;
}

/** Roots scanned for production call sites. */
const CODE_ROOTS = ['libs', 'scripts', 'satellites', 'presence'] as const;

const CHECKER_SELF = 'scripts/check_event_wiring.ts';

/**
 * A file is not a production call site when it is a test, a build artifact, or
 * a vendored dependency. `declaringFile` entries are excluded per-rule instead,
 * because a module referencing its own export proves nothing.
 */
function isProductionSource(relativePath: string): boolean {
  if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.tsx')) return false;
  // The checker names every symbol it looks for, so it would satisfy its own
  // rules. It is a lint, never a call site.
  if (relativePath === CHECKER_SELF) return false;
  if (relativePath.includes('/node_modules/')) return false;
  if (relativePath.includes('/dist/')) return false;
  if (relativePath.includes('/.next/')) return false;
  if (/\.test\.tsx?$/.test(relativePath)) return false;
  if (/\.d\.ts$/.test(relativePath)) return false;
  return true;
}

function countCallSites(
  sources: EventWiringSources,
  symbol: string,
  declaringFiles: string[]
): string[] {
  const callSites: string[] = [];
  // Word-boundary match so `armWatch` does not satisfy `armTriggerWatch`.
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u');
  for (const [relativePath, source] of Object.entries(sources.files)) {
    if (!isProductionSource(relativePath)) continue;
    if (declaringFiles.includes(relativePath)) continue;
    if (pattern.test(source)) callSites.push(relativePath);
  }
  return callSites.sort();
}

/** Parse a `as const` string-literal array declaration into its members. */
export function parseConstStringArray(source: string, declarationName: string): string[] {
  const start = source.indexOf(`${declarationName}`);
  if (start < 0) return [];
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  if (open < 0 || close < 0) return [];
  return [...source.slice(open + 1, close).matchAll(/'([^']+)'/gu)].map((match) => match[1]);
}

/** Parse a `type X = 'a' | 'b'` union declaration into its members. */
export function parseStringUnion(source: string, typeName: string): string[] {
  const match = new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`, 'u').exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/gu)].map((group) => group[1]);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Rule 1 — every `TriggerSource` value must have a production entry point.
 *
 * QM-02 declared cron/watch/wake unified behind TriggerRunner. If a value has
 * no way in, the unification claim is false for that value.
 */
export function checkTriggerSourceWiring(sources: EventWiringSources): string[] {
  const declaringFile = 'libs/core/trigger-runner.ts';
  const source = sources.files[declaringFile];
  if (!source)
    return [`${declaringFile}: missing — TriggerRunner is the trigger gate's single source`];

  const declared = parseStringUnion(source, 'TriggerSource');
  if (declared.length === 0) {
    return [`${declaringFile}: could not parse TriggerSource union`];
  }

  // Each source value reaches TriggerRunner through a distinct entry point.
  const ENTRY_POINTS: Record<string, string> = {
    cron: 'createTriggerRunner',
    watch: 'armTriggerWatch',
    wake: 'runWakeTrigger',
  };

  const violations: string[] = [];
  for (const value of declared) {
    const entryPoint = ENTRY_POINTS[value];
    if (!entryPoint) {
      violations.push(
        `${declaringFile}: TriggerSource '${value}' has no known entry point; register it in check_event_wiring.ts ENTRY_POINTS`
      );
      continue;
    }
    const callSites = countCallSites(sources, entryPoint, [declaringFile]);
    if (callSites.length === 0) {
      violations.push(
        `${declaringFile}: TriggerSource '${value}' is a dead declaration — ${entryPoint}() has no production call site. Wire it or remove the value.`
      );
    }
  }
  return violations;
}

/**
 * Rule 2 — every worker event type must be emitted somewhere.
 *
 * A type nobody emits makes the UI's "expected event sequence" contract a
 * fiction, and consumers cannot tell absence from breakage.
 */
export function checkWorkerEventTypeEmitters(sources: EventWiringSources): string[] {
  const declaringFile = 'libs/core/worker-event-stream.ts';
  const source = sources.files[declaringFile];
  if (!source) return [`${declaringFile}: missing — worker event vocabulary has no source`];

  const declared = parseConstStringArray(source, 'WORKER_EVENT_TYPES');
  if (declared.length === 0) {
    return [`${declaringFile}: could not parse WORKER_EVENT_TYPES`];
  }

  const violations: string[] = [];
  for (const eventType of declared) {
    // Emitters name the type as a literal argument: emit('turn_begin', …).
    const pattern = new RegExp(`['"\`]${eventType}['"\`]`, 'u');
    const emitters = Object.entries(sources.files).filter(
      ([relativePath, text]) =>
        isProductionSource(relativePath) && relativePath !== declaringFile && pattern.test(text)
    );
    if (emitters.length === 0) {
      violations.push(
        `${declaringFile}: worker event '${eventType}' is never emitted in production code. Emit it or remove it from WORKER_EVENT_TYPES.`
      );
    }
  }
  return violations;
}

/**
 * Rule 3 — a stimulus-reaction engine must have a dispatcher bound.
 *
 * An engine whose dispatcher is only bound in tests silently no-ops in
 * production while its documentation promises autonomic reactions.
 */
export function checkReflexDispatcherBinding(sources: EventWiringSources): string[] {
  const engineFile = 'libs/shared-nerve/src/reflex-engine.ts';
  if (!sources.files[engineFile]) return []; // Removed by EV-03 — nothing to verify.

  const violations: string[] = [];
  const binders = countCallSites(sources, 'setDispatcher', [engineFile]);
  if (binders.length === 0) {
    violations.push(
      `${engineFile}: reflex engine exists but setDispatcher() is never called in production — reflexes cannot fire. Wire a dispatcher or remove the engine.`
    );
  }

  const reflexDir = 'knowledge/procedures/reflexes';
  const absoluteReflexDir = pathResolver.rootResolve(reflexDir);
  if (safeExistsSync(absoluteReflexDir) && binders.length === 0) {
    violations.push(
      `${reflexDir}/: reflex definitions are present but no dispatcher is bound — they are inert.`
    );
  }
  return violations;
}

/**
 * Rule 4 — every long-lived daemon must record a heartbeat and be watched.
 *
 * A scheduler that stops without anyone noticing loses every firing for the
 * duration of the outage.
 */
export function checkDaemonWatchdogCoverage(sources: EventWiringSources): string[] {
  const watchdogFile = 'scripts/daemon_watchdog.ts';
  const watchdog = sources.files[watchdogFile];
  if (!watchdog) return [`${watchdogFile}: missing — no daemon is being watched`];

  const watched = new Set(parseConstStringArray(watchdog, 'DEFAULT_DAEMONS'));
  const violations: string[] = [];

  // Any script that records a heartbeat is a daemon, and must be watched.
  for (const [relativePath, source] of Object.entries(sources.files)) {
    if (!isProductionSource(relativePath)) continue;
    if (!relativePath.startsWith('scripts/')) continue;
    for (const match of source.matchAll(/recordDaemonHeartbeat\(\s*['"]([^'"]+)['"]/gu)) {
      const daemonId = match[1];
      if (!watched.has(daemonId)) {
        violations.push(
          `${watchdogFile}: daemon '${daemonId}' (declared in ${relativePath}) records a heartbeat but is not in DEFAULT_DAEMONS — its outages go unnoticed.`
        );
      }
    }
  }

  // A scheduling daemon that records no heartbeat at all is the worse case.
  for (const [relativePath, source] of Object.entries(sources.files)) {
    if (!isProductionSource(relativePath)) continue;
    if (!/^scripts\/.*daemon\.ts$/u.test(relativePath)) continue;
    if (!source.includes('recordDaemonHeartbeat')) {
      violations.push(
        `${relativePath}: long-lived daemon records no heartbeat, so daemon_watchdog cannot observe it.`
      );
    }
  }

  return [...new Set(violations)].sort();
}

/**
 * Rule 5 — every append-only event store must be bounded.
 *
 * The retention catalog only deletes what it declares; a store outside its
 * scan roots is not merely undeclared, it is invisible to the janitor report
 * too, which is how unbounded growth stays silent.
 */
export function checkEventStoreRetention(sources: EventWiringSources): string[] {
  const catalogPath = 'knowledge/product/governance/storage-retention-catalog.json';
  const raw = sources.files[catalogPath];
  if (!raw) return [`${catalogPath}: missing — event store retention is undeclared`];

  let declaredPaths: string[];
  try {
    const catalog = parseSafeJsonObjectInput(raw, `${catalogPath}`) as {
      entries?: Array<{ path?: string }>;
    };
    declaredPaths = (catalog.entries || [])
      .map((entry) => String(entry.path || ''))
      .filter(Boolean);
  } catch (err) {
    return [`${catalogPath}: unparseable (${err instanceof Error ? err.message : String(err)})`];
  }

  // Append-only event stores that must be covered by a retention declaration.
  const REQUIRED_COVERAGE = [
    'active/shared/observability',
    'active/shared/coordination/orchestration/events',
    'presence/bridge/runtime',
  ];

  const violations: string[] = [];
  for (const required of REQUIRED_COVERAGE) {
    const covered = declaredPaths.some(
      (declared) => required === declared || required.startsWith(`${declared}/`)
    );
    if (!covered) {
      violations.push(
        `${catalogPath}: event store '${required}' has no retention declaration — it grows without bound and does not even appear in the janitor's uncovered report.`
      );
    }
  }
  return violations;
}

/**
 * Rule 6 — operator-facing documents must not describe removed event features.
 */
export function checkEventDocHonesty(sources: EventWiringSources): string[] {
  const violations: string[] = [];
  const reflexEngineExists = Boolean(sources.files['libs/shared-nerve/src/reflex-engine.ts']);

  const DOC_CLAIMS: Array<{ file: string; marker: RegExp; requires: boolean; feature: string }> = [
    {
      file: 'docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md',
      marker: /反射設計図|Reflex ADF/u,
      requires: reflexEngineExists,
      feature: 'reflex engine',
    },
  ];

  for (const claim of DOC_CLAIMS) {
    const source = sources.files[claim.file];
    if (!source) continue;
    const lines = source.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!claim.marker.test(line)) return;
      if (claim.requires) return;
      violations.push(
        `${claim.file}:${index + 1}: documents '${claim.feature}' but its implementation has been removed — delete the section.`
      );
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Source collection
// ---------------------------------------------------------------------------

const EXTRA_FILES = [
  'knowledge/product/governance/storage-retention-catalog.json',
  'docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md',
] as const;

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.git', 'coverage']);

export function collectEventWiringSources(): EventWiringSources {
  const files: Record<string, string> = {};

  const visit = (relativePath: string): void => {
    const absolutePath = pathResolver.rootResolve(relativePath);
    if (!safeExistsSync(absolutePath)) return;
    const stat = safeLstat(absolutePath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (SKIP_DIRECTORIES.has(path.basename(relativePath))) return;
      for (const entry of safeReaddir(absolutePath).sort()) {
        visit(path.posix.join(relativePath, entry));
      }
      return;
    }
    if (!/\.tsx?$/u.test(relativePath)) return;
    files[relativePath] = readTextFile(absolutePath);
  };

  for (const root of CODE_ROOTS) visit(root);
  for (const extra of EXTRA_FILES) {
    const absolutePath = pathResolver.rootResolve(extra);
    if (!safeExistsSync(absolutePath)) continue;
    files[extra] = readTextFile(absolutePath);
  }

  return { files };
}

export function collectEventWiringViolations(sources: EventWiringSources): string[] {
  return [
    ...checkTriggerSourceWiring(sources),
    ...checkWorkerEventTypeEmitters(sources),
    ...checkReflexDispatcherBinding(sources),
    ...checkDaemonWatchdogCoverage(sources),
    ...checkEventStoreRetention(sources),
    ...checkEventDocHonesty(sources),
  ];
}

export const runCheckEventWiring = defineScript({
  name: 'check:event-wiring',
  flags: [],
  run(context) {
    const sources = collectEventWiringSources();
    const violations = collectEventWiringViolations(sources);
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          `${violations.length} violation(s)`,
          ...violations.map((violation) => `- ${violation}`),
        ].join('\n')
      );
    }
    context.print(
      `[check:event-wiring] OK — ${Object.keys(sources.files).length} files scanned, 6 rules satisfied`
    );
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_event_wiring.ts') ||
  isDirectScript(import.meta.url, 'check_event_wiring.js')
)
  void runCheckEventWiring();
