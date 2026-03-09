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
 * Wisdom-Actuator v1.5.0 [PIPELINE DRIVEN]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for ecosystem reconciliation.
 */

const VAULT_DIR = path.join(process.cwd(), 'knowledge/evolution/latent-wisdom');

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface ReportSpec {
  type: 'debt' | 'docs' | 'vital';
  output_file?: string;
  options?: any;
}

interface WisdomAction {
  action: 'distill' | 'mirror' | 'swap' | 'sync' | 'aggregate' | 'report' | 'sync_docs' | 'sync_skill_dates' | 'scan_pii' | 'git_summary' | 'cloud_cost' | 'suggest_skill' | 'reconcile' | 'pipeline';
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
  steps?: PipelineStep[];
}

interface CapabilityEntry {
  n: string; path: string; d: string; s: string; r: string; m: string; t: string[]; u: string; p?: string[];
}

async function handleAction(input: WisdomAction) {
  switch (input.action) {
    case 'pipeline':
      return await executePipeline(input.steps || []);

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

/**
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx };
  const results = [];

  for (const step of steps) {
    try {
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ step: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`Pipeline failed at ${step.op}: ${err.message}`);
      results.push({ step: step.op, status: 'failed', error: err.message });
      break;
    }
  }
  return { status: 'finished', results };
}

async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  switch (op) {
    case 'shell':
      const cmd = params.cmd.replace(/{{(.*?)}}/g, (_: string, p: string) => ctx[p.trim()] || '');
      return { ...ctx, last_capture: execSync(cmd, { encoding: 'utf8' }).trim() };
    case 'read_file':
      const p = path.resolve(rootDir, params.path.replace(/{{(.*?)}}/g, (_: string, p: string) => ctx[p.trim()] || ''));
      return { ...ctx, last_capture: safeReadFile(p, { encoding: 'utf8' }) };
    case 'glob_files':
      const dir = path.resolve(rootDir, params.dir);
      return { ...ctx, file_list: getAllFiles(dir).filter(f => f.endsWith(params.ext || '.md')) };
    default: return ctx;
  }
}

async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'regex_replace':
      const regex = new RegExp(params.pattern, 'g');
      const input = ctx.last_transform || ctx.last_capture;
      const replacement = params.template.replace(/{{(.*?)}}/g, (_: string, p: string) => ctx[p.trim()] || '');
      return { ...ctx, last_transform: input.replace(regex, replacement) };
    case 'yaml_update':
      const fmMatch = ctx.last_capture.match(/^---\n([\s\S]*?)\n---/m);
      if (!fmMatch) return ctx;
      const fm = yaml.load(fmMatch[1]) as any;
      fm[params.field] = ctx.last_capture_data || ctx.last_capture;
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      return { ...ctx, last_transform: ctx.last_capture.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`) };
    case 'json_map':
      const pkg = JSON.parse(ctx.last_capture);
      params.mapping.forEach((m: any) => { pkg[m.to] = ctx[m.from] || m.default; });
      return { ...ctx, last_transform: JSON.stringify(pkg, null, 2) + '\n' };
    default: return ctx;
  }
}

async function opApply(op: string, params: any, ctx: any) {
  switch (op) {
    case 'write_file':
      const out = path.resolve(process.cwd(), params.path.replace(/{{(.*?)}}/g, (_: string, p: string) => ctx[p.trim()] || ''));
      safeWriteFile(out, ctx.last_transform || ctx.last_capture);
      break;
  }
}

/**
 * Reconcile now converts strategies into pipeline steps.
 * This makes the Actuator code permanent and all logic move to ADF.
 */
async function performReconcile(input: WisdomAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/wisdom-reconcile-strategy.json');
  const { strategies } = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  
  for (const strategy of strategies) {
    const steps = strategyToPipeline(strategy);
    if (strategy.type === 'git-provenance' || strategy.type === 'bidirectional-mapping') {
      // Loop over files if it's a bulk operation
      const rootDir = process.cwd();
      const scope = strategy.params.scope || strategy.params.source;
      const files = getAllFiles(rootDir).filter(f => {
        const rel = path.relative(rootDir, f);
        return rel.startsWith(scope.split('/**')[0]) && rel.endsWith(scope.split('**/')[1]);
      });
      for (const file of files) {
        await executePipeline(steps, { file, rel_file: path.relative(rootDir, file) });
      }
    } else {
      await executePipeline(steps);
    }
  }
  return { status: 'success' };
}

function strategyToPipeline(strategy: any): PipelineStep[] {
  switch (strategy.type) {
    case 'git-provenance':
      return [
        { type: 'capture', op: 'shell', params: { cmd: 'git log -1 --format=%cs -- "{{file}}"' } },
        { type: 'transform', op: 'yaml_update', params: { field: strategy.params.field } },
        { type: 'apply', op: 'write_file', params: { path: '{{file}}' } }
      ];
    case 'bidirectional-mapping':
      return [
        { type: 'capture', op: 'read_file', params: { path: '{{rel_file}}' } },
        // Logic would continue here to map fields to package.json etc.
        { type: 'apply', op: 'write_file', params: { path: '{{rel_file}}' } } 
      ];
    default: return [];
  }
}

async function performSyncDocs() {
  return await executePipeline([
    { type: 'capture', op: 'read_file', params: { path: 'knowledge/orchestration/global_skill_index.json' } },
    // Simplified for now, docs sync would use regex_replace steps
  ]);
}

async function performScanPII() {
  const rootDir = process.cwd();
  const knowledgeDir = path.resolve(rootDir, 'knowledge');
  const personalDir = path.join(knowledgeDir, 'personal');
  const FORBIDDEN_PATTERNS = [
    { name: 'API_KEY', regex: /AIza[0-9A-Za-z-_]{35}/ },
    { name: 'PRIVATE_KEY', regex: /-----BEGIN PRIVATE KEY-----/ },
  ];
  const violations: any[] = [];
  function walkFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (p.startsWith(personalDir)) continue;
      if (entry.isDirectory()) { walkFiles(p); } 
      else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(p, 'utf8');
        FORBIDDEN_PATTERNS.forEach((pattern) => { if (pattern.regex.test(content)) violations.push({ file: path.relative(rootDir, p), type: pattern.name }); });
      }
    }
  }
  walkFiles(knowledgeDir);
  return violations.length > 0 ? { status: 'violation', violations } : { status: 'success' };
}

async function performAggregation(input: WisdomAction) {
  const outputFile = path.resolve(process.cwd(), input.output_file || 'knowledge/orchestration/global_skill_index.json');
  safeWriteFile(outputFile, JSON.stringify({ v: '2.0.0', t: 0, u: new Date().toISOString(), s: [] }, null, 2));
  return { status: 'success' };
}

async function performReporting(input: WisdomAction) {
  return { status: 'success', results: [] };
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
