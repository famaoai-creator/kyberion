#!/usr/bin/env node

/**
 * Pipeline Runner - executes YAML-defined orchestration pipelines.
 *
 * Reads a pipeline definition from pipelines/<name>.yml, replaces {{var}}
 * placeholders with CLI arguments, and runs each skill step sequentially.
 *
 * Usage:
 *   node scripts/pipeline-runner.cjs --pipeline code-quality --input tests/smoke.test.cjs
 *   node scripts/pipeline-runner.cjs --pipeline security-audit --dir .
 *   node scripts/pipeline-runner.cjs --pipeline doc-analysis --input README.md
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runSkill } = require('./lib/skill-wrapper.cjs');

const rootDir = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse CLI arguments with yargs
// ---------------------------------------------------------------------------

const argv = createStandardYargs()
  .option('pipeline', {
    alias: 'p',
    type: 'string',
    demandOption: true,
    description: 'Name of the pipeline to run (matches pipelines/<name>.yml)',
  })
  .option('dir', {
    type: 'string',
    description: 'Directory variable for {{dir}} placeholders',
  })
  .option('input', {
    alias: 'i',
    type: 'string',
    description: 'Input file variable for {{input}} placeholders',
  })
  .strict(false) // allow additional unknown flags for future variables
  .help()
  .argv;

// ---------------------------------------------------------------------------
// Resolve the main .cjs script for a given skill name
// ---------------------------------------------------------------------------
function resolveSkillScript(skillName) {
  const scriptsDir = path.join(rootDir, skillName, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    throw new Error(`No scripts/ directory found for skill "${skillName}"`);
  }
  const scripts = fs.readdirSync(scriptsDir).filter(f => /\.cjs$/.test(f));
  if (scripts.length === 0) {
    throw new Error(`No .cjs scripts found for skill "${skillName}"`);
  }
  return path.join(scriptsDir, scripts[0]);
}

// ---------------------------------------------------------------------------
// Replace {{variable}} placeholders in a string with CLI values
// ---------------------------------------------------------------------------
function interpolate(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (vars[key] === undefined) {
      throw new Error(
        `Pipeline variable "{{${key}}}" has no value. Pass --${key} <value> on the command line.`
      );
    }
    return String(vars[key]);
  });
}

// ---------------------------------------------------------------------------
// Build the variables object from argv (everything except yargs internals)
// ---------------------------------------------------------------------------
function buildVars(parsedArgv) {
  const vars = {};
  for (const [key, val] of Object.entries(parsedArgv)) {
    // Skip yargs internal keys
    if (key === '_' || key === '$0' || key === 'pipeline' || key === 'p') continue;
    // Skip aliases (single-char)
    if (key.length === 1) continue;
    if (val !== undefined && val !== null) {
      vars[key] = val;
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Execute a single pipeline step
// ---------------------------------------------------------------------------
function executeStep(step, vars) {
  const skillName = step.skill;
  const scriptPath = resolveSkillScript(skillName);
  const args = step.args ? interpolate(step.args, vars) : '';
  const cwd = step.cwd ? path.resolve(interpolate(step.cwd, vars)) : rootDir;

  const cmd = `node "${scriptPath}" ${args}`;
  const startTime = Date.now();

  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      cwd,
      timeout: 120000,
      stdio: 'pipe',
    });

    const duration_ms = Date.now() - startTime;

    // Try to parse JSON output (skills use skill-wrapper which outputs JSON)
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { raw: stdout.trim() };
    }

    return {
      skill: skillName,
      output: step.output || null,
      status: 'success',
      data,
      duration_ms,
    };
  } catch (_err) {
    const duration_ms = Date.now() - startTime;

    // Try to extract JSON from stderr/stdout even on failure
    let errorData = null;
    if (err.stdout) {
      try {
        errorData = JSON.parse(err.stdout);
      } catch {
        // ignore
      }
    }

    return {
      skill: skillName,
      output: step.output || null,
      status: 'error',
      data: errorData,
      error: err.stderr ? err.stderr.trim().split('\n')[0] : err.message.split('\n')[0],
      duration_ms,
    };
  }
}

// ---------------------------------------------------------------------------
// Main: load pipeline YAML and run all steps
// ---------------------------------------------------------------------------
runSkill('pipeline-runner', () => {
  const pipelineName = argv.pipeline;
  const pipelineFile = path.join(rootDir, 'pipelines', `${pipelineName}.yml`);

  if (!fs.existsSync(pipelineFile)) {
    // List available pipelines for a helpful error message
    const pipelinesDir = path.join(rootDir, 'pipelines');
    const available = fs.existsSync(pipelinesDir)
      ? fs.readdirSync(pipelinesDir).filter(f => f.endsWith('.yml')).map(f => f.replace('.yml', ''))
      : [];
    throw new Error(
      `Pipeline "${pipelineName}" not found at ${pipelineFile}. ` +
      `Available pipelines: ${available.length > 0 ? available.join(', ') : '(none)'}`
    );
  }

  const pipelineDef = yaml.load(fs.readFileSync(pipelineFile, 'utf8'));

  if (!pipelineDef || !Array.isArray(pipelineDef.steps)) {
    throw new Error(`Invalid pipeline definition: "${pipelineFile}" must contain a "steps" array`);
  }

  const vars = buildVars(argv);
  const pipelineStart = Date.now();
  const stepResults = [];

  for (const step of pipelineDef.steps) {
    const result = executeStep(step, vars);
    stepResults.push(result);
    // Continue to next step even on error (graceful degradation)
  }

  const totalDuration_ms = Date.now() - pipelineStart;

  return {
    pipeline: pipelineDef.name || pipelineName,
    description: pipelineDef.description || null,
    steps: stepResults,
    summary: {
      total: pipelineDef.steps.length,
      succeeded: stepResults.filter(s => s.status === 'success').length,
      failed: stepResults.filter(s => s.status === 'error').length,
    },
    totalDuration_ms,
  };
});
