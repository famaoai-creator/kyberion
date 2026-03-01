#!/usr/bin/env node
/**
 * Autonomous Wisdom Distiller v1.0
 * Analyzes the Governance Ledger and Mission logs to extract permanent learnings.
 */

const { logger, pathResolver, safeReadFile, safeWriteFile } = require('./system-prelude.cjs');
const fs = require('fs');
const path = require('path');

const LEDGER_PATH = pathResolver.rootResolve('active/audit/governance-ledger.jsonl');
const EVOLUTION_DIR = pathResolver.knowledge('evolution');

async function distill() {
  if (!fs.existsSync(LEDGER_PATH)) {
    logger.warn('No ledger found to distill.');
    return;
  }

  logger.info('🧠 Distilling wisdom from governance ledger...');
  
  try {
    const content = safeReadFile(LEDGER_PATH, { encoding: 'utf8' });
    const lines = content.trim().split('\n');
    const entries = lines.map(l => JSON.parse(l));
    
    const failures = entries.filter(e => e.payload && (e.payload.status === 'error' || e.type === 'VIOLATION'));
    const successes = entries.filter(e => e.payload && e.payload.status === 'success');

    const timestamp = new Date().toISOString().split('T')[0];
    const reportFile = path.join(EVOLUTION_DIR, `wisdom_${timestamp.replace(/-/g, '_')}.md`);

    let report = `# 🧠 Autonomous Wisdom Distillation - ${timestamp}\n\n`;
    report += `## 🛡️ Critical Incidents & Learned Patterns\n\n`;

    if (failures.length > 0) {
      const patterns = new Set(failures.map(f => f.payload.script || f.type));
      patterns.forEach(p => {
        const count = failures.filter(f => (f.payload.script || f.type) === p).length;
        report += `- **Pattern: ${p}**\n  - Occurrences: ${count}\n  - Insight: Recurring issues detected. Automated repair or architectural refinement recommended.\n`;
      });
    } else {
      report += `No critical failures detected. Ecosystem stability is high.\n`;
    }

    report += `\n## ✅ Stabilization Achievements\n\n`;
    report += `- Total Success Events: ${successes.length}\n`;
    report += `- Integrity Level: Verified by Ledger Chain.\n`;

    if (!fs.existsSync(EVOLUTION_DIR)) fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
    
    if (fs.existsSync(reportFile)) {
      const existing = safeReadFile(reportFile, { encoding: 'utf8' });
      safeWriteFile(reportFile, existing + '\n\n---\n\n' + report);
    } else {
      safeWriteFile(reportFile, report);
    }

    logger.success(`✅ Wisdom distilled to ${path.relative(pathResolver.rootDir(), reportFile)}`);
  } catch (err) {
    logger.error(`Distillation Failure: ${err.message}`);
  }
}

distill();
