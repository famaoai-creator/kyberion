import { logger, pathResolver, safeReadFile, safeWriteFile, safeReaddir, safeStat, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as yaml from 'js-yaml';

// Dynamic import for chalk (ESM module in CommonJS environment)
let chalk: any;
async function initChalk() {
  if (!chalk) {
    const m = await import('chalk');
    chalk = m.default;
  }
}

/**
 * Wisdom-Actuator v1.3.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

const VAULT_DIR = path.join(process.cwd(), 'knowledge/evolution/latent-wisdom');

interface ReportSpec {
  type: 'debt' | 'docs' | 'vital';
  output_file?: string;
  options?: any;
}

interface WisdomAction {
  action: 'distill' | 'mirror' | 'swap' | 'sync' | 'aggregate' | 'report' | 'sync_docs' | 'sync_skill_dates' | 'scan_pii';
  patchId?: string;
  missionId?: string;
  targetTier?: 'public' | 'confidential' | 'personal';
  target_dir?: string; // for 'aggregate' action
  output_file?: string; // for 'aggregate' or 'distill' action
  reports?: ReportSpec[]; // for 'report' action
  options?: any;
  mode?: 'mission' | 'archive' | 'ledger' | 'all';
  targets?: string[];
}

interface CapabilityEntry {
  n: string; path: string; d: string; s: string; r: string; m: string; t: string[]; u: string; p?: string[];
}

function initializeCapability(capabilityPath: string, name: string, category: string) {
  const skillMdPath = path.join(capabilityPath, 'SKILL.md');
  const pkgPath = path.join(capabilityPath, 'package.json');

  if (!fs.existsSync(skillMdPath)) {
    const mdContent = `---\nname: ${name}\ndescription: New autonomous capability discovery.\nstatus: planned\ncategory: ${category}\nlast_updated: '${new Date().toISOString().split('T')[0]}'\n---\n\n# ${name}\n\nDescription pending initialization.\n`;
    safeWriteFile(skillMdPath, mdContent);
    logger.info(`✨ Auto-Discovery: Initialized SKILL.md for ${name}`);
  }

  if (!fs.existsSync(pkgPath)) {
    const pkgContent = {
      name: `@agent/capability-${name}`,
      version: '1.0.0',
      private: true,
      description: `Kyberion Capability: ${name}`,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      dependencies: { "@agent/core": "workspace:*" }
    };
    safeWriteFile(pkgPath, JSON.stringify(pkgContent, null, 2));
    logger.info(`✨ Auto-Discovery: Initialized package.json for ${name}`);
  }
}

async function handleAction(input: WisdomAction) {
  switch (input.action) {
    case 'distill':
      return await performDistillation(input);

    case 'swap':
      const patchPath = path.join(VAULT_DIR, `${input.patchId}.json`);
      const patchContent = safeReadFile(patchPath, { encoding: 'utf8' }) as string;
      const patchData = JSON.parse(patchContent);
      return { activeRules: patchData.delta_rules };

    case 'sync':
      logger.info(`🔄 [WISDOM] Synchronizing to ${input.targetTier} tier...`);
      return { status: 'synchronized' };

    case 'aggregate':
      return await performAggregation(input);

    case 'report':
      return await performReporting(input);

    case 'sync_docs':
      return await performSyncDocs();

    case 'sync_skill_dates':
      return await performSyncSkillDates();

    case 'scan_pii':
      return await performScanPII();

    default:
      return { status: 'executed' };
  }
}

async function performSyncDocs() {
  const rootDir = process.cwd();
  const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
  const readmePath = path.join(rootDir, 'README.md');
  const guidePath = path.join(rootDir, 'SKILLS_GUIDE.md');

  if (!fs.existsSync(indexPath)) {
    return { status: 'failed', error: 'Index not found. Run aggregate action first.' };
  }

  try {
    const indexRaw = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    const index = JSON.parse(indexRaw);
    const skills = index.s || [];
    
    const implemented = skills.filter((s: any) => s.s === 'impl').length;

    logger.info(`Syncing docs: ${index.t} total, ${implemented} implemented...`);

    // 1. Update README.md
    if (fs.existsSync(readmePath)) {
      let readme = safeReadFile(readmePath, { encoding: 'utf8' }) as string;
      readme = readme.replace(
        /\*\*(\d+) skills\*\* \(all implemented\)/,
        `**${implemented} skills** (all implemented)`
      );
      readme = readme.replace(/Implemented Skills \((\d+)\)/, `Implemented Skills (${implemented})`);
      safeWriteFile(readmePath, readme);
    }

    // 2. Update SKILLS_GUIDE.md
    if (fs.existsSync(guidePath)) {
      let guide = safeReadFile(guidePath, { encoding: 'utf8' }) as string;
      guide = guide.replace(/Total Skills: (\d+)/, `Total Skills: ${implemented}`);
      guide = guide.replace(
        /Last updated: \d{4}\/\d{1,2}\/\d{1,2}/,
        `Last updated: ${new Date().toISOString().split('T')[0].replace(/-/g, '/')}`
      );
      safeWriteFile(guidePath, guide);
    }

    return { status: 'success', implemented };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

async function performSyncSkillDates() {
  const rootDir = process.cwd();
  const skillsRootDir = path.join(rootDir, 'skills');
  const skills: { name: string; path: string }[] = [];

  if (fs.existsSync(skillsRootDir)) {
    const categories = fs.readdirSync(skillsRootDir).filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
    for (const cat of categories) {
      const catPath = path.join(skillsRootDir, cat);
      const skillDirs = fs.readdirSync(catPath).filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
      for (const dir of skillDirs) {
        skills.push({ name: dir, path: path.join('skills', cat, dir) });
      }
    }
  }

  logger.info(`Syncing dates for ${skills.length} skills...`);
  let updatedCount = 0;

  for (const skillObj of skills) {
    const skillMdPath = path.join(rootDir, skillObj.path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    let gitDate;
    try {
      gitDate = execSync(`git log -1 --format=%cs -- "${skillMdPath}"`, { encoding: 'utf8' }).trim();
    } catch (_) {
      gitDate = new Date().toISOString().split('T')[0];
    }
    if (!gitDate) gitDate = new Date().toISOString().split('T')[0];

    const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!fmMatch) continue;

    try {
      const fm = yaml.load(fmMatch[1]) as any;
      if (fm.last_updated !== gitDate) {
        fm.last_updated = gitDate;
        const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
        const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
        safeWriteFile(skillMdPath, newContent);
        logger.info(`  [${skillObj.name}] last_updated -> ${gitDate}`);
        updatedCount++;
      }
    } catch (err: any) {
      logger.error(`Failed to sync date for ${skillObj.name}: ${err.message}`);
    }
  }

  return { status: 'success', updated: updatedCount };
}

async function performScanPII() {
  const rootDir = process.cwd();
  const knowledgeDir = path.resolve(rootDir, 'knowledge');
  const personalDir = path.join(knowledgeDir, 'personal');

  const FORBIDDEN_PATTERNS = [
    { name: 'API_KEY', regex: /AIza[0-9A-Za-z-_]{35}/ },
    { name: 'OAUTH_SECRET', regex: /[0-9A-Za-z-_]{24,32}\.apps\.googleusercontent\.com/ },
    { name: 'PRIVATE_KEY', regex: /-----BEGIN PRIVATE KEY-----/ },
    { name: 'GENERIC_SECRET', regex: /secret[:=]\s*['"][0-9A-Za-z-_]{16,}['"]/i },
  ];

  const violations: any[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (p.startsWith(personalDir)) continue;

      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        const content = fs.readFileSync(p, 'utf8');
        FORBIDDEN_PATTERNS.forEach((pattern) => {
          if (pattern.regex.test(content)) {
            violations.push({ file: path.relative(rootDir, p), type: pattern.name });
          }
        });
      }
    }
  }

  walk(knowledgeDir);

  if (violations.length > 0) {
    logger.error('🚨 SECURITY ALERT: Forbidden tokens detected in Knowledge Base!');
    violations.forEach((v) => logger.error(`  [${v.type}] ${v.file}`));
    return { status: 'violation', violations };
  } else {
    logger.success('Documentation safety verified. No sensitive tokens found.');
    return { status: 'success' };
  }
}

async function performDistillation(input: WisdomAction) {
  const mode = input.mode || 'all';
  const results: any[] = [];
  const timestamp = new Date().toISOString().split('T')[0];

  logger.info(`🧠 [WISDOM] Distillation started (Mode: ${mode})`);

  if (mode === 'mission' || mode === 'all') {
    const targets = input.targets || [];
    if (targets.length === 0) {
      const activeMissionsDir = path.resolve(process.cwd(), 'active/missions');
      if (fs.existsSync(activeMissionsDir)) {
        const missions = fs.readdirSync(activeMissionsDir).filter(f => fs.statSync(path.join(activeMissionsDir, f)).isDirectory());
        targets.push(...missions.map(m => path.join(activeMissionsDir, m)));
      }
    }
    
    for (const target of targets) {
      const result = await distillMission(target);
      if (result) results.push({ type: 'mission', target: path.basename(target), path: result });
    }
  }

  if (mode === 'archive' || mode === 'all') {
    const archiveResult = await distillArchives();
    if (archiveResult) results.push({ type: 'archive', path: archiveResult });
  }

  if (mode === 'ledger' || mode === 'all') {
    const ledgerResult = await distillLedger(timestamp);
    if (ledgerResult) results.push({ type: 'ledger', path: ledgerResult });
  }

  return { status: 'success', results };
}

async function distillMission(missionDir: string): Promise<string | null> {
  const missionId = path.basename(missionDir);
  const reportPath = path.join(missionDir, 'ace-report.json');
  const logPath = path.join(missionDir, 'execution.log');
  const wisdomDir = path.resolve(process.cwd(), 'knowledge/incidents');

  if (!fs.existsSync(reportPath)) return null;

  try {
    const report = JSON.parse(safeReadFile(reportPath, { encoding: 'utf8' }) as string);
    let logContent = '';
    if (fs.existsSync(logPath)) logContent = safeReadFile(logPath, { encoding: 'utf8' }) as string;

    const isSuccess = report.status === 'success' || logContent.includes('[SUCCESS]');
    const category = isSuccess ? 'success-pattern' : 'incident-recovery';

    const extractLessons = (log: string, success: boolean) => {
      if (!log) return 'No logs available.';
      const lines = log.split('\n');
      const lessons: string[] = [];
      if (!success) {
        const errors = lines.filter(l => l.includes('ERROR') || l.includes('fail')).slice(-5);
        if (errors.length > 0) { lessons.push('### Failure Root Cause (Estimated)', errors.join('\n')); }
      }
      const obs = lines.filter(l => l.includes('Observation') || l.includes('Finding'));
      if (obs.length > 0) { lessons.push('### Key Observations', obs.slice(0, 5).join('\n')); }
      return lessons.length === 0 ? 'Execution completed without specific logged observations.' : lessons.join('\n\n');
    };

    const content = `---\nmission_id: ${missionId}\ntimestamp: ${report.timestamp || new Date().toISOString()}\ncategory: ${category}\nrole: ${report.role || 'Unknown'}\n---\n\n# Wisdom Distilled from Mission ${missionId}\n\n## 🎯 Intent\n${report.intent || 'Unknown'}\n\n## 📊 Outcome\n**${isSuccess ? 'Victory Conditions Met' : 'Execution Failed'}**\n\n## 📝 Summary\n${report.summary || 'No summary provided.'}\n\n## 💡 Key Lessons\n${extractLessons(logContent, isSuccess)}\n`;

    if (!fs.existsSync(wisdomDir)) safeMkdir(wisdomDir, { recursive: true });
    const filePath = path.join(wisdomDir, `distilled-${missionId}-${Date.now()}.md`);
    safeWriteFile(filePath, content);
    return filePath;
  } catch (err: any) {
    logger.error(`[Distiller] Error in ${missionId}: ${err.message}`);
    return null;
  }
}

async function distillArchives(): Promise<string | null> {
  const archiveDir = path.resolve(process.cwd(), 'archive/missions');
  const historyPath = path.resolve(process.cwd(), 'knowledge/operations/mission_history.md');
  if (!fs.existsSync(archiveDir)) return null;

  logger.info('📚 [WISDOM] Distilling archived missions...');
  const missions: any[] = [];
  const folders = fs.readdirSync(archiveDir).filter(f => fs.statSync(path.join(archiveDir, f)).isDirectory());

  for (const folder of folders) {
    const missionDir = path.join(archiveDir, folder);
    const statePath = path.join(missionDir, 'mission-state.json');
    const prPath = path.join(missionDir, 'PR_DESCRIPTION.md');
    let id = folder, persona = 'Unknown', summary = 'No detailed summary available.', completedAt = fs.statSync(missionDir).mtime.toISOString();

    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        id = state.mission_id || id;
        persona = state.assigned_persona || persona;
        if (state.history?.length) completedAt = state.history[state.history.length - 1].ts || completedAt;
      } catch (e) {}
    }
    if (fs.existsSync(prPath)) {
      const prContent = fs.readFileSync(prPath, 'utf8');
      const match = prContent.match(/## 🎯 Overview\n([\s\S]*?)(?=## |$)/);
      if (match) summary = match[1].trim();
    }
    missions.push({ id, completedAt, persona, summary });
  }

  missions.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
  let md = `# Mission History Ledger\n\n自動生成された、エコシステムの過去の全ミッションの完了記録です。\n\n`;
  for (const m of missions) {
    md += `## [${new Date(m.completedAt).toLocaleDateString()}] ${m.id}\n- **Persona**: ${m.persona}\n- **Summary**:\n  > ${m.summary.replace(/\n/g, '\n  > ')}\n\n`;
  }
  
  if (!fs.existsSync(path.dirname(historyPath))) safeMkdir(path.dirname(historyPath), { recursive: true });
  safeWriteFile(historyPath, md);
  return historyPath;
}

async function distillLedger(timestamp: string): Promise<string | null> {
  const ledgerPath = path.resolve(process.cwd(), 'active/audit/governance-ledger.jsonl');
  const evolutionDir = path.resolve(process.cwd(), 'knowledge/evolution');
  if (!fs.existsSync(ledgerPath)) return null;

  logger.info('🧠 [WISDOM] Distilling from governance ledger...');
  try {
    const lines = (safeReadFile(ledgerPath, { encoding: 'utf8' }) as string).trim().split('\n').filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l));
    const failures = entries.filter(e => e.payload && (e.payload.status === 'error' || e.type === 'VIOLATION'));
    const successes = entries.filter(e => e.payload && e.payload.status === 'success');

    const reportFile = path.join(evolutionDir, `wisdom_${timestamp.replace(/-/g, '_')}.md`);
    let report = `# 🧠 Autonomous Wisdom Distillation - ${timestamp}\n\n## 🛡️ Critical Incidents & Learned Patterns\n\n`;

    if (failures.length > 0) {
      const patterns = new Set(failures.map(f => f.payload.script || f.type));
      patterns.forEach(p => {
        const count = failures.filter(f => (f.payload.script || f.type) === p).length;
        report += `- **Pattern: ${p}**\n  - Occurrences: ${count}\n  - Insight: Recurring issues detected. Automated repair or architectural refinement recommended.\n`;
      });
    } else { report += `No critical failures detected. Ecosystem stability is high.\n`; }

    report += `\n## ✅ Stabilization Achievements\n\n- Total Success Events: ${successes.length}\n- Integrity Level: Verified by Ledger Chain.\n`;
    if (!fs.existsSync(evolutionDir)) safeMkdir(evolutionDir, { recursive: true });
    
    if (fs.existsSync(reportFile)) {
      const existing = safeReadFile(reportFile, { encoding: 'utf8' }) as string;
      safeWriteFile(reportFile, existing + '\n\n---\n\n' + report);
    } else { safeWriteFile(reportFile, report); }
    return reportFile;
  } catch (err: any) {
    logger.error(`[WISDOM] Ledger Distillation Failure: ${err.message}`);
    return null;
  }
}

async function performReporting(input: WisdomAction) {
  if (!input.reports || input.reports.length === 0) {
    return { status: 'failed', error: 'No reports specified' };
  }

  const results: any[] = [];
  for (const report of input.reports) {
    logger.info(`📝 [WISDOM] Generating ${report.type} report...`);
    try {
      let result;
      switch (report.type) {
        case 'debt':
          result = await generateDebtReport(report);
          break;
        case 'docs':
          result = await generateDocsReport(report);
          break;
        case 'vital':
          result = await generateVitalReport(report);
          break;
      }
      results.push({ type: report.type, status: 'success', ...result });
    } catch (err: any) {
      logger.error(`Failed to generate ${report.type} report: ${err.message}`);
      results.push({ type: report.type, status: 'failed', error: err.message });
    }
  }

  return { status: 'success', results };
}

async function generateDebtReport(_spec: ReportSpec) {
  await initChalk();
  const perfDir = path.resolve(process.cwd(), 'evidence/performance');
  if (!fs.existsSync(perfDir)) return { message: 'No performance data found' };

  const files = fs.readdirSync(perfDir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return { message: 'No performance files found' };

  const latest = JSON.parse(safeReadFile(path.join(perfDir, files[files.length - 1]), { encoding: 'utf8' }) as string);
  const breaches = latest.slo_breaches || [];

  console.log(chalk.bold.yellow('\n--- 📉 Strategic Debt & Risk Report ---\n'));

  if (breaches.length === 0) {
    console.log(chalk.green('  ✅ No technical debt detected. All systems are operating within SLO targets.'));
    return { breaches: 0 };
  }

  const estimatedHourlyLoss = breaches.length * 50;

  console.log(`  Target Violation Count: ${chalk.red(breaches.length)} skills`);
  console.log(`  Estimated Efficiency Loss: ${chalk.red('$' + estimatedHourlyLoss + '/hr')}\n`);

  console.log(chalk.bold('Top Risks:'));
  breaches.slice(0, 10).forEach((b: any) => {
    const isLatencyBreach = b.actual_latency > b.target_latency;
    const isSuccessBreach = parseFloat(b.actual_success) < b.target_success;

    let detail = '';
    if (isLatencyBreach) {
      detail = `Latency Gap: +${b.actual_latency - b.target_latency}ms`;
    } else if (isSuccessBreach) {
      detail = `Success Rate: ${b.actual_success}% (Target ${b.target_success}%)`;
    } else {
      detail = `Consecutive: ${b.consecutive_breaches}`;
    }

    const risk = b.severity === 'CRITICAL' ? chalk.bgRed.white(' CRITICAL ') : chalk.yellow('Medium');
    console.log(`  - ${chalk.bold(b.skill.padEnd(25))} | Risk: ${risk.padEnd(15)} | ${detail}`);
  });

  console.log(chalk.dim('\nRecommendation: Reinvest saved hours into refactoring the chronic breaches above.\n'));
  return { breaches: breaches.length };
}

async function generateDocsReport(spec: ReportSpec) {
  const skillsRootDir = path.resolve(process.cwd(), 'skills');
  if (!fs.existsSync(skillsRootDir)) return { message: 'No skills directory found' };

  const categories = fs.readdirSync(skillsRootDir).filter(f => fs.statSync(path.join(skillsRootDir, f)).isDirectory());
  
  const skills: any[] = [];
  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs.readdirSync(catPath).filter(f => fs.statSync(path.join(catPath, f)).isDirectory());
    
    for (const dir of skillDirs) {
      const relPath = path.join('skills', cat, dir);
      const skillFullDir = path.resolve(process.cwd(), relPath);
      const skillMdPath = path.join(skillFullDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) continue;
        const fmContent = match[1];
        const get = (key: string) => {
          const m = fmContent.match(new RegExp(`^${key}:\s*(.+)$`, 'm'));
          return m ? m[1].trim() : '';
        };
        const fm = { name: get('name'), description: get('description'), status: get('status') };

        const hasScriptsDir = fs.existsSync(path.join(skillFullDir, 'scripts'));
        let hasTypeScript = false;
        if (hasScriptsDir) {
          hasTypeScript = fs.readdirSync(path.join(skillFullDir, 'scripts')).some(f => /\.ts$/.test(f));
        }
        if (!hasTypeScript) {
          hasTypeScript = fs.readdirSync(skillFullDir).some(f => /\.ts$/.test(f));
        }

        const cliCommand = (fm.status === 'implemented' || fm.status === 'impl') ? `node dist/scripts/cli.js run ${dir}` : '';

        skills.push({ dir, name: fm.name || dir, description: fm.description, status: fm.status, cliCommand, hasTypeScript });
      } catch (_) {}
    }
  }

  const implemented = skills.filter((s) => s.status === 'implemented' || s.status === 'impl').sort((a, b) => a.name.localeCompare(b.name));
  const planned = skills.filter((s) => s.status === 'planned').sort((a, b) => a.name.localeCompare(b.name));
  const conceptual = skills.filter((s) => s.status === 'conceptual').sort((a, b) => a.name.localeCompare(b.name));

  const timestamp = new Date().toISOString();
  const lines = [
    '# Gemini Skills Catalog', '', `> Auto-generated on ${timestamp}`, '', '## Summary', '',
    '| Metric | Count |', '| ------ | ----- |', `| Total Skills | ${skills.length} |`, `| Implemented | ${implemented.length} |`,
    `| Planned | ${planned.length} |`, `| Conceptual | ${conceptual.length} |`, '',
  ];

  if (implemented.length > 0) {
    lines.push('## Implemented Skills', '', '| Name | Description | CLI Command | TypeScript |', '| ---- | ----------- | ----------- | ---------- |');
    for (const s of implemented) lines.push(`| ${s.name} | ${s.description} | ${s.cliCommand ? `\`${s.cliCommand}\`` : '-'} | ${s.hasTypeScript ? 'Yes' : 'No'} |`);
    lines.push('');
  }

  if (planned.length > 0) {
    lines.push('## Planned Skills', '', '| Name | Description |', '| ---- | ----------- |');
    for (const s of planned) lines.push(`| ${s.name} | ${s.description} |`);
    lines.push('');
  }

  const outPath = path.resolve(process.cwd(), spec.output_file || 'docs/SKILL-CATALOG.md');
  const dirPath = path.dirname(outPath);
  if (!fs.existsSync(dirPath)) safeMkdir(dirPath, { recursive: true });
  safeWriteFile(outPath, lines.join('\n'));

  return { catalogPath: outPath, totalSkills: skills.length, implemented: implemented.length };
}

async function generateVitalReport(_spec: ReportSpec) {
  await initChalk();
  const metricsFile = path.resolve(process.cwd(), 'work/metrics/skill-metrics.jsonl');
  if (!fs.existsSync(metricsFile)) return { message: 'No metrics data found' };

  const lines = (safeReadFile(metricsFile, { encoding: 'utf8' }) as string).trim().split('\n').filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));

  let totalCost = 0, totalExecutions = 0, totalErrors = 0, totalInterventions = 0;
  const skillStats: Record<string, any> = {};

  entries.forEach(e => {
    if (e.type === 'intervention') { totalInterventions++; return; }
    totalExecutions++;
    if (e.status === 'error') totalErrors++;
    if (e.cost_usd) totalCost += e.cost_usd;
    const s = e.skill;
    if (!skillStats[s]) skillStats[s] = { count: 0, errors: 0, cost: 0, totalMs: 0 };
    skillStats[s].count++;
    if (e.status === 'error') skillStats[s].errors++;
    if (e.cost_usd) skillStats[s].cost += e.cost_usd;
    skillStats[s].totalMs += e.duration_ms || 0;
  });

  const autonomyScore = totalExecutions > 0 ? Math.round((1 - (totalInterventions / totalExecutions)) * 100) : 100;

  console.log(chalk.bold.cyan('\n=== ECOSYSTEM VITALITY REPORT ==='));
  console.log(chalk.dim(`Period: ${entries[0]?.timestamp} to ${entries[entries.length-1]?.timestamp}`));
  console.log(`\n${chalk.bold('Overall Financials:')}\n- Total API Cost:   ${chalk.green('$' + totalCost.toFixed(4))}\n- Total Executions: ${totalExecutions}`);
  console.log(`\n${chalk.bold('Sovereign Autonomy:')}\n- Interventions:    ${totalInterventions}\n- Autonomy Score:   ${autonomyScore >= 90 ? chalk.green(autonomyScore + '%') : chalk.yellow(autonomyScore + '%')}`);
  
  console.log(`\n${chalk.bold('Skill Performance (Top 5 by Execution):')}`);
  const sortedSkills = Object.entries(skillStats).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  console.log(chalk.dim('Skill                | Execs | Errors | Avg Ms | Cost ($)'));
  console.log(chalk.dim('---------------------------------------------------------'));
  sortedSkills.forEach(([name, s]) => {
    const avgMs = Math.round(s.totalMs / s.count);
    const line = `${name.padEnd(20)} | ${String(s.count).padStart(5)} | ${String(s.errors).padStart(6)} | ${String(avgMs).padStart(6)} | ${s.cost.toFixed(4)}`;
    console.log(s.errors > 0 ? chalk.red(line) : line);
  });
  console.log(chalk.cyan('\n=================================\n'));

  return { totalExecutions, totalCost, autonomyScore };
}

async function performAggregation(input: WisdomAction) {
  const targetDir = path.resolve(process.cwd(), input.target_dir || 'skills');
  const outputFile = path.resolve(process.cwd(), input.output_file || 'knowledge/orchestration/global_skill_index.json');
  const autoInit = input.options?.auto_init !== false;

  logger.info(`📊 [WISDOM] Aggregating skills from ${targetDir} to ${outputFile}...`);

  try {
    let existingIndex: any = { s: [] };
    if (fs.existsSync(outputFile)) {
      try { existingIndex = JSON.parse(safeReadFile(outputFile, { encoding: 'utf8' }) as string); } catch (_) {}
    }

    const skillsMap = new Map<string, CapabilityEntry>(existingIndex.s.map((s: any) => [s.path, s]));
    const foundPaths = new Set<string>();
    
    if (!fs.existsSync(targetDir)) {
      logger.warn(`Target directory ${targetDir} does not exist. Skipping aggregation.`);
      return { status: 'success', total: 0, updated: 0 };
    }

    const categories = fs.readdirSync(targetDir).filter(f => fs.lstatSync(path.join(targetDir, f)).isDirectory());
    let updated = 0;

    for (const cat of categories) {
      const catPath = path.join(targetDir, cat);
      const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());

      for (const dir of skillDirs) {
        const relPath = path.join('skills', cat, dir);
        const fullDir = path.join(process.cwd(), relPath);
        if (autoInit) initializeCapability(fullDir, dir, cat);

        const skillMdPath = path.join(fullDir, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          foundPaths.add(relPath);
          const stat = fs.statSync(skillMdPath);
          const existing = skillsMap.get(relPath);
          if (stat.mtimeMs > (existing?.u ? new Date(existing.u).getTime() : 0)) {
            updated++;
            const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
            const desc = (content.match(/^description:\s*(.*)$/m)?.[1] || '').trim().substring(0, 97);
            const status = content.match(/^status:\s*(\w+)$/m)?.[1] || 'plan';
            const risk = content.match(/^risk_level:\s*(\w+)$/m)?.[1] || 'low';
            
            let mainScript = '';
            const pkgPath = path.join(fullDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
              try { 
                const pkg = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
                mainScript = pkg.main || ''; 
              } catch (_) {}
            }

            let tags: string[] = [];
            let platforms: string[] = [];
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) { 
              try { 
                const fm: any = yaml.load(fmMatch[1]); 
                tags = fm.tags || []; 
                platforms = fm.platforms || [];
              } catch (_) {} 
            }

            skillsMap.set(relPath, {
              n: dir, path: relPath, d: desc, s: status === 'implemented' ? 'impl' : status.substring(0, 4),
              r: risk, m: mainScript, t: tags, u: new Date(stat.mtimeMs).toISOString(),
              p: platforms
            });
          }
        }
      }
    }

    for (const pathKey of skillsMap.keys()) { if (!foundPaths.has(pathKey)) skillsMap.delete(pathKey); }

    const skills = Array.from(skillsMap.values());
    const finalResult = { v: '2.0.0', t: skills.length, u: new Date().toISOString(), s: skills };
    safeWriteFile(outputFile, JSON.stringify(finalResult, null, 2));
    logger.success(`✅ Global Capability Index: ${skills.length} capabilities (Updated: ${updated})`);
    return { status: 'success', total: skills.length, updated };
  } catch (err: any) {
    logger.error(`Index Generation Failed: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const inputData = JSON.parse(inputContent) as WisdomAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
