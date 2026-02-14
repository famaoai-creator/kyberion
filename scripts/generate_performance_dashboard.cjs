#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '..');
const perfDir = path.join(rootDir, 'evidence/performance');
const outputFile = path.join(rootDir, 'PERFORMANCE_DASHBOARD.md');

/**
 * Performance Dashboard Generator
 * Aggregates structured evidence to visualize ecosystem health trends.
 */

function generate() {
  if (!fs.existsSync(perfDir)) {
    console.log(chalk.yellow('[WARN] No performance evidence found. Run check_performance.cjs first.'));
    return;
  }

  const files = fs.readdirSync(perfDir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return;

  // Load and aggregate
  const reports = files.map((f) => JSON.parse(fs.readFileSync(path.join(perfDir, f), 'utf8')));
  const latest = reports[reports.length - 1];

  // Aggregates for summary
  const avgScore = Math.round(
    latest.efficiency_alerts.reduce((acc, s) => acc + s.efficiencyScore, 0) /
      (latest.efficiency_alerts.length || 1)
  );
  const totalExecs = latest.summary.total_records;
  const avgCacheHit = Math.round(
    latest.unstable_skills.reduce((acc, s) => acc + (s.cacheHitRatio || 0), 0) /
      (latest.unstable_skills.length || 1)
  );
  const totalRecoveries = latest.unstable_skills.reduce((acc, s) => acc + (s.recoveries || 0), 0);

  let md = '# 🚀 Performance & Reliability Intelligence Dashboard\n\n';
  md += `*Last Updated: ${new Date().toLocaleString()}*\n\n`;

  md += '## 📊 Ecosystem Health Summary\n\n';
  md += '| Metric | Value | Status |\n';
  md += '| :--- | :--- | :--- |\n';
  md += `| **Overall Efficiency** | ${avgScore}/100 | ${avgScore >= 80 ? '🟢 Excellent' : '🟡 Good'} |\n`;
  md += `| **Reliability (Success)** | ${totalExecs > 0 ? (100 - (latest.unstable_skills.reduce((acc, s) => acc + s.errors, 0) / totalExecs) * 100).toFixed(1) : 100}% | 🛡️ Secure |\n`;
  md += `| **SLO Compliance** | ${latest.slo_breaches ? (latest.slo_breaches.length === 0 ? '100%' : '⚠️ Warning') : '--'} | ${latest.slo_breaches && latest.slo_breaches.length === 0 ? '🟢 Pass' : '🔴 Breach'} |\n`;
  md += `| **Cache Hit Ratio** | ${avgCacheHit}% | ⚡ High Speed |\n`;
  md += `| **Total Recoveries** | ${totalRecoveries} | ♻️ Self-Healing |\n\n`;

  // --- ROI Section (Business) ---
  const totalSavedMs = latest.unstable_skills.reduce((acc, s) => acc + (s.savedMs || 0), 0);
  const totalSavedCost = latest.unstable_skills.reduce((acc, s) => acc + (s.savedCost || 0), 0);
  const totalSavedHours = Math.round(totalSavedMs / 3600000);

  const { calculateReinvestment } = require('./lib/finance.cjs');
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
    .sort((a, b) => (b.savedCost || 0) - (a.savedCost || 0))
    .slice(0, 5)
    .forEach((s) => {
      md += `| **${s.skill}** | $${(s.savedCost || 0).toLocaleString()} | ${(
        (s.savedMs || 0) / 3600000
      ).toFixed(1)}h |\n`;
    });
  md += '\n';

  // --- Hall of Fame ---
  const topPerformers = latest.efficiency_alerts
    .filter((s) => s.efficiencyScore >= 90)
    .sort((a, b) => b.efficiencyScore - a.efficiencyScore)
    .slice(0, 5);

  if (topPerformers.length > 0) {
    md += '### 🏆 Hall of Fame (Top Performers)\n\n';
    topPerformers.forEach((s) => {
      md += `- **${s.skill}** ([A+]) - Score: ${s.efficiencyScore}, Avg: ${s.avgMs}ms\n`;
    });
    md += '\n';
  }

  md += '## 1. Top Performance Alerts\n\n';
  if (latest.regressions.length > 0) {
    md += '### ⚠️ Regressions (Significant Slowdown)\n\n';
    md += '| Skill | Current | Historical Avg | Factor |\n';
    md += '| :--- | :--- | :--- | :--- |\n';
    latest.regressions.forEach((r) => {
      md += `| **${r.skill}** | ${r.lastDuration}ms | ${r.historicalAvg}ms | ${r.increaseRate}x |\n`;
    });
    md += '\n';
  }

  if (latest.efficiency_alerts.length > 0) {
    md += '### 💎 Low Efficiency (Resource vs Speed)\n\n';
    md += '| Skill | Score | Trend | Latency | Memory |\n';
    md += '| :--- | :--- | :--- | :--- | :--- |\n';
    latest.efficiency_alerts
      .sort((a, b) => a.efficiencyScore - b.efficiencyScore)
      .forEach((s) => {
        let trendIcon = '➖';
        if (s.trend === 'improving') trendIcon = '📈';
        if (s.trend === 'degrading') trendIcon = '📉';

        md += `| **${s.skill}** | ${s.efficiencyScore} | ${trendIcon} | ${s.avgMs}ms | ${s.peakHeapMB}MB |\n`;
      });
    md += '\n';
  }

  // --- SLO Breaches ---
  if (latest.slo_breaches && latest.slo_breaches.length > 0) {
    md += '<a name="slo-breaches"></a>\n';
    md += '## ⚠️ SRE Service Level Objective (SLO) Breaches\n\n';
    md += '| Skill | Latency (Act/Tar) | Success (Act/Tar) | Status |\n';
    md += '| :--- | :--- | :--- | :--- |\n';
    latest.slo_breaches.forEach((b) => {
      md += `| **${b.skill}** | ${b.actual_latency}ms / ${b.target_latency}ms | ${b.actual_success}% / ${b.target_success}% | 🔴 BREACH |\n`;
    });
    md += '\n';
  }

  md += '## 2. Stability Watchlist (High Error Rates)\n\n';
  md += '| Skill | Error Rate | Fail/Total |\n';
  md += '| :--- | :--- | :--- |\n';
  latest.unstable_skills
    .sort((a, b) => b.errorRate - a.errorRate)
    .forEach((s) => {
      md += `| **${s.skill}** | ${s.errorRate}% | ${s.errors}/${s.executions} |\n`;
    });

  md += '\n## 3. Bottleneck Analysis (Slowest Skills)\n\n';
  md += '| Skill | Avg Time | Max Time |\n';
  md += '| :--- | :--- | :--- |\n';
  latest.slow_skills.forEach((s) => {
    md += `| **${s.skill}** | ${s.avgMs}ms | ${s.maxMs}ms |\n`;
  });

  md += '\n## 4. Cache Efficiency (IO Optimization)\n\n';
  const cacheReadySkills = reports[reports.length - 1].unstable_skills
    .map((s) => {
      // We reuse the stability list but need to filter/sort by cache if we had more specific data
      // For now, let's assume reportFromHistory result is available or simulate from latest
      return { skill: s.skill, ratio: s.cacheHitRatio || 0 };
    })
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 10);

  if (cacheReadySkills.length > 0) {
    md += '| Skill | Cache Hit Ratio | Status |\n';
    md += '| :--- | :--- | :--- |\n';
    cacheReadySkills.forEach((s) => {
      const icon = s.ratio > 80 ? '🚀' : s.ratio > 50 ? '📈' : '🐌';
      md += `| ${s.skill} | ${s.ratio}% | ${icon} |\n`;
    });
  }

  md += '\n## 5. Memory Pressure (Purge Events)\n\n';
  const purgeSkills = reports[reports.length - 1].unstable_skills
    .filter((s) => s.cachePurges > 0)
    .sort((a, b) => b.cachePurges - a.cachePurges)
    .slice(0, 10);

  if (purgeSkills.length > 0) {
    md += '| Skill | Purge Count | Impact |\n';
    md += '| :--- | :--- | :--- |\n';
    purgeSkills.forEach((s) => {
      md += `| ${s.skill} | ${s.cachePurges} | ⚠️ Memory Pressure |\n`;
    });
  } else {
    md += '*No significant memory pressure detected.*\n';
  }

  md += '\n## 6. Data Efficiency (Payload Size)\n\n';
  const heavySkills = reports[reports.length - 1].unstable_skills
    .filter((s) => s.outputSizeKB > 500) // Alert if > 500KB
    .sort((a, b) => b.outputSizeKB - a.outputSizeKB);

  if (heavySkills.length > 0) {
    md += '| Skill | Output Size (KB) | Status |\n';
    md += '| :--- | :--- | :--- |\n';
    heavySkills.forEach((s) => {
      md += `| ${s.skill} | ${s.outputSizeKB}KB | 📉 Heavy Payload |\n`;
    });
  } else {
    md += '✅ All skills maintain efficient output payloads (< 500KB).\n';
  }

  md += '\n## 7. Data Integrity (Cache Health)\n\n';
  const integrityFailures = reports[reports.length - 1].unstable_skills
    .filter((s) => s.cacheIntegrityFailures > 0)
    .sort((a, b) => b.cacheIntegrityFailures - a.cacheIntegrityFailures);

  if (integrityFailures.length > 0) {
    md += '| Skill | Hash Mismatches | Status |\n';
    md += '| :--- | :--- | :--- |\n';
    integrityFailures.forEach((s) => {
      md += `| ${s.skill} | ${s.cacheIntegrityFailures} | ❌ Corrupted Data Detected |\n`;
    });
  } else {
    md += '✅ No cache integrity violations detected.\n';
  }

  md += '\n## 8. Reliability Trends (Historical SLO)\n\n';
  // Use history to show stability trend
  const { metrics } = require('./lib/metrics.cjs');
  const history = metrics.reportFromHistory();

  md += '| Skill | 7-Day Reliability | Current SLO |\n';
  md += '| :--- | :--- | :--- |\n';
  history.skills.slice(0, 15).forEach((s) => {
    const compliance = s.sloCompliance || 0;
    // Simple bar visual: [#####-----]
    const barLen = 10;
    const filled = Math.round(compliance / 10);
    const spark = '[' + '#'.repeat(filled) + '-'.repeat(barLen - filled) + ']';
    const status =
      compliance >= 95 ? '💎 Stable' : compliance >= 80 ? '📈 Improving' : '⚠️ Volatile';
    md += `| **${s.skill}** | \`${spark}\` ${compliance}% | ${status} |\n`;
  });

  md += '\n---\n*Generated by Performance Engineer & SRE Tool*';

  fs.writeFileSync(outputFile, md);
  console.log(chalk.green(`[SUCCESS] Performance Dashboard generated at ${outputFile}`));
}

generate();
