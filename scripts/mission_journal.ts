import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { formatDateTime, resolveTimeZone } from '@agent/core/format';
import { resolveMissionJournalPolicy } from '@agent/core/mission-journal-policy';
import { loadStateAtPath } from '@agent/core/mission-state';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import chalk from 'chalk';
import { isRecord } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonValueFile } from './lib/json-input.js';

interface MissionHistoryEntry {
  ts: string;
  event: string;
  note: string;
}

interface Mission {
  mission_id: string;
  status: string;
  tier: string;
  tenant_slug?: string;
  scope?: { tenant_slug?: string };
  history: MissionHistoryEntry[];
  relationships?: {
    prerequisites?: string[];
    successors?: string[];
    blockers?: string[];
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeMission(value: unknown): Mission | null {
  if (!isRecord(value)) return null;
  const missionId = stringField(value, 'mission_id');
  const status = stringField(value, 'status');
  const tier = stringField(value, 'tier');
  if (
    !missionId ||
    !status ||
    (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') ||
    !Array.isArray(value.history)
  ) {
    return null;
  }

  const history = value.history.flatMap((entry): MissionHistoryEntry[] => {
    if (!isRecord(entry)) return [];
    const ts = stringField(entry, 'ts');
    const event = stringField(entry, 'event');
    const note = stringField(entry, 'note');
    return ts && event && note ? [{ ts, event, note }] : [];
  });
  const scope = isRecord(value.scope) ? value.scope : undefined;
  const relationships = isRecord(value.relationships) ? value.relationships : undefined;
  const prerequisites = relationships ? stringArrayField(relationships.prerequisites) : undefined;
  const successors = relationships ? stringArrayField(relationships.successors) : undefined;
  const blockers = relationships ? stringArrayField(relationships.blockers) : undefined;

  return {
    mission_id: missionId,
    status,
    tier,
    ...(stringField(value, 'tenant_slug')
      ? { tenant_slug: stringField(value, 'tenant_slug') }
      : {}),
    ...(scope && stringField(scope, 'tenant_slug')
      ? { scope: { tenant_slug: stringField(scope, 'tenant_slug') } }
      : {}),
    history,
    ...(relationships && (prerequisites || successors || blockers)
      ? {
          relationships: {
            ...(prerequisites ? { prerequisites } : {}),
            ...(successors ? { successors } : {}),
            ...(blockers ? { blockers } : {}),
          },
        }
      : {}),
  };
}

export function loadTrustScores(
  ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json')
): Record<string, number> {
  try {
    const safePath = assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return {};
    const raw = readSafeJsonValueFile<unknown>(safePath, 'agent trust score ledger');
    if (!isRecord(raw)) return {};
    const ledger = isRecord(raw.agents) ? raw.agents : raw;
    return Object.fromEntries(
      Object.entries(ledger).flatMap(([agentId, value]) => {
        if (!isRecord(value)) return [];
        const score = value.current_score;
        return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1000
          ? [[agentId, score]]
          : [];
      })
    );
  } catch {
    return {};
  }
}

export function scanMissions(
  tenantSlug?: string,
  searchDirs: string[] = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
    pathResolver.active('archive/missions'),
  ]
) {
  const missions: Mission[] = [];

  for (const dir of searchDirs) {
    let safeDir: string;
    try {
      safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
      if (!safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let items: string[];
    try {
      items = safeReaddir(safeDir);
    } catch {
      continue;
    }
    for (const item of items) {
      try {
        const missionDir = assertSafeRepositoryPath(path.join(safeDir, item), {
          allowMissingLeaf: true,
        });
        if (!safeLstat(missionDir).isDirectory()) continue;
        const statePath = assertSafeRepositoryPath(path.join(missionDir, 'mission-state.json'), {
          allowMissingLeaf: true,
        });
        if (!safeExistsSync(statePath)) continue;
        const mission = normalizeMission(loadStateAtPath(statePath));
        if (!mission) continue;
        if (tenantSlug && (mission.tenant_slug || mission.scope?.tenant_slug) !== tenantSlug) {
          continue;
        }
        missions.push(mission);
      } catch (err) {
        logger.warn(`[mission_journal] suppressed error in scanMissions: ${err}`);
      }
    }
  }

  return missions.sort((a, b) => {
    const aTime = a.history[0]?.ts || '';
    const bTime = b.history[0]?.ts || '';
    return aTime.localeCompare(bTime);
  });
}

function renderJournal(tenantSlug?: string) {
  const policy = resolveMissionJournalPolicy();
  console.log(chalk.bold.cyan(`\n📜 [KYBERION] ${policy.title}\n`));

  const missions = scanMissions(tenantSlug);

  if (missions.length === 0) {
    console.log(policy.empty_message);
    return;
  }

  missions.forEach((m) => {
    const statusColor =
      m.status === 'completed' ? chalk.green : m.status === 'active' ? chalk.yellow : chalk.gray;
    const tierIcon = m.tier === 'personal' ? '🛡️' : m.tier === 'confidential' ? '🔒' : '🌐';

    console.log(
      `${tierIcon} ${chalk.bold(m.mission_id.padEnd(25))} [${statusColor(m.status.toUpperCase())}] (${m.tier})`
    );

    // Relationships
    if (m.relationships) {
      if (m.relationships.prerequisites?.length) {
        console.log(
          `   ${chalk.blue(`← ${policy.relationship_labels.prerequisites}:`)} ${m.relationships.prerequisites.join(', ')}`
        );
      }
      if (m.relationships.successors?.length) {
        console.log(
          `   ${chalk.magenta(`→ ${policy.relationship_labels.successors}:`)} ${m.relationships.successors.join(', ')}`
        );
      }
    }

    m.history.forEach((h, idx) => {
      const isLast = idx === m.history.length - 1;
      const prefix = isLast ? ' └── ' : ' ├── ';
      const time = formatDateTime(h.ts, {
        locale: resolveOperatorLocale(),
        timeZone: resolveTimeZone(),
      });
      console.log(
        `   ${chalk.gray(prefix)}${chalk.dim(time)}: ${chalk.white(h.event)} - ${chalk.italic(h.note)}`
      );
    });
    console.log('');
  });

  // Summary
  const stats: Record<string, number> = {};
  for (const mission of missions) {
    stats[mission.status] = (stats[mission.status] || 0) + 1;
  }

  console.log(chalk.bold(`📈 ${policy.summary_title}:`));
  Object.keys(stats).forEach((s) => {
    console.log(`  - ${s.toUpperCase()}: ${stats[s]}`);
  });
  console.log(`  - TOTAL MISSIONS: ${missions.length}\n`);

  // Trust Scores Summary
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  const ledger = loadTrustScores(ledgerPath);
  if (Object.keys(ledger).length > 0) {
    console.log(chalk.bold(`🤝 ${policy.trust_scores_title}:`));
    Object.keys(ledger).forEach((a) => {
      const normalized = ledger[a] / 100;
      const color = normalized >= 7.0 ? chalk.green : normalized >= 5.0 ? chalk.yellow : chalk.red;
      console.log(`  - ${a}: ${color(normalized.toFixed(1))}/10.0`);
    });
    console.log('');
  }
}

export function main(argv: string[] = []): void {
  const tenantFlag = argv.indexOf('--tenant-slug');
  const tenantSlug = tenantFlag >= 0 ? argv[tenantFlag + 1]?.trim() : undefined;
  renderJournal(tenantSlug || undefined);
}

const script = defineScript({
  name: 'mission:journal',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (
  isDirectScript(import.meta.url, 'mission_journal.ts') ||
  isDirectScript(import.meta.url, 'mission_journal.js')
) {
  void script();
}
