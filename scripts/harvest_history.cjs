#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '..');
const outputPath = path.join(rootDir, 'tools/chronos-mirror/public/history.json');

/**
 * Snapshot Harvester
 * Extracts historical metrics from Git commits to fuel the DeepWiki Temporal Slider.
 */

function harvest() {
  console.log(chalk.cyan(`\n\u23f3 Harvesting project history from Git...`));

  const history = [];
  const maxSnapshots = 10; // 過去10件の履歴を取得

  try {
    // 過去のコミットから PERFORMANCE_DASHBOARD.md の内容を取得
    const logs = execSync(`git log -n ${maxSnapshots} --pretty=format:"%h|%ad|%s" --date=short`, { encoding: 'utf8' }).split('\n');

    for (const log of logs) {
      if (!log.trim()) continue;
      const [hash, date, subject] = log.split('|');
      
      try {
        // 特定のコミット時点のダッシュボードを読み取り
        const content = execSync(`git show ${hash}:PERFORMANCE_DASHBOARD.md`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        
        // 正規表現で数値を抽出
        const effMatch = content.match(/\*\*Overall Efficiency\*\* \| (\d+)\/100/);
        const relMatch = content.match(/\*\*Reliability \(Success\)\*\* \| ([\d\.]+)%/);

        if (effMatch && relMatch) {
          history.push({
            date,
            efficiency: parseInt(effMatch[1]),
            reliability: parseFloat(relMatch[1]),
            status: hash,
            note: subject
          });
        }
      } catch (e) {
        // ファイルが存在しないコミットはスキップ
      }
    }

    // 日付昇順にソートして保存
    const sortedHistory = history.reverse();
    if (!fs.existsSync(path.dirname(outputPath))) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(sortedHistory, null, 2));

    console.log(chalk.green(`\u2714 Successfully harvested ${sortedHistory.length} snapshots to history.json\n`));
  } catch (err) {
    console.error(chalk.red(`Failed to harvest history: ${err.message}`));
  }
}

harvest();
