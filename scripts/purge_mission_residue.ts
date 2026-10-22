/**
 * Mission residue maintenance.
 *
 * `mission purge` / `mission archive` only see missions the registry knows
 * about, so they cannot reclaim the directories that tests and demos leave
 * behind under `active/missions/`: those never carried a `mission-state.json`,
 * and therefore never entered the lifecycle policy's reach at all.
 *
 * A directory is residue when neither it nor anything beneath it holds a
 * `mission-state.json`. That rule keeps tenant-slug directories (which hold
 * real missions one level down) intact while reclaiming the fixture trees
 * around them.
 *
 * Residue is never hard-deleted: it is soft-deleted through the janitor's
 * trash primitive, so `restoreFromTrash()` can recover it for the catalog's
 * grace period and the trash sweep purges it afterwards.
 *
 * Dry-run by default; `--apply` is required to move anything.
 */
import * as path from 'node:path';
import { rootDir } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { STORAGE_DATA_TIERS } from '@agent/core/storage-layout';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  appendRetentionAudit,
  repoRelativePosix,
  softDeleteToTrash,
} from '@agent/core/storage-janitor';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { hasCliFlag } from './lib/cli-guard.js';

export const MISSION_STATE_FILENAME = 'mission-state.json';
const MISSIONS_SUBPATH = ['active', 'missions'];

/**
 * Roots that hold *registered* missions, where residue cannot be recognised by
 * a missing state file because the fixtures wrote a complete one. Only an
 * explicitly test-shaped ID is reclaimable here.
 */
const REGISTERED_MISSION_ROOTS = [
  ['active', 'missions'],
  ['active', 'archive', 'missions'],
  ['knowledge', 'personal', 'missions'],
];

/**
 * Mission IDs that only a test fixture ever produces. Deliberately narrow: an
 * ID is reclaimable only when it matches one of these in full, so a real
 * mission can never be swept up by a prefix coincidence.
 */
export const TEST_FIXTURE_MISSION_ID_PATTERNS: readonly RegExp[] = [
  /^MSN-TEST-LIFE-[A-Z0-9]+-\d{13}$/,
];

export function isTestFixtureMissionId(missionId: string): boolean {
  return TEST_FIXTURE_MISSION_ID_PATTERNS.some((pattern) => pattern.test(missionId));
}

function missionsRoot(): string {
  return path.join(rootDir(), ...MISSIONS_SUBPATH);
}

/** Registered missions whose ID is test-fixture shaped, across every mission root. */
export function findTestFixtureMissions(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const child of subdirectories(dir)) {
      if (isTestFixtureMissionId(path.basename(child))) {
        if (safeExistsSync(path.join(child, MISSION_STATE_FILENAME))) found.push(child);
        continue;
      }
      if (!safeExistsSync(path.join(child, MISSION_STATE_FILENAME))) walk(child);
    }
  };
  for (const segments of REGISTERED_MISSION_ROOTS) {
    const root = path.join(rootDir(), ...segments);
    if (safeExistsSync(root)) walk(root);
  }
  return found.sort();
}

function subdirectories(dir: string): string[] {
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('.'))
    .map((name) => path.join(dir, name))
    .filter((candidate) => {
      try {
        return safeLstat(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** True when `dir` or any directory beneath it carries a mission state file. */
export function holdsRegisteredMission(dir: string): boolean {
  if (safeExistsSync(path.join(dir, MISSION_STATE_FILENAME))) return true;
  return subdirectories(dir).some(holdsRegisteredMission);
}

/**
 * Residue directories beneath `dir`, deepest-meaningful-first: a directory that
 * shelters a registered mission is descended into rather than reclaimed.
 */
export function collectResidue(dir: string): string[] {
  if (safeExistsSync(path.join(dir, MISSION_STATE_FILENAME))) return [];
  const children = subdirectories(dir);
  if (children.some(holdsRegisteredMission)) return children.flatMap(collectResidue);
  return [dir];
}

export function findMissionResidue(root = missionsRoot()): string[] {
  if (!safeExistsSync(root)) return [];
  return subdirectories(root).flatMap((child) =>
    STORAGE_DATA_TIERS.some((tier) => tier === path.basename(child))
      ? subdirectories(child).flatMap((partition) => {
          const name = path.basename(partition);
          // Tenant/shared containers remain scaffolding when they hold only
          // directories. A slug-shaped fixture with loose files stays visible
          // as residue rather than becoming an accidental namespace.
          if (name === 'shared' || isValidTenantSlug(name)) {
            const entries = safeReaddir(partition);
            const children = subdirectories(partition);
            if (entries.length === children.length) return children.flatMap(collectResidue);
          }
          return collectResidue(partition);
        })
      : collectResidue(child)
  );
}

function countFiles(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const child = path.join(dir, name);
    try {
      total += safeLstat(child).isDirectory() ? countFiles(child) : 1;
    } catch {
      // unreadable — not reclaimable, so not counted
    }
  }
  return total;
}

export const runPurgeMissionResidue = defineScript({
  name: 'purge-mission-residue',
  run({ argv, print, dryRun, json, check }) {
    const apply = hasCliFlag(argv, '--apply') && !check;
    const includeTestFixtures = hasCliFlag(argv, '--include-test-fixtures');
    const residue = [
      ...findMissionResidue(),
      ...(includeTestFixtures ? findTestFixtureMissions() : []),
    ];
    const entries = residue.map((dir) => ({
      path: repoRelativePosix(dir),
      files: countFiles(dir),
    }));
    const fileTotal = entries.reduce((sum, entry) => sum + entry.files, 0);

    if (!apply || dryRun) {
      const report = {
        status: 'ok' as const,
        dryRun: true,
        residueCount: entries.length,
        fileTotal,
        residue: entries,
      };
      if (check && entries.length > 0) {
        throw new ScriptExitError(
          1,
          `Mission residue detected: ${entries.length} directories under the governed mission tree carry no ` +
            `${MISSION_STATE_FILENAME}. A test or demo wrote into the real tree instead of a uniquely named ` +
            `directory on the shared tmp floor. Reclaim with: ` +
            `pnpm mission:residue --apply\n` +
            entries.map((entry) => `  ${entry.path} (${entry.files} files)`).join('\n')
        );
      }
      if (json) return report;
      print(
        entries.length === 0
          ? 'Mission residue: none. Nothing to do.'
          : `Mission residue: ${entries.length} directories, ${fileTotal} files (dry run — pass --apply to reclaim).`
      );
      if (!includeTestFixtures) {
        const fixtures = findTestFixtureMissions().length;
        if (fixtures > 0) {
          print(
            `  (plus ${fixtures} registered test-fixture missions — pass --include-test-fixtures to reclaim those too.)`
          );
        }
      }
      for (const entry of entries) print(`  ${entry.path} (${entry.files} files)`);
      return report;
    }

    const reclaimed: Array<{ path: string; trashPath: string; files: number }> = [];
    // Reclaiming spans the mission tree and the trash floor, which no single
    // authority role covers: the janitor does the same work at the sovereign
    // persona, so this maintenance verb runs at the same level rather than
    // making the caller export the persona by hand.
    withExecutionContext(
      'mission_controller',
      () => {
        for (const entry of entries) {
          const absolute = path.join(rootDir(), ...entry.path.split('/'));
          const { trashPath, originalRepoRelative } = softDeleteToTrash(absolute);
          appendRetentionAudit({
            event: 'RETENTION_SOFT_DELETE',
            path: originalRepoRelative,
            trash_path: repoRelativePosix(trashPath),
            artifact_class: 'mission_residue',
            reason: isTestFixtureMissionId(path.basename(absolute))
              ? 'registered mission whose ID matches a test-fixture pattern'
              : 'mission directory carries no mission-state.json (unregistered residue)',
          });
          reclaimed.push({
            path: originalRepoRelative,
            trashPath: repoRelativePosix(trashPath),
            files: entry.files,
          });
        }
      },
      'sovereign'
    );

    const report = {
      status: 'ok' as const,
      dryRun: false,
      residueCount: reclaimed.length,
      fileTotal,
      reclaimed,
    };
    if (json) return report;
    print(`Mission residue: soft-deleted ${reclaimed.length} directories (${fileTotal} files).`);
    for (const entry of reclaimed) print(`  ${entry.path} → ${entry.trashPath}`);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'purge_mission_residue.ts') ||
  isDirectScript(import.meta.url, 'purge_mission_residue.js')
) {
  void runPurgeMissionResidue();
}
