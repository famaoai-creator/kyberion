import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { metrics } from '@agent/core/metrics';
import { calculateReinvestment } from '@agent/core/finance';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const perfDir = path.join(rootDir, 'evidence/performance');
const outputFile = path.join(rootDir, 'PERFORMANCE_DASHBOARD.md');

/**
 * Performance Dashboard Generator
 * Aggregates structured evidence to visualize ecosystem health trends.
 */

interface PerfReport {
  summary: { total_records: number; unique_skills: number };
  regressions: any[];
  slow_skills: any[];
  unstable_skills: any[];
  efficiency_alerts: any[];
  slo_breaches?: any[];
  [key: string]: any;
}

function generate(): void {
  if (!fs.existsSync(perfDir)) {
    console.log(chalk.yellow('[WARN] No performance evidence found. Run check_performance.cjs first.'));
    return;
  }

  const files = fs.readdirSync(perfDir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return;

  // Load and aggregate
  const reports: PerfReport[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(perfDir, f), 'utf8')));
  const latest = reports[reports.length - 1];

  // Aggregates for summary
  const avgScore = Math.round(
    latest.efficiency_alerts.reduce((acc: number, s: any) => acc + s.efficiencyScore, 0) /
      (latest.efficiency_alerts.length || 1)
  );
  const totalExecs = latest.summary.total_records;
  const avgCacheHit = Math.round(
    latest.unstable_skills.reduce((acc: number, s: any) => acc + (s.cacheHitRatio || 0), 0) /
      (latest.unstable_skills.length || 1)
  );
  const totalRecoveries = latest.unstable_skills.reduce((acc: number, s: any) => acc + (s.recoveries || 0), 0);

  let md = '# 🚀 Performance & Reliability Intelligence Dashboard\n\n';
  md += `*Last Updated: ${new Date().toLocaleString()}*\n\n`;

  md += '## 📊 Ecosystem Health Summary\n\n';
  md += '| Metric | Value | Status |\n';
  md += '| :--- | :--- | :--- |\n';
  md += `| **Overall Efficiency** | ${avgScore}/100 | ${avgScore >= 80 ? '🟢 Excellent' : '🟡 Good'} |\n`;
  
  const successRate = totalExecs > 0 ? (100 - (latest.unstable_skills.reduce((acc: number, s: any) => acc + s.errors, 0) / totalExecs) * 100).toFixed(1) : 100;
  md += `| **Reliability (Success)** | ${successRate}% | 🛡️ Secure |\n`;
  
  const sloStatus = latest.slo_breaches ? (latest.slo_breaches.length === 0 ? '100%' : '⚠️ Warning') : '--';
  const sloIcon = latest.slo_breaches && latest.slo_breaches.length === 0 ? '🟢 Pass' : '🔴 Breach';
  md += `| **SLO Compliance** | ${sloStatus} | ${sloIcon} |\n`;
  md += `| **Cache Hit Ratio** | ${avgCacheHit}% | ⚡ High Speed |\n`;
  md += `| **Total Recoveries** | ${totalRecoveries} | ♻️ Self-Healing |\n\n`;

  // --- ROI Section (Business) ---
  const totalSavedMs = latest.unstable_skills.reduce((acc: number, s: any) => acc + (s.savedMs || 0), 0);
  const totalSavedCost = latest.unstable_skills.reduce((acc: number, s: any) => acc + (s.savedCost || 0), 0);
  const totalSavedHours = Math.round(totalSavedMs / 3600000);

  const strat = calculateReinvestment(totalSavedHours);

  md += '## 💰 Business Impact & Strategic ROI\n\n';
  md += `> **Total Value Generated: $${totalSavedCost.toLocaleString()}** (Time Saved: ${totalSavedHours}h)\n\n`;

  md += '### 🏗️ Reinvestment Potential\n\n';
  md += `- **Reinvestable Capacity**: ${strat.reinvestableHours} engineering hours\n`;
  md += `- **New Skills Potential**: 🚀 **${strat.potentialFeatures} additional features** possible\n`;
  md += `- **Strategic Advice**: ${strat.recommendation}\n\n`;

  md += '| Top Contributors | Saved Cost | Saved Hours |\n';
  md += '| :--- | :--- | :--- |\n';
  latest.unstable_skills
    .sort((a: any, b: any) => (b.savedCost || 0) - (a.savedCost || 0))
    .slice(0, 5)
    .forEach((s: any) => {
      md += `| **${s.skill}** | $${(s.savedCost || 0).toLocaleString()} | ${((s.savedMs || 0) / 3600000).toFixed(1)}h |\n`;
    });
  md += '\n';

  // --- Hall of Fame ---
  const topPerformers = latest.efficiency_alerts
    .filter((s: any) => s.efficiencyScore >= 90)
    .sort((a: any, b: any) => b.efficiencyScore - a.efficiencyScore)
    .slice(0, 5);

  if (topPerformers.length > 0) {
    md += '### 🏆 Hall of Fame (Top Performers)\n\n';
    topPerformers.forEach((s: any) => {
      md += `- **${s.skill}** ([A+]) - Score: ${s.efficiencyScore}, Avg: ${s.avgMs}ms\n`;
    });
    md += '\n';
  }

  md += '## 1. Top Performance Alerts\n\n';
  if (latest.regressions.length > 0) {
    md += '### ⚠️ Regressions (Significant Slowdown)\n\n';
    md += '| Skill | Current | Historical Avg | Factor |\n';
    md += '| :--- | :--- | :--- | :--- |\n';
    latest.regressions.forEach((r: any) => {
      md += `| **${r.skill}** | ${r.lastDuration}ms | ${r.historicalAvg}ms | ${r.increaseRate}x |\n`;
    });
    md += '\n';
  }

  if (latest.efficiency_alerts.length > 0) {
    md += '### 💎 Low Efficiency (Resource vs Speed)\n\n';
    md += '| Skill | Score | Trend | Latency | Memory |\n';
    md += '| :--- | :--- | :--- | :--- | :--- |\n';
    latest.efficiency_alerts
      .sort((a: any, b: any) => a.efficiencyScore - b.efficiencyScore)
      .forEach((s: any) => {
        let trendIcon = '➖';
        if (s.trend === 'improving') trendIcon = '📈';
        if (s.trend === 'degrading') trendIcon = '📉';
        md += `| **${s.skill}** | ${s.efficiencyScore} | ${trendIcon} | ${s.avgMs}ms | ${s.peakHeapMB}MB |\n`;
      });
    md += '\n';
  }

  // --- SLO Breaches ---
  if (latest.slo_breaches && latest.slo_breaches.length > 0) {
    md += '## ⚠️ SRE Service Level Objective (SLO) Breaches\n\n';
    md += '| Skill | Latency (Act/Tar) | Success (Act/Tar) | Status |\n';
    md += '| :--- | :--- | :--- | :--- |\n';
    latest.slo_breaches.forEach((b: any) => {
      md += `| **${b.skill}** | ${b.actual_latency}ms / ${b.target_latency}ms | ${b.actual_success}% / ${b.target_success}% | 🔴 BREACH |\n`;
    });
    md += '\n';
  }

  md += '## 2. Stability Watchlist (High Error Rates)\n\n';
  md += '| Skill | Error Rate | Fail/Total |\n';
  md += '| :--- | :--- | :--- |\n';
  latest.unstable_skills
    .sort((a: any, b: any) => b.errorRate - a.errorRate)
    .forEach((s: any) => {
      md += `| **${s.skill}** | ${s.errorRate}% | ${s.errors}/${s.executions} |\n`;
    });

  md += '\n## 3. Bottleneck Analysis (Slowest Skills)\n\n';
  md += '| Skill | Avg Time | Max Time |\n';
  md += '| :--- | :--- | :--- |\n';
  latest.slow_skills.forEach((s: any) => {
    md += `| **${s.skill}** | ${s.avgMs}ms | ${s.maxMs}ms |\n`;
  });

  md += '\n---\n*Generated by Performance Engineer & SRE Tool*';

  safeWriteFile(outputFile, md);
  console.log(chalk.green(`[SUCCESS] Performance Dashboard generated at ${outputFile}`));
}

generate();
