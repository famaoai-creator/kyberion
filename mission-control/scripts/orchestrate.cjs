#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { runPipeline, runParallel } = require('../../scripts/lib/orchestrator.cjs');
const { MetricsCollector } = require('../../scripts/lib/metrics.cjs');

const argv = createStandardYargs()
  .option('pipeline', {
    alias: 'p',
    type: 'string',
    describe: 'Path to YAML pipeline definition file',
  })
  .option('skills', {
    alias: 's',
    type: 'string',
    describe: 'Comma-separated list of skill names for ad-hoc execution',
  })
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    describe: 'Working directory for variable substitution',
  })
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '',
    describe: 'Input path for variable substitution',
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    default: '',
    describe: 'Output path for variable substitution',
  })
  .option('parallel', {
    type: 'boolean',
    default: false,
    describe: 'Run ad-hoc skills in parallel instead of sequentially',
  })
  .check((parsed) => {
    if (!parsed.pipeline && !parsed.skills) {
      throw new Error('Either --pipeline or --skills must be provided');
    }
    if (parsed.pipeline && parsed.skills) {
      throw new Error('Cannot use both --pipeline and --skills at the same time');
    }
    return true;
  })
  .strict()
  .help()
  .argv;

/**
 * Substitute variables in pipeline step params.
 */
function substituteVars(params, vars) {
  const result = {};
  for (const [key, val] of Object.entries(params || {})) {
    if (typeof val === 'string') {
      const substituted = val
        .replace(/\$\{dir\}/g, vars.dir)
        .replace(/\$\{input\}/g, vars.input)
        .replace(/\$\{output\}/g, vars.output);
      result[key] = substituted;
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Load and parse a YAML pipeline file.
 */
function loadYamlPipeline(pipelinePath) {
  const resolved = path.resolve(pipelinePath);
  if (!fs.existsSync(resolved)) {
    throw new Error('Pipeline file not found: ' + resolved);
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const def = yaml.load(content);

  if (!def || !def.pipeline || !Array.isArray(def.pipeline)) {
    throw new Error('Invalid pipeline YAML: must contain a "pipeline" array');
  }
  return def;
}

/**
 * Build steps array from comma-separated skill names.
 */
function buildAdHocSteps(skillsCsv, vars) {
  const skillNames = skillsCsv.split(',').map(s => s.trim()).filter(Boolean);
  if (skillNames.length === 0) {
    throw new Error('No valid skill names provided in --skills');
  }
  return skillNames.map(name => ({
    skill: name,
    params: { dir: vars.dir, input: vars.input, output: vars.output },
    continueOnError: true,
  }));
}

/**
 * Execute pipeline mode: load YAML and run steps.
 */
function executePipelineMode(pipelinePath, vars, collector) {
  const def = loadYamlPipeline(pipelinePath);
  const pipelineName = def.name || path.basename(pipelinePath, path.extname(pipelinePath));

  const steps = def.pipeline.map(step => ({
    ...step,
    params: substituteVars(step.params, vars),
  }));

  const startTime = Date.now();
  const result = runPipeline(steps);
  const duration = Date.now() - startTime;

  for (const stepResult of result.steps) {
    collector.record(stepResult.skill, stepResult.data?.metadata?.duration_ms || 0, stepResult.status);
  }

  const succeeded = result.steps.filter(s => s.status === 'success').length;
  const failed = result.steps.filter(s => s.status === 'error').length;

  return {
    mode: 'pipeline',
    pipelineName,
    stepsExecuted: result.steps.length,
    results: { succeeded, failed, total: result.steps.length },
    duration,
    metrics: collector.summarize(),
  };
}

/**
 * Execute ad-hoc mode: run comma-separated skills sequentially or in parallel.
 */
function executeAdHocMode(skillsCsv, vars, isParallel, collector) {
  const steps = buildAdHocSteps(skillsCsv, vars);
  const startTime = Date.now();

  let result;
  if (isParallel) {
    // runParallel returns a Promise; we use busy-wait for CJS sync compatibility
    let resolved = null;
    let rejected = null;
    let done = false;

    runParallel(steps).then(r => { resolved = r; done = true; }).catch(e => { rejected = e; done = true; });

    const deadline = Date.now() + 120000;
    while (!done && Date.now() < deadline) {
      require('child_process').spawnSync('sleep', ['0.01']);
    }

    if (rejected) throw rejected;
    if (!done) throw new Error('Parallel execution timed out after 120s');
    result = resolved;
  } else {
    result = runPipeline(steps);
  }

  const duration = Date.now() - startTime;

  for (const stepResult of result.steps) {
    collector.record(stepResult.skill, stepResult.data?.metadata?.duration_ms || 0, stepResult.status);
  }

  const skillNames = steps.map(s => s.skill);
  const succeeded = result.steps.filter(s => s.status === 'success').length;
  const failed = result.steps.filter(s => s.status === 'error').length;

  return {
    mode: isParallel ? 'parallel' : 'sequential',
    skillsExecuted: skillNames,
    results: { succeeded, failed, total: result.steps.length },
    duration,
    metrics: collector.summarize(),
  };
}

runSkill('mission-control', () => {
  const vars = { dir: argv.dir, input: argv.input, output: argv.output };
  const collector = new MetricsCollector({ persist: false });

  if (argv.pipeline) {
    return executePipelineMode(argv.pipeline, vars, collector);
  }

  return executeAdHocMode(argv.skills, vars, argv.parallel, collector);
});
