const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Skill Pipeline Orchestrator - chains skills together with data passing.
 *
 * Usage:
 *   const { runPipeline, loadPipeline } = require('../../scripts/lib/orchestrator.cjs');
 *
 *   // Programmatic pipeline
 *   const result = runPipeline([
 *     { skill: 'codebase-mapper', params: { dir: '.' } },
 *     { skill: 'security-scanner', params: { input: '$prev.output' } },
 *   ]);
 *
 *   // YAML pipeline
 *   const result = loadPipeline('pipelines/security-audit.yml').run();
 *
 * @module orchestrator
 */

const rootDir = path.resolve(__dirname, '../..');
const skillIndex = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

function resolveSkillScript(skillName) {
  // load the global skill index
  const index = JSON.parse(fs.readFileSync(skillIndex, 'utf8'));
  const skill = index.skills.find(s => s.name === skillName);
  if (!skill) throw new Error(`Skill "${skillName}" not found in index`);

  // find the first .cjs script
  const scriptsDir = path.join(rootDir, skillName, 'scripts');
  if (!fs.existsSync(scriptsDir)) throw new Error(`No scripts/ directory for "${skillName}"`);
  const scripts = fs.readdirSync(scriptsDir).filter(f => /\.cjs$/.test(f));
  if (scripts.length === 0) throw new Error(`No .cjs scripts found for "${skillName}"`);
  return path.join(scriptsDir, scripts[0]);
}

function resolveParams(params, prevOutput) {
  // Replace $prev references with actual values from previous step output
  const resolved = {};
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

function buildArgs(params) {
  const args = [];
  for (const [key, val] of Object.entries(params || {})) {
    if (val === true) args.push(`--${key}`);
    else if (val !== false && val !== null && val !== undefined) args.push(`--${key}`, `"${String(val)}"`);
  }
  return args.join(' ');
}

/**
 * Execute a single skill step with optional retry logic.
 * @param {string} script - Path to the skill script
 * @param {string} args - CLI arguments string
 * @param {Object} step - Step definition (may include retries, retryDelay)
 * @returns {{ status: string, data?: any, error?: string, attempts: number }}
 */
function runStep(script, args, step = {}) {
  const maxAttempts = (step.retries || 0) + 1;
  const retryDelay = step.retryDelay || 1000;
  const timeout = step.timeout || 60000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = execSync(`node "${script}" ${args}`, {
        encoding: 'utf8', cwd: rootDir, timeout, stdio: 'pipe',
      });

      let parsed;
      try { parsed = JSON.parse(output); } catch { parsed = { raw: output.trim() }; }

      return { status: 'success', data: parsed, attempts: attempt };
    } catch (_err) {
      if (attempt < maxAttempts) {
        // Synchronous sleep before retry
        const waitUntil = Date.now() + retryDelay;
        while (Date.now() < waitUntil) { /* busy wait */ }
        continue;
      }
      return { status: 'error', error: err.message, attempts: attempt };
    }
  }
  return { status: 'error', error: 'Exhausted retries', attempts: maxAttempts };
}

/**
 * Run a pipeline of skills sequentially.
 * @param {Array<{skill: string, params?: Object, retries?: number, retryDelay?: number, continueOnError?: boolean}>} steps
 * @param {Object} [initialData={}] - Initial data passed to the first step
 * @returns {{ steps: Array<{skill: string, status: string, data: any}>, summary: Object }}
 */
function runPipeline(steps, initialData = {}) {
  const results = [];
  let prevOutput = initialData;
  const startTime = Date.now();

  for (const step of steps) {
    const script = resolveSkillScript(step.skill);
    const params = resolveParams(step.params, prevOutput);
    const args = buildArgs(params);

    const result = runStep(script, args, step);
    results.push({ skill: step.skill, ...result });

    if (result.status === 'success') {
      prevOutput = result.data?.data || result.data;
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

/**
 * Run multiple skills in parallel using child processes.
 * @param {Array<{skill: string, params?: Object, retries?: number}>} steps
 * @returns {Promise<{ steps: Array<{skill: string, status: string, data: any}>, summary: Object }>}
 */
function runParallel(steps) {
  const startTime = Date.now();

  const promises = steps.map(step => {
    const script = resolveSkillScript(step.skill);
    const args = buildArgs(step.params);
    const timeout = step.timeout || 60000;

    return new Promise(resolve => {
      exec(`node "${script}" ${args}`, {
        encoding: 'utf8', cwd: rootDir, timeout, maxBuffer: 5 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) {
          resolve({ skill: step.skill, status: 'error', error: err.message, attempts: 1 });
        } else {
          let parsed;
          try { parsed = JSON.parse(stdout); } catch { parsed = { raw: stdout.trim() }; }
          resolve({ skill: step.skill, status: 'success', data: parsed, attempts: 1 });
        }
      });
    });
  });

  return Promise.all(promises).then(results => ({
    pipeline: true,
    parallel: true,
    totalSteps: steps.length,
    completedSteps: results.filter(r => r.status === 'success').length,
    duration_ms: Date.now() - startTime,
    steps: results,
  }));
}

/**
 * Load a pipeline definition from a YAML file.
 * @param {string} yamlPath - Path to pipeline YAML file
 * @returns {{ steps: Array, run: Function }}
 */
function loadPipeline(yamlPath) {
  const content = fs.readFileSync(path.resolve(yamlPath), 'utf8');
  const def = yaml.load(content);

  if (!def.pipeline || !Array.isArray(def.pipeline)) {
    throw new Error('Invalid pipeline YAML: must have a "pipeline" array');
  }

  return {
    name: def.name || path.basename(yamlPath, '.yml'),
    steps: def.pipeline,
    run: (initialData) => runPipeline(def.pipeline, initialData),
  };
}

module.exports = { runPipeline, runParallel, loadPipeline, resolveSkillScript };
