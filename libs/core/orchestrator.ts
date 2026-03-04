import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger } from './core.js';
import { metrics } from './metrics.js';

/**
 * Skill Pipeline Orchestrator - chains skills together with data passing.
 */

const rootDir = process.cwd();
const skillIndex = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

export function resolveSkillScript(skillName: string): string {
  const index = JSON.parse(fs.readFileSync(skillIndex, 'utf8'));
  const skills = index.s || index.skills;

  let skill;
  if (skillName.includes('/')) {
    skill = skills.find(
      (s: any) => (s.path || '').includes(skillName) || (s.n || s.name) === skillName
    );
  } else {
    skill = skills.find((s: any) => (s.n || s.name) === skillName);
  }

  if (!skill) throw new Error(`Skill "${skillName}" not found in index`);

  const skillRelPath = skill.path || skillName;
  const skillDir = path.join(rootDir, skillRelPath);

  const mainPath = skill.m || skill.main;
  if (mainPath) {
    const fullPath = path.join(skillDir, mainPath);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  const scriptsDir = path.join(skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir))
    throw new Error(`No scripts/ directory for "${skillName}" at ${skillDir}`);
  const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js)$/.test(f));
  if (scripts.length === 0) throw new Error(`No .cjs or .js scripts found for "${skillName}"`);
  return path.join(scriptsDir, scripts[0]);
}

function resolveParams(params: any, prevOutput: any) {
  const resolved: any = {};
  for (const [key, val] of Object.entries(params || {})) {
    if (typeof val === 'string' && val.startsWith('$prev.')) {
      const propPath = val.slice(6).split('.');
      let value = prevOutput;
      for (const prop of propPath) {
        value = value?.[prop];
      }
      resolved[key] = value;
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

function buildArgsList(params: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, val] of Object.entries(params || {})) {
    if (val === true) {
      args.push(`--${key}`);
    } else if (val !== false && val !== null && val !== undefined) {
      args.push(`--${key}`, String(val));
    }
  }
  return args;
}

/** Synchronous sleep without spawning a shell process. */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait — acceptable for short retry delays */
  }
}

export function runStep(script: string, params: Record<string, unknown>, step: any = {}) {
  const maxAttempts = (step.retries || 0) + 1;
  const initialDelay = step.retryDelay || 1000;
  const timeout = step.timeout || 60000;
  const skillDir = path.dirname(path.dirname(script));
  const args = buildArgsList(params);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync('node', [script, ...args], {
      encoding: 'utf8',
      cwd: skillDir,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status === 0 && !result.error) {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = { raw: result.stdout.trim() };
      }
      return { status: 'success', data: parsed, attempts: attempt, recovered: attempt > 1 };
    }

    // Parse structured error from stderr/stdout if available
    let parsedError: any = null;
    const errText = result.stdout || result.stderr || result.error?.message || '';
    try {
      parsedError = JSON.parse(errText);
    } catch {
      /* non-JSON output */
    }

    const isRetryable = parsedError?.error?.retryable || false;
    const shouldRetry = attempt < maxAttempts && (isRetryable || !parsedError);

    if (shouldRetry) {
      const delay = initialDelay * Math.pow(2, attempt - 1);
      logger.warn(
        `[Orchestrator] Step failed (retryable: ${isRetryable}). Retrying attempt ${attempt + 1}/${maxAttempts} after ${delay}ms...`
      );
      sleepSync(Math.min(delay, 30000));
      continue;
    }

    return {
      status: 'error',
      error: parsedError?.error?.message || result.error?.message || `exit ${result.status}`,
      attempts: attempt,
      recovered: false,
    };
  }
  return { status: 'error', error: 'Exhausted retries', attempts: maxAttempts, recovered: false };
}

export function runPipeline(steps: any[], initialData = {}) {
  const results = [];
  let prevOutput = initialData;
  const startTime = Date.now();

  for (const step of steps) {
    const script = resolveSkillScript(step.skill);
    const params = resolveParams(step.params, prevOutput);

    const result = runStep(script, params, step);
    results.push({ skill: step.skill, ...result });

    if (result.status === 'success') {
      prevOutput = (result as any).data?.data || (result as any).data;
      metrics.record(step.skill, (result as any).data?.metadata?.duration_ms || 0, 'success', {
        recovered: result.recovered,
      });
    } else if (!step.continueOnError) {
      break;
    }
  }

  return {
    pipeline: true,
    totalSteps: steps.length,
    completedSteps: results.length,
    duration_ms: Date.now() - startTime,
    steps: results,
  };
}

export function runParallel(steps: any[]): Promise<any> {
  const startTime = Date.now();

  const promises = steps.map((step) => {
    const script = resolveSkillScript(step.skill);
    const args = buildArgsList(step.params || {});
    const timeout = step.timeout || 60000;
    const skillDir = path.dirname(path.dirname(script));

    return new Promise((resolve) => {
      const proc = spawn('node', [script, ...args], {
        encoding: 'utf8',
        cwd: skillDir,
        timeout,
      } as any);

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code: number) => {
        if (code !== 0) {
          resolve({
            skill: step.skill,
            status: 'error',
            error: stderr.trim() || `exit ${code}`,
            attempts: 1,
          });
        } else {
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = { raw: stdout.trim() };
          }
          resolve({ skill: step.skill, status: 'success', data: parsed, attempts: 1 });
        }
      });

      proc.on('error', (err: Error) => {
        resolve({ skill: step.skill, status: 'error', error: err.message, attempts: 1 });
      });
    });
  });

  return Promise.all(promises).then((results) => ({
    pipeline: true,
    parallel: true,
    totalSteps: steps.length,
    completedSteps: results.filter((r: any) => r.status === 'success').length,
    duration_ms: Date.now() - startTime,
    steps: results,
  }));
}

export function loadPipeline(yamlPath: string) {
  const content = fs.readFileSync(path.resolve(yamlPath), 'utf8');
  const def: any = yaml.load(content);

  if (!def.pipeline || !Array.isArray(def.pipeline)) {
    throw new Error('Invalid pipeline YAML: must have a "pipeline" array');
  }

  return {
    name: def.name || path.basename(yamlPath, '.yml'),
    steps: def.pipeline,
    run: (initialData: any) => runPipeline(def.pipeline, initialData),
  };
}
