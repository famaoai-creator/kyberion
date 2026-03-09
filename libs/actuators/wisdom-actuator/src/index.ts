import { logger, pathResolver, safeReadFile, safeWriteFile, safeReaddir, safeStat, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
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
 * Wisdom-Actuator v1.4.0 [RECONCILE EVOLVED]
 * Strictly compliant with Layer 2 (Shield).
 * Unified interface for knowledge synchronization and ecosystem integrity.
 */

const VAULT_DIR = path.join(process.cwd(), 'knowledge/evolution/latent-wisdom');

interface ReportSpec {
  type: 'debt' | 'docs' | 'vital';
  output_file?: string;
  options?: any;
}

interface WisdomAction {
  action: 'distill' | 'mirror' | 'swap' | 'sync' | 'aggregate' | 'report' | 'sync_docs' | 'sync_skill_dates' | 'scan_pii' | 'git_summary' | 'cloud_cost' | 'suggest_skill' | 'reconcile';
  patchId?: string;
  missionId?: string;
  targetTier?: 'public' | 'confidential' | 'personal';
  target_dir?: string;
  output_file?: string;
  reports?: ReportSpec[];
  options?: any;
  mode?: 'mission' | 'archive' | 'ledger' | 'all';
  targets?: string[];
  strategy_path?: string;
}

interface CapabilityEntry {
  n: string; path: string; d: string; s: string; r: string; m: string; t: string[]; u: string; p?: string[];
}

interface ReconcileStrategy {
  id: string;
  type: 'bidirectional-mapping' | 'git-provenance' | 'template-injection';
  params: any;
}

async function handleAction(input: WisdomAction) {
  switch (input.action) {
    case 'reconcile':
      return await performReconcile(input);

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

    case 'git_summary':
      return await performGitSummary();

    case 'cloud_cost':
      return await performCloudCost(input);

    case 'suggest_skill':
      return await performSuggestSkill(input);

    default:
      return { status: 'executed' };
  }
}

async function performReconcile(input: WisdomAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/wisdom-reconcile-strategy.json');
  if (!fs.existsSync(strategyPath)) throw new Error(`Strategy ADF not found at ${strategyPath}`);

  const { strategies } = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string) as { strategies: ReconcileStrategy[] };
  const results: any[] = [];

  logger.info(`🧘 [WISDOM] Starting Ecosystem Reconciliation (${strategies.length} strategies)...`);

  for (const strategy of strategies) {
    logger.info(`  ↳ Executing Strategy: ${strategy.id} (${strategy.type})`);
    try {
      let result;
      switch (strategy.type) {
        case 'git-provenance':
          result = await reconcileGitProvenance(strategy.params);
          break;
        case 'bidirectional-mapping':
          result = await reconcileMapping(strategy.params);
          break;
        case 'template-injection':
          result = await reconcileTemplateInjection(strategy.params);
          break;
        default:
          logger.warn(`Unknown strategy type: ${strategy.type}`);
          result = { status: 'skipped' };
      }
      results.push({ id: strategy.id, ...result });
    } catch (err: any) {
      logger.error(`Strategy ${strategy.id} failed: ${err.message}`);
      results.push({ id: strategy.id, status: 'failed', error: err.message });
    }
  }

  return { status: 'reconciled', results };
}

async function reconcileGitProvenance(params: any) {
  const { scope, field } = params;
  const rootDir = process.cwd();
  
  const allFiles = getAllFiles(rootDir);
  const targetFiles = allFiles.filter(f => {
    const rel = path.relative(rootDir, f);
    if (scope.includes('**')) {
      const [dir, name] = scope.split('/**/');
      return rel.startsWith(dir) && rel.endsWith(name);
    }
    return rel === scope;
  });

  let updatedCount = 0;
  for (const file of targetFiles) {
    let gitDate;
    try {
      gitDate = execSync(`git log -1 --format=%cs -- "${file}"`, { encoding: 'utf8' }).trim();
    } catch (_) { continue; }
    if (!gitDate) continue;

    const content = safeReadFile(file, { encoding: 'utf8' }) as string;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!fmMatch) continue;

    const fm = yaml.load(fmMatch[1]) as any;
    if (fm[field] !== gitDate) {
      fm[field] = gitDate;
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
      safeWriteFile(file, newContent);
      updatedCount++;
    }
  }
  return { status: 'success', updated: updatedCount };
}

async function reconcileMapping(params: any) {
  const { source: sourceScope, mapping } = params;
  const rootDir = process.cwd();
  const allFiles = getAllFiles(rootDir);
  
  const sources = allFiles.filter(f => {
    const rel = path.relative(rootDir, f);
    if (sourceScope.includes('**')) {
      const [dir, name] = sourceScope.split('/**/');
      return rel.startsWith(dir) && rel.endsWith(name);
    }
    return rel === sourceScope;
  });

  let updatedCount = 0;
  for (const sourcePath of sources) {
    const skillDir = path.dirname(sourcePath);
    const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!fmMatch) continue;
    const fm = yaml.load(fmMatch[1]) as any;

    for (const rule of mapping) {
      const [targetFile, targetField] = rule.to.split(':');
      const targetPath = path.join(skillDir, targetFile);
      if (!fs.existsSync(targetPath)) continue;

      const val = fm[rule.from];
      if (val === undefined) continue;

      const targetContent = safeReadFile(targetPath, { encoding: 'utf8' }) as string;
      
      if (targetFile === 'package.json') {
        const pkg = JSON.parse(targetContent);
        const finalVal = rule.prefix ? `${rule.prefix}${val}` : val;
        if (pkg[targetField] !== finalVal) {
          pkg[targetField] = finalVal;
          safeWriteFile(targetPath, JSON.stringify(pkg, null, 2) + '\n');
          updatedCount++;
        }
      }
    }
  }
  return { status: 'success', updated: updatedCount };
}

async function reconcileTemplateInjection(params: any) {
  const { source: sourceFile, targets } = params;
  const rootDir = process.cwd();
  const sourcePath = path.resolve(rootDir, sourceFile);
  if (!fs.existsSync(sourcePath)) return { status: 'skipped', reason: 'Source index not found' };

  const index = JSON.parse(safeReadFile(sourcePath, { encoding: 'utf8' }) as string);
  const implCount = (index.s || []).filter((s: any) => s.s === 'impl').length;
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');

  let updatedCount = 0;
  for (const target of targets) {
    const targetPath = path.resolve(rootDir, target.file);
    if (!fs.existsSync(targetPath)) continue;

    let content = safeReadFile(targetPath, { encoding: 'utf8' }) as string;
    const original = content;

    for (const rule of target.rules) {
      const regex = new RegExp(rule.pattern, 'g');
      const replacement = rule.template
        .replace('{{impl_count}}', String(implCount))
        .replace('{{today}}', today);
      content = content.replace(regex, replacement);
    }

    if (content !== original) {
      safeWriteFile(targetPath, content);
      updatedCount++;
    }
  }
  return { status: 'success', updated: updatedCount };
}

async function performSyncDocs() {
  const rootDir = process.cwd();
  const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
  const readmePath = path.join(rootDir, 'README.md');
  const guidePath = path.join(rootDir, 'SKILLS_GUIDE.md');

  if (!fs.existsSync(indexPath)) return { status: 'failed', error: 'Index not found' };

  try {
    const indexRaw = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    const index = JSON.parse(indexRaw);
    const skills = index.s || [];
    const implemented = skills.filter((s: any) => s.s === 'impl').length;

    if (fs.existsSync(readmePath)) {
      let readme = safeReadFile(readmePath, { encoding: 'utf8' }) as string;
      readme = readme.replace(/\*\*(\d+) skills\*\* \(all implemented\)/, `**${implemented} skills** (all implemented)`);
      readme = readme.replace(/Implemented Skills \((\d+)\)/, `Implemented Skills (${implemented})`);
      safeWriteFile(readmePath, readme);
    }

    if (fs.existsSync(guidePath)) {
      let guide = safeReadFile(guidePath, { encoding: 'utf8' }) as string;
      guide = guide.replace(/Total Skills: (\d+)/, `Total Skills: ${implemented}`);
      guide = guide.replace(/Last updated: \d{4}\/\d{1,2}\/\d{1,2}/, `Last updated: ${new Date().toISOString().split('T')[0].replace(/-/g, '/')}`);
      safeWriteFile(guidePath, guide);
    }
    return { status: 'success', implemented };
  } catch (err: any) { return { status: 'failed', error: err.message }; }
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
  let updatedCount = 0;
  for (const skillObj of skills) {
    const skillMdPath = path.join(rootDir, skillObj.path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    let gitDate;
    try { gitDate = execSync(`git log -1 --format=%cs -- "${skillMdPath}"`, { encoding: 'utf8' }).trim(); } catch (_) { gitDate = new Date().toISOString().split('T')[0]; }
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
        updatedCount++;
      }
    } catch (err: any) { logger.error(`Failed to sync date for ${skillObj.name}: ${err.message}`); }
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
  function walkFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (p.startsWith(personalDir)) continue;
      if (entry.isDirectory()) { walkFiles(p); } 
      else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        const content = fs.readFileSync(p, 'utf8');
        FORBIDDEN_PATTERNS.forEach((pattern) => { if (pattern.regex.test(content)) violations.push({ file: path.relative(rootDir, p), type: pattern.name }); });
      }
    }
  }
  walkFiles(knowledgeDir);
  if (violations.length > 0) return { status: 'violation', violations };
  return { status: 'success' };
}

async function performDistillation(input: WisdomAction) {
  const mode = input.mode || 'all';
  const results: any[] = [];
  const timestamp = new Date().toISOString().split('T')[0];
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
    const content = `---\nmission_id: ${missionId}\ntimestamp: ${report.timestamp || new Date().toISOString()}\ncategory: ${category}\nrole: ${report.role || 'Unknown'}\n---\n\n# Wisdom Distilled from Mission ${missionId}\n\n## Summary\n${report.summary || 'No summary.'}\n`;
    if (!fs.existsSync(wisdomDir)) safeMkdir(wisdomDir, { recursive: true });
    const filePath = path.join(wisdomDir, `distilled-${missionId}-${Date.now()}.md`);
    safeWriteFile(filePath, content);
    return filePath;
  } catch (err: any) { return null; }
}

async function distillArchives(): Promise<string | null> {
  const archiveDir = path.resolve(process.cwd(), 'archive/missions');
  const historyPath = path.resolve(process.cwd(), 'knowledge/operations/mission_history.md');
  if (!fs.existsSync(archiveDir)) return null;
  const missions: any[] = [];
  const folders = fs.readdirSync(archiveDir).filter(f => fs.statSync(path.join(archiveDir, f)).isDirectory());
  for (const folder of folders) {
    const missionDir = path.join(archiveDir, folder);
    const statePath = path.join(missionDir, 'mission-state.json');
    let id = folder, persona = 'Unknown', completedAt = fs.statSync(missionDir).mtime.toISOString();
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        id = state.mission_id || id;
        persona = state.assigned_persona || persona;
      } catch (e) {}
    }
    missions.push({ id, completedAt, persona });
  }
  let md = `# Mission History Ledger\n\n`;
  for (const m of missions) md += `## [${m.completedAt}] ${m.id} (${m.persona})\n`;
  if (!fs.existsSync(path.dirname(historyPath))) safeMkdir(path.dirname(historyPath), { recursive: true });
  safeWriteFile(historyPath, md);
  return historyPath;
}

async function distillLedger(timestamp: string): Promise<string | null> {
  const ledgerPath = path.resolve(process.cwd(), 'active/audit/governance-ledger.jsonl');
  const evolutionDir = path.resolve(process.cwd(), 'knowledge/evolution');
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    const reportFile = path.join(evolutionDir, `wisdom_${timestamp.replace(/-/g, '_')}.md`);
    safeWriteFile(reportFile, `# Ledger Distillation ${timestamp}`);
    return reportFile;
  } catch (err: any) { return null; }
}

async function performReporting(input: WisdomAction) {
  if (!input.reports || input.reports.length === 0) return { status: 'failed', error: 'No reports' };
  const results: any[] = [];
  for (const report of input.reports) {
    try {
      let result = { status: 'success' };
      if (report.type === 'docs') result = await generateDocsReport(report) as any;
      results.push({ type: report.type, ...result });
    } catch (err: any) { results.push({ type: report.type, status: 'failed', error: err.message }); }
  }
  return { status: 'success', results };
}

async function generateDocsReport(spec: ReportSpec) {
  const outPath = path.resolve(process.cwd(), spec.output_file || 'docs/SKILL-CATALOG.md');
  safeWriteFile(outPath, '# Skill Catalog');
  return { catalogPath: outPath };
}

async function performAggregation(input: WisdomAction) {
  const targetDir = path.resolve(process.cwd(), input.target_dir || 'skills');
  const outputFile = path.resolve(process.cwd(), input.output_file || 'knowledge/orchestration/global_skill_index.json');
  try {
    const finalResult = { v: '2.0.0', t: 0, u: new Date().toISOString(), s: [] };
    safeWriteFile(outputFile, JSON.stringify(finalResult, null, 2));
    return { status: 'success', total: 0, updated: 0 };
  } catch (err: any) { return { status: 'failed', error: err.message }; }
}

async function performGitSummary() {
  const summary = execSync('git log -n 5 --pretty=format:"%h - %s (%cr)"', { encoding: 'utf8' });
  return { status: 'success', summary: summary.split('\n') };
}

async function performCloudCost(input: WisdomAction) {
  return { status: 'success', total_monthly: 0 };
}

async function performSuggestSkill(input: WisdomAction) {
  return { status: 'success', suggestions: [] };
}

function initializeCapability(capabilityPath: string, name: string, category: string) {
  const skillMdPath = path.join(capabilityPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) safeWriteFile(skillMdPath, `---\nname: ${name}\n---`);
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

export { handleAction };
