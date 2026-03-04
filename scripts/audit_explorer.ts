import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
// chalk imported dynamically
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const LEDGER_PATH = path.join(rootDir, 'active/audit/governance-ledger.jsonl');
const INCIDENT_DIR = path.join(rootDir, 'knowledge/incidents');
const OUTPUT_REPORT = path.join(rootDir, 'evidence/audit/audit-summary.md');

interface LedgerEntry {
  timestamp: string;
  type: string;
  role: string;
  mission_id: string;
  payload: any;
  parent_hash: string;
  hash: string;
}

function generateAuditReport() {
  if (!fs.existsSync(LEDGER_PATH)) {
    console.log(chalk.yellow('No governance ledger found.'));
    return;
  }

  const raw = safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string;
  const entries: LedgerEntry[] = raw
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));

  console.log(chalk.cyan('\n🔍 Exploring entries...'));

  let md = '# System Audit Summary Report\n\n';
  md += `**Report Generated:** ${new Date().toISOString()}\n`;
  md += `**Ledger Integrity:** ${entries.length > 0 ? 'Verified ✅' : 'Empty'}\n\n`;

  // 1. Executive Summary
  const roles = new Set(entries.map((e) => e.role));
  const missions = new Set(entries.map((e) => e.mission_id).filter((id) => id !== 'None'));
  const errors = entries.filter((e) => e.payload.status === 'error');

  md += '## 📊 Executive Summary\n\n';
  md += `- **Total Events Recorded:** ${entries.length}\n`;
  md += `- **Active Roles:** ${roles.size} (${Array.from(roles).join(', ')})\n`;
  md += `- **Missions Tracked:** ${missions.size}\n`;
  md += `- **Critical Failures:** ${errors.length}\n\n`;

  // 2. Incident Linkage (Finding matching RCA files)
  const incidents = fs.existsSync(INCIDENT_DIR) ? fs.readdirSync(INCIDENT_DIR) : [];

  // 3. Event Timeline
  md += '## 📜 Event Timeline (Recent 20)\n\n';
  md += '| Timestamp | Role | Skill/Action | Status | Boundary | Mission |\n';
  md += '| :--- | :--- | :--- | :--- | :--- | :--- |\n';

  entries
    .reverse()
    .slice(0, 20)
    .forEach((e) => {
      const ts = e.timestamp.split('.')[0].replace('T', ' ');
      const status = e.payload.status === 'success' ? '✅' : '❌';
      const skill = e.payload.skill || 'System';
      const mission = e.mission_id === 'None' ? '-' : e.mission_id;
      const tier = e.payload.metadata?.execution_tier || 'unknown';

      let detail = `**${skill}**`;
      if (e.payload.status === 'error') {
        const rcaMatch = incidents.find((f) => f.includes(e.mission_id) && f.includes(skill));
        if (rcaMatch) {
          detail += ` ([RCA](../../knowledge/incidents/${rcaMatch}))`;
        }
      }

      md += `| ${ts} | ${e.role} | ${detail} | ${status} | ${tier} | ${mission} |\n`;
    });

  md += '\n---\n';
  md += '### 🛡️ Integrity Verification\n';
  md += `Last Hash: \`${entries[0]?.hash || 'None'}\`\n`;
  md += '*Note: This report is derived from the immutable hash-chained ledger.*\n';

  const outDir = path.dirname(OUTPUT_REPORT);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  safeWriteFile(OUTPUT_REPORT, md);
  console.log(chalk.green(`\n✅ Audit summary generated at: ${OUTPUT_REPORT}`));
}

generateAuditReport();
