#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * executive-reporting-maestro: Synthesizes multiple skill outputs into executive reports.
 * Accepts a directory of JSON result files and produces a consolidated summary.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to a directory of JSON result files or a single JSON file',
  })
  .option('title', {
    alias: 't',
    type: 'string',
    default: 'Executive Status Report',
    description: 'Report title',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path (JSON or .md)',
  })
  .help()
  .argv;

function loadResults(inputPath) {
  const results = [];
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    const content = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    if (Array.isArray(content)) {
      results.push(...content);
    } else {
      results.push(content);
    }
  } else if (stat.isDirectory()) {
    const files = fs.readdirSync(inputPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(inputPath, file), 'utf8'));
        results.push(content);
      } catch (_e) { /* skip invalid JSON */ }
    }
  }

  return results;
}

function categorizeResult(result) {
  const skill = result.skill || 'unknown';
  const status = result.status || 'unknown';

  // Categorize by domain
  if (skill.match(/security|scanner|vulnerability/i)) return { domain: 'Security', skill, status };
  if (skill.match(/quality|score|completeness/i)) return { domain: 'Quality', skill, status };
  if (skill.match(/health|audit|governance/i)) return { domain: 'Project Health', skill, status };
  if (skill.match(/cost|financial|budget|economics/i)) return { domain: 'Financial', skill, status };
  if (skill.match(/performance|monitor/i)) return { domain: 'Performance', skill, status };
  if (skill.match(/ux|accessibility/i)) return { domain: 'UX & Accessibility', skill, status };
  if (skill.match(/dependency|license/i)) return { domain: 'Dependencies', skill, status };
  return { domain: 'Other', skill, status };
}

function extractHighlights(results) {
  const highlights = [];
  const risks = [];

  for (const result of results) {
    const data = result.data || {};

    // Extract scores/grades
    if (data.score !== undefined) {
      const item = { skill: result.skill, score: data.score, grade: data.grade };
      if (data.score >= 80) {
        highlights.push({ type: 'positive', ...item, message: `${result.skill}: Score ${data.score}${data.grade ? ' (' + data.grade + ')' : ''}` });
      } else {
        risks.push({ type: 'concern', ...item, message: `${result.skill}: Score ${data.score}${data.grade ? ' (' + data.grade + ')' : ''} - below threshold` });
      }
    }

    // Extract recommendations
    if (Array.isArray(data.recommendations)) {
      for (const rec of data.recommendations.slice(0, 2)) {
        const msg = typeof rec === 'string' ? rec : rec.action || rec.recommendation || JSON.stringify(rec);
        risks.push({ type: 'recommendation', skill: result.skill, message: msg });
      }
    }

    // Extract errors
    if (result.status === 'error' && result.error) {
      risks.push({ type: 'error', skill: result.skill, message: result.error.message });
    }
  }

  return { highlights, risks };
}

function generateMarkdown(title, report) {
  const lines = [`# ${title}`, '', `**Generated:** ${report.generatedAt}`, ''];

  lines.push('## Executive Summary', '');
  lines.push(`- **Reports Analyzed:** ${report.totalResults}`);
  lines.push(`- **Successful:** ${report.successCount} | **Failed:** ${report.errorCount}`);
  lines.push('');

  if (report.highlights.length > 0) {
    lines.push('## Highlights', '');
    for (const h of report.highlights) {
      lines.push(`- ${h.message}`);
    }
    lines.push('');
  }

  if (report.risks.length > 0) {
    lines.push('## Risks & Recommendations', '');
    for (const r of report.risks) {
      const icon = r.type === 'error' ? '[ERROR]' : r.type === 'concern' ? '[CONCERN]' : '[REC]';
      lines.push(`- ${icon} ${r.message}`);
    }
    lines.push('');
  }

  if (report.domainSummary.length > 0) {
    lines.push('## Domain Breakdown', '');
    for (const d of report.domainSummary) {
      lines.push(`### ${d.domain}`);
      lines.push(`Skills: ${d.skills.join(', ')} | Success: ${d.successCount}/${d.total}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

runSkill('executive-reporting-maestro', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }

  const results = loadResults(resolved);
  if (results.length === 0) {
    throw new Error('No valid JSON results found in the input path');
  }

  const categorized = results.map(categorizeResult);
  const { highlights, risks } = extractHighlights(results);

  // Domain summary
  const domainMap = {};
  for (let i = 0; i < results.length; i++) {
    const cat = categorized[i];
    if (!domainMap[cat.domain]) domainMap[cat.domain] = { domain: cat.domain, skills: [], successCount: 0, total: 0 };
    domainMap[cat.domain].skills.push(cat.skill);
    domainMap[cat.domain].total++;
    if (cat.status === 'success') domainMap[cat.domain].successCount++;
  }

  const report = {
    title: argv.title,
    generatedAt: new Date().toISOString(),
    totalResults: results.length,
    successCount: results.filter(r => r.status === 'success').length,
    errorCount: results.filter(r => r.status === 'error').length,
    highlights,
    risks,
    domainSummary: Object.values(domainMap),
  };

  if (argv.out) {
    if (argv.out.endsWith('.md')) {
      safeWriteFile(argv.out, generateMarkdown(argv.title, report));
    } else {
      safeWriteFile(argv.out, JSON.stringify(report, null, 2));
    }
  }

  return report;
});
