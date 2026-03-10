import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, safeExistsSync, safeReaddir, safeReadFile } from '../libs/core/index.js';
import chalk from 'chalk';

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
    path.join(ROOT_DIR, 'active/missions/public'),
    path.join(ROOT_DIR, 'active/missions/confidential'),
    path.join(ROOT_DIR, 'knowledge/personal/missions'),
    path.join(ROOT_DIR, 'active/archive/missions')
  ];

  const missions: Mission[] = [];

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir)) continue;
    const items = safeReaddir(dir);
    for (const item of items) {
      const statePath = path.join(dir, item, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        try {
          const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
          missions.push(JSON.parse(content));
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
  const ledgerPath = path.join(ROOT_DIR, 'knowledge/personal/governance/agent-trust-scores.json');
  if (safeExistsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    console.log(chalk.bold('🤝 Agent Trust Scores:'));
    Object.keys(ledger.agents).forEach(a => {
      const score = ledger.agents[a].current_score;
      const color = score >= 7.0 ? chalk.green : score >= 5.0 ? chalk.yellow : chalk.red;
      console.log(`  - ${a}: ${color(score.toFixed(1))}/10.0`);
    });
    console.log('');
  }
}

renderJournal();
