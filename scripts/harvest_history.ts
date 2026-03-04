import chalk from 'chalk';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// chalk imported dynamically
import { safeWriteFile } from '@agent/core';

const rootDir = process.cwd();
const outputPath = path.join(rootDir, 'tools/chronos-mirror/public/history.json');

/**
 * Snapshot Harvester
 * Extracts historical metrics from Git commits to fuel the DeepWiki Temporal Slider.
 */

interface HistoryEntry {
  date: string;
  efficiency: number;
  reliability: number;
  status: string;
  note: string;
}

function harvest(): void {
  console.log(chalk.cyan('\n⌛ Harvesting project history from Git...'));

  const history: HistoryEntry[] = [];
  const maxSnapshots = 10;

  try {
    const logs = execSync(`git log -n ${maxSnapshots} --pretty=format:"%h|%ad|%s" --date=short`, {
      encoding: 'utf8',
    }).split('\n');

    for (const log of logs) {
      if (!log.trim()) continue;
      const [hash, date, subject] = log.split('|');

      try {
        const content = execSync(`git show ${hash}:PERFORMANCE_DASHBOARD.md`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });

        const effMatch = content.match(/\*\*Overall Efficiency\*\* \| (\d+)\/100/);
        const relMatch = content.match(/\*\*Reliability \(Success\)\*\* \| ([\d\.]+)%/);

        if (effMatch && relMatch) {
          history.push({
            date,
            efficiency: parseInt(effMatch[1], 10),
            reliability: parseFloat(relMatch[1]),
            status: hash,
            note: subject,
          });
        }
      } catch (_e) {
        // Skip commits without the dashboard
      }
    }

    const sortedHistory = history.reverse();
    const outDir = path.dirname(outputPath);
    
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    
    safeWriteFile(outputPath, JSON.stringify(sortedHistory, null, 2));

    console.log(
      chalk.green(
        `✔ Successfully harvested ${sortedHistory.length} snapshots to history.json\n`
      )
    );
  } catch (err: any) {
    console.error(chalk.red(`Failed to harvest history: ${err.message}`));
  }
}

harvest();
