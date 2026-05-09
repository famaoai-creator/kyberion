import { execSync, exec, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger } from './core.js';
import { metrics } from './metrics.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { loadActuatorManifestCatalog } from './src/actuator-manifest-index.js';

/**
 * Actuator Pipeline Orchestrator - chains actuator steps together with data passing.
 */

const rootDir = pathResolver.rootDir();
export function resolveCapabilityScript(capabilityName: string): string {
  const capabilities = loadActuatorManifestCatalog();

  let capability;
  if (capabilityName.includes('/')) {
    capability = capabilities.find((s) => (s.path || '').includes(capabilityName) || s.n === capabilityName);
  } else {
    capability = capabilities.find((s) => s.n === capabilityName);
  }

  if (!capability) throw new Error(`Capability "${capabilityName}" not found in index`);

  const capabilityRelPath = capability.path || capabilityName;
  const capabilityDir = path.join(rootDir, capabilityRelPath);

  const mainPath = capability.entrypoint;
  if (mainPath) {
    const fullPath = path.join(capabilityDir, mainPath);
    if (safeExistsSync(fullPath)) return fullPath;
  }

  const scriptsDir = path.join(capabilityDir, 'scripts');
  if (!safeExistsSync(scriptsDir))
    throw new Error(`No scripts/ directory for "${capabilityName}" at ${capabilityDir}`);
  const scripts = safeReaddir(scriptsDir).filter((f) => /\.(cjs|js)$/.test(f));
  if (scripts.length === 0) throw new Error(`No .cjs or .js scripts found for "${capabilityName}"`);
  return path.join(scriptsDir, scripts[0]);
}

export const resolveSkillScript = resolveCapabilityScript;

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

function buildArgs(params: any) {
  const args: string[] = [];
  for (const [key, val] of Object.entries(params || {})) {
    if (val === true) args.push(`--${key}`);
    else if (val !== false && val !== null && val !== undefined)
      args.push(`--${key}`, `"${String(val)}"`);
  }
  return args.join(' ');
}

export function runStep(script: string, args: string, step: any = {}) {
  const maxAttempts = (step.retries || 0) + 1;
  const initialDelay = step.retryDelay || 1000;
  const timeout = step.timeout || 60000;
  const capabilityDir = path.dirname(path.dirname(script));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = execSync(`node "${script}" ${args}`, {
        encoding: 'utf8',
        cwd: capabilityDir,
        timeout,
        stdio: 'pipe',
      });

      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        parsed = { raw: output.trim() };
      }

      return { status: 'success', data: parsed, attempts: attempt, recovered: attempt > 1 };
    } catch (err: any) {
      let parsedError;
      try {
        parsedError = JSON.parse(err.stdout || err.message);
      } catch {
        parsedError = null;
      }

      const isRetryable = parsedError?.error?.retryable || false;
      const shouldRetry = attempt < maxAttempts && (isRetryable || !parsedError);

      if (shouldRetry) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        logger.warn(
          `[Orchestrator] Step failed (retryable: ${isRetryable}). Retrying attempt ${attempt + 1}/${maxAttempts} after ${delay}ms...`
        );

        const delaySec = Math.ceil(delay / 1000);
        spawnSync('sleep', [String(delaySec)], { stdio: 'ignore' });
        continue;
      }

      return {
        status: 'error',
        error: parsedError?.error?.message || err.message,
        attempts: attempt,
        recovered: false,
      };
    }
  }
  return { status: 'error', error: 'Exhausted retries', attempts: maxAttempts, recovered: false };
}

export function runPipeline(steps: any[], initialData = {}) {
  const results = [];
  let prevOutput = initialData;
  const startTime = Date.now();

  for (const step of steps) {
    const script = resolveCapabilityScript(step.skill);
    const params = resolveParams(step.params, prevOutput);
    const args = buildArgs(params);

    const result = runStep(script, args, step);
    results.push({ skill: step.skill, ...result });

    if (result.status === 'success') {
      prevOutput = result.data?.data || result.data;
      metrics.record(step.skill, result.data?.metadata?.duration_ms || 0, 'success', {
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
    const script = resolveCapabilityScript(step.skill);
    const args = buildArgs(step.params);
    const timeout = step.timeout || 60000;
    const capabilityDir = path.dirname(path.dirname(script));

    return new Promise((resolve) => {
      exec(
        `node "${script}" ${args}`,
        {
          encoding: 'utf8',
          cwd: capabilityDir,
          timeout,
          maxBuffer: 5 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err) {
            resolve({ skill: step.skill, status: 'error', error: err.message, attempts: 1 });
          } else {
            let parsed;
            try {
              parsed = JSON.parse(stdout!);
            } catch {
              parsed = { raw: stdout!.trim() };
            }
            resolve({ skill: step.skill, status: 'success', data: parsed, attempts: 1 });
          }
        }
      );
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
  const content = safeReadFile(path.resolve(yamlPath), { encoding: 'utf8' }) as string;
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
