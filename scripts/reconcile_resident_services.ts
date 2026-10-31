#!/usr/bin/env node
/**
 * scripts/reconcile_resident_services.ts — `pnpm kyberion scheduler reconcile`.
 *
 * Brings this checkout's resident services in line with
 * knowledge/product/governance/resident-services.json:
 *
 *   1. syncs the schedule registry from pipeline ADF `schedule` fields (the
 *      same sync chronos runs on start), so schedules are registered even
 *      while chronos is down;
 *   2. inspects the units the host service manager already has
 *      (libs/core/daemon/installed-units.ts) and plans, per declared service:
 *      install / migrate-from-legacy / reinstall (unit hash or node path
 *      changed) / ok / surface-owned / not-requested. Units owned by another
 *      checkout are reported and never touched;
 *   3. with --apply, executes the plans through the existing service managers
 *      (stage under active/shared/tmp/, governed `cp` + launchctl/systemctl)
 *      and records the result in active/shared/runtime/state/resident-services.json.
 *
 * Dry-run by default; idempotent — a second --apply plans nothing.
 *
 *   pnpm kyberion scheduler reconcile                       # plan only
 *   pnpm kyberion scheduler reconcile --apply               # install / migrate required services
 *   pnpm kyberion scheduler reconcile --apply --include agent-runtime-supervisor
 */
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import {
  resolveDaemonManager,
  type DaemonManager,
  type DaemonPlan,
  type DaemonRenderContext,
} from '@agent/core/daemon/service-manager';
import {
  DAEMON_SPECS,
  resolveDaemonInstance,
  scopeDaemonServiceSpec,
} from '@agent/core/daemon/specs';
import {
  inspectInstalledUnitDetails,
  type InspectInstalledUnitsOptions,
  type InstalledUnitDetailsReport,
  type InstalledUnitsExec,
} from '@agent/core/daemon/installed-units';
import {
  buildResidentServicesState,
  loadResidentServicesPolicy,
  planResidentServices,
  readResidentServicesState,
  residentServicesStatePath,
  sha256Text,
  writeResidentServicesState,
  type DesiredResidentUnit,
  type ResidentServicesPlan,
  type ResidentServicesPolicy,
  type ResidentServicesState,
} from '@agent/core/daemon/resident-services';
import { loadSurfaceManifest } from '@agent/core/surface/surface-runtime';
import { buildDaemonRenderContext, CHRONOS_FORWARDABLE_ENV } from './install_chronos_launchd.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface ScheduleSyncSummary {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  desired: number;
  skipped: Array<{ file: string; reason: string }>;
  dryRun: boolean;
}

export interface ReconcileDeps {
  platform?: NodeJS.Platform;
  /** Governed exec for inspection AND apply (default safeExecResult). */
  exec?: InstalledUnitsExec;
  listDir?: InspectInstalledUnitsOptions['listDir'];
  readFile?: InspectInstalledUnitsOptions['readFile'];
  homeDir?: string;
  uid?: string;
  /** Override the render context (tests pin node path, PATH, staging dir). */
  renderContext?: (manager: DaemonManager, env: Record<string, string>) => DaemonRenderContext;
  enabledSurfaces?: () => ReadonlySet<string>;
  syncSchedules?: (options: { dryRun: boolean }) => Promise<ScheduleSyncSummary>;
  distExists?: (absolutePath: string) => boolean;
  statePath?: string;
  policy?: ResidentServicesPolicy;
  now?: () => Date;
}

export interface ResidentServicesInspection {
  plan: ResidentServicesPlan;
  desired: Record<string, DesiredResidentUnit | undefined>;
  installed: InstalledUnitDetailsReport;
  manager: DaemonManager | null;
  contexts: Record<string, DaemonRenderContext>;
}

export interface ReconcileReport {
  status: 'ok' | 'pending' | 'failed';
  apply: boolean;
  instance_id: string;
  repo_root: string;
  platform: ResidentServicesPlan['platform'];
  schedules: ScheduleSyncSummary | { error: string };
  plan: ResidentServicesPlan;
  applied: Array<{ id: string; action: string; ok: boolean; error?: string }>;
  state_path?: string;
}

function defaultEnabledSurfaces(): ReadonlySet<string> {
  try {
    return new Set(
      loadSurfaceManifest()
        .surfaces.filter((surface) => surface.enabled !== false)
        .map((surface) => surface.id)
    );
  } catch (error) {
    logger.warn(
      `[resident-services] surface manifest unreadable — owner_surface rules treat every surface as disabled | fix active-surfaces.json | ${error instanceof Error ? error.message : String(error)}`
    );
    return new Set();
  }
}

async function defaultSyncSchedules(options: { dryRun: boolean }): Promise<ScheduleSyncSummary> {
  // Lazy: chronos_daemon owns the tenant gates; importing it never starts the daemon.
  const chronos = await import('./chronos_daemon.js');
  return chronos.syncSchedulesFromAdf({ dryRun: options.dryRun });
}

/** Read-only: desired units rendered for this host, diffed against installed units. */
export function inspectResidentServices(
  options: { include?: string[] } = {},
  deps: ReconcileDeps = {}
): ResidentServicesInspection {
  const platform = deps.platform ?? process.platform;
  const instance = resolveDaemonInstance(pathResolver.rootDir());
  const installed = inspectInstalledUnitDetails({
    repoRoot: instance.repoRoot,
    platform,
    exec: deps.exec,
    listDir: deps.listDir,
    readFile: deps.readFile,
    homeDir: deps.homeDir,
    uid: deps.uid,
  });
  const policy = deps.policy ?? loadResidentServicesPolicy();
  const manager = resolveDaemonManager(platform);
  const desired: Record<string, DesiredResidentUnit | undefined> = {};
  const contexts: Record<string, DaemonRenderContext> = {};
  // Only platforms whose installed units are inspected can be reconciled
  // idempotently; elsewhere every run would plan a fresh install.
  const inspectable = installed.platform === 'darwin' || installed.platform === 'linux';
  for (const service of policy.services) {
    const base = DAEMON_SPECS[service.id];
    if (!base || !manager || !inspectable) continue;
    const spec = scopeDaemonServiceSpec(base, instance);
    // Keep settings an operator forwarded at install time (allowlisted names
    // only), read from this checkout's own unit — never another checkout's.
    const source =
      installed.units.find(
        (unit) => unit.id === service.id && unit.ownedByThisCheckout && unit.scope === 'scoped'
      ) ??
      installed.units.find(
        (unit) => unit.id === service.id && unit.ownedByThisCheckout && unit.scope === 'legacy'
      );
    const forwarded = Object.fromEntries(
      Object.entries(source?.environment ?? {}).filter(([name]) =>
        (CHRONOS_FORWARDABLE_ENV as readonly string[]).includes(name)
      )
    );
    const env = { ...forwarded, KYBERION_ROOT: instance.repoRoot };
    const ctx = deps.renderContext
      ? deps.renderContext(manager, env)
      : buildDaemonRenderContext(manager, instance.repoRoot, env, platform);
    const unit = manager.planInstall(spec, ctx).unitFiles[0];
    if (!unit) continue;
    contexts[service.id] = ctx;
    desired[service.id] = {
      id: service.id,
      label: spec.label,
      legacyLabel: base.label,
      unitSha256: sha256Text(unit.content),
      nodePath: ctx.nodePath,
    };
  }
  const plan = planResidentServices({
    policy,
    installed,
    enabledSurfaces: (deps.enabledSurfaces ?? defaultEnabledSurfaces)(),
    include: options.include,
    desired,
  });
  return { plan, desired, installed, manager, contexts };
}

function runPlan(plan: DaemonPlan, exec: InstalledUnitsExec): void {
  for (const unit of plan.unitFiles) safeWriteFile(unit.stagedPath, unit.content);
  for (const command of plan.commands) {
    const [cmd, ...args] = command.run;
    const result = exec(cmd!, args);
    if (result.status === 0) continue;
    const detail = `${command.run.join(' ')} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`;
    if (command.tolerateFailure) {
      logger.debug(`[resident-services] tolerated: ${detail}`);
      continue;
    }
    throw new Error(detail);
  }
}

export async function reconcileResidentServices(
  options: { apply: boolean; include?: string[]; syncSchedules?: boolean },
  deps: ReconcileDeps = {}
): Promise<ReconcileReport> {
  const exec: InstalledUnitsExec =
    deps.exec ?? ((command, args) => safeExecResult(command, args, { timeoutMs: 15_000 }));
  let schedules: ReconcileReport['schedules'];
  if (options.syncSchedules === false) {
    schedules = { error: 'skipped (--no-schedules)' };
  } else {
    try {
      schedules = await (deps.syncSchedules ?? defaultSyncSchedules)({ dryRun: !options.apply });
    } catch (error) {
      schedules = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const inspection = inspectResidentServices({ include: options.include }, { ...deps, exec });
  const { plan, desired, manager, contexts } = inspection;
  const applied: ReconcileReport['applied'] = [];
  const changed = new Set<string>();
  let statePath: string | undefined;

  if (options.apply && manager) {
    const distExists = deps.distExists ?? safeExistsSync;
    for (const item of plan.items) {
      if (!['install', 'migrate', 'reinstall'].includes(item.action)) continue;
      const base = DAEMON_SPECS[item.id]!;
      const ctx = contexts[item.id]!;
      try {
        const distDaemon = path.join(ctx.repoRoot, base.daemonScript);
        if (!distExists(distDaemon))
          throw new Error(`dist build missing: ${distDaemon} — run \`pnpm build\` first`);
        const spec = scopeDaemonServiceSpec(base, resolveDaemonInstance(ctx.repoRoot));
        // Migrate: unload and remove this checkout's legacy global unit first,
        // so the next login does not start a second copy.
        if (item.action === 'migrate') runPlan(manager.planUninstall(base, ctx), exec);
        runPlan(manager.planInstall(spec, ctx), exec);
        changed.add(item.id);
        applied.push({ id: item.id, action: item.action, ok: true });
        logger.info(`[resident-services] ${item.action} ${spec.label}: done`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applied.push({ id: item.id, action: item.action, ok: false, error: message });
        logger.warn(
          `[resident-services] ${item.action} ${item.label} failed — ${message} | inspect with \`pnpm kyberion scheduler status --daemon ${item.id}\` and rerun reconcile`
        );
      }
    }
    const previous: ResidentServicesState | null = readResidentServicesState(deps.statePath);
    const state = buildResidentServicesState({
      plan,
      desired,
      previous,
      changed,
      now: (deps.now ?? (() => new Date()))(),
    });
    writeResidentServicesState(state, deps.statePath);
    statePath =
      deps.statePath ?? path.relative(pathResolver.rootDir(), residentServicesStatePath());
  }

  const failed = applied.some((entry) => !entry.ok);
  const pending = options.apply ? plan.pendingChanges - changed.size : plan.pendingChanges;
  return {
    status: failed ? 'failed' : pending > 0 ? 'pending' : 'ok',
    apply: options.apply,
    instance_id: plan.instanceId,
    repo_root: plan.repoRoot,
    platform: plan.platform,
    schedules,
    plan,
    applied,
    ...(statePath ? { state_path: statePath } : {}),
  };
}

export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [
    `Resident services — instance=${report.instance_id} root=${report.repo_root} platform=${report.platform}`,
    'error' in report.schedules
      ? `Schedules: not synced (${report.schedules.error})`
      : `Schedules: ${report.schedules.desired} declared; ${report.schedules.added} added, ${report.schedules.updated} updated, ${report.schedules.removed} removed${report.schedules.dryRun ? ' (dry-run)' : ''}${report.schedules.skipped.length ? `; ${report.schedules.skipped.length} skipped` : ''}`,
  ];
  if (report.plan.note) lines.push(`Note: ${report.plan.note}`);
  for (const item of report.plan.items) {
    const outcome = report.applied.find((entry) => entry.id === item.id);
    const suffix = outcome ? (outcome.ok ? ' — applied' : ` — FAILED: ${outcome.error}`) : '';
    lines.push(
      `  ${item.action.padEnd(13)} ${item.id} [${item.requirement}] ${item.reason}${suffix}`
    );
    for (const warning of item.warnings) lines.push(`                ! ${warning}`);
  }
  for (const unit of report.plan.foreign)
    lines.push(
      `  leave         ${unit.label} — owned by another checkout (${unit.repoRoot ?? 'unknown root'}); never touched`
    );
  for (const unit of report.plan.unmanaged)
    lines.push(`  unmanaged     ${unit.label} — not declared in resident-services.json`);
  if (!report.apply && report.plan.pendingChanges > 0)
    lines.push(
      '',
      `${report.plan.pendingChanges} change(s) pending (dry-run: nothing was changed). Apply with: pnpm kyberion scheduler reconcile --apply`
    );
  else if (report.status === 'ok') lines.push('', 'Nothing to change.');
  if (report.state_path) lines.push(`State: ${report.state_path}`);
  return lines.join('\n');
}

export async function main(
  args: string[],
  print: (value: unknown) => void,
  deps: ReconcileDeps = {}
): Promise<ReconcileReport> {
  const argv = await createStandardYargs(['node', 'reconcile_resident_services', ...args])
    .option('apply', {
      type: 'boolean',
      default: false,
      describe: 'Execute the plan through the host service manager (default: dry-run)',
    })
    .option('include', {
      type: 'string',
      array: true,
      default: [],
      describe: 'Also reconcile an optional service (e.g. agent-runtime-supervisor)',
    })
    .option('schedules', {
      type: 'boolean',
      default: true,
      describe: 'Sync the schedule registry from pipeline ADF (--no-schedules skips it)',
    })
    .option('json', { type: 'boolean', default: false, describe: 'Print the report as JSON' })
    .parseSync();
  const report = await reconcileResidentServices(
    {
      apply: argv.apply === true,
      include: (argv.include as string[])
        .flatMap((value) => String(value).split(','))
        .filter(Boolean),
      syncSchedules: argv.schedules !== false,
    },
    deps
  );
  print(argv.json ? report : formatReconcileReport(report));
  if (report.status === 'failed')
    throw new ScriptExitError(1, '[resident-services] one or more services failed to reconcile');
  return report;
}

export const runReconcileResidentServices = defineScript({
  name: 'scheduler:reconcile',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'reconcile_resident_services.ts') ||
  isDirectScript(import.meta.url, 'reconcile_resident_services.js')
)
  void runReconcileResidentServices();
