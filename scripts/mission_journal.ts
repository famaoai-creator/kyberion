import * as path from 'node:path';
import { logger, pathResolver, safeExistsSync, safeReaddir } from '@agent/core';
import chalk from 'chalk';
import { readJsonFile } from './refactor/cli-input.js';

const ROOT_DIR = pathResolver.rootDir();

interface MissionHistoryEntry {
  ts: string;
  event: string;
  note: string;
}

interface Mission {
  mission_id: string;
  status: string;
  tier: string;
  history: MissionHistoryEntry[];
  relationships?: {
    prerequisites?: string[];
    successors?: string[];
    blockers?: string[];
  };
}

function scanMissions() {
  const searchDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
    pathResolver.active('archive/missions')
  ];

  const missions: Mission[] = [];

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir)) continue;
    const items = safeReaddir(dir);
    for (const item of items) {
      const statePath = path.join(dir, item, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        try {
          missions.push(readJsonFile<Mission>(statePath));
        } catch (_) {}
      }
    }
  }

  return missions.sort((a, b) => {
    const aTime = a.history[0]?.ts || '';
    const bTime = b.history[0]?.ts || '';
    return aTime.localeCompare(bTime);
  });
}

function renderJournal() {
  console.log(chalk.bold.cyan('\n📜 [KYBERION] Mission Journal: Ecosystem Evolution\n'));
  
  const missions = scanMissions();
  
  if (missions.length === 0) {
    console.log('No missions recorded yet.');
    return;
  }

  missions.forEach(m => {
    const statusColor = m.status === 'completed' ? chalk.green : m.status === 'active' ? chalk.yellow : chalk.gray;
    const tierIcon = m.tier === 'personal' ? '🛡️' : m.tier === 'confidential' ? '🔒' : '🌐';
    
    console.log(`${tierIcon} ${chalk.bold(m.mission_id.padEnd(25))} [${statusColor(m.status.toUpperCase())}] (${m.tier})`);
    
    // Relationships
    if (m.relationships) {
      if (m.relationships.prerequisites?.length) {
        console.log(`   ${chalk.blue('← Prerequisites:')} ${m.relationships.prerequisites.join(', ')}`);
      }
      if (m.relationships.successors?.length) {
        console.log(`   ${chalk.magenta('→ Successors:')} ${m.relationships.successors.join(', ')}`);
      }
    }

    m.history.forEach((h, idx) => {
      const isLast = idx === m.history.length - 1;
      const prefix = isLast ? ' └── ' : ' ├── ';
      const time = new Date(h.ts).toLocaleString();
      console.log(`   ${chalk.gray(prefix)}${chalk.dim(time)}: ${chalk.white(h.event)} - ${chalk.italic(h.note)}`);
    });
    console.log('');
  });

  // Summary
  const stats = missions.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {} as any);

  console.log(chalk.bold('📈 Summary:'));
  Object.keys(stats).forEach(s => {
    console.log(`  - ${s.toUpperCase()}: ${stats[s]}`);
  });
  console.log(`  - TOTAL MISSIONS: ${missions.length}\n`);

  // Trust Scores Summary
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  if (safeExistsSync(ledgerPath)) {
    const raw = readJsonFile<any>(ledgerPath);
    const ledger = raw?.agents ?? raw ?? {};
    console.log(chalk.bold('🤝 Agent Trust Scores:'));
    Object.keys(ledger).forEach(a => {
      const score = ledger[a].current_score;
      const normalized = score / 100;
      const color = normalized >= 7.0 ? chalk.green : normalized >= 5.0 ? chalk.yellow : chalk.red;
      console.log(`  - ${a}: ${color(normalized.toFixed(1))}/10.0`);
    });
    console.log('');
  }
}

renderJournal();
