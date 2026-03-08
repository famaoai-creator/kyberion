import { logger, pathResolver, safeReadFile, safeWriteFile, safeReaddir, safeStat, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
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
  action: 'distill' | 'mirror' | 'swap' | 'sync' | 'aggregate' | 'report';
  patchId?: string;
  missionId?: string;
  targetTier?: 'public' | 'confidential' | 'personal';
  target_dir?: string; // for 'aggregate' action
  output_file?: string; // for 'aggregate' action
  reports?: ReportSpec[]; // for 'report' action
  options?: any;
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
      logger.info(`🧠 [WISDOM] Distilling from: ${input.missionId}`);
      return { status: 'success', patchId: `patch-${input.missionId}-${Date.now()}` };

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

    default:
      return { status: 'executed' };
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
