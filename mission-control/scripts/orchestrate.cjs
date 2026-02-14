#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runSkill, ui } = require('@agent/core');
const { runPipeline } = require('../../scripts/lib/orchestrator.cjs');

// Improved argument extraction to handle CLI runner artifacts
function getArgs() {
  const args = process.argv.slice(2).filter(a => a !== '--');
  const yargs = require('yargs/yargs')(args)
    .option('pipeline', { alias: 'p', type: 'string' })
    .option('skills', { alias: 's', type: 'string' })
    .option('dir', { alias: 'd', type: 'string', default: '.' })
    .argv;
  return yargs;
}

const argv = getArgs();

function substituteVars(params, vars, prevResults = []) {
  const result = {};
  const lastResult = prevResults.length > 0 ? prevResults[prevResults.length - 1] : null;

  for (const [key, val] of Object.entries(params || {})) {
    if (typeof val === 'string') {
      let substituted = val
        .replace(/\$\{dir\}/g, vars.dir)
        .replace(/\$\{input\}/g, vars.input || '')
        .replace(/\$\{output\}/g, vars.output || '');
      
      if (substituted.includes('$prev.output') && lastResult && lastResult.data) {
        const field = substituted.split('$prev.output.')[1];
        if (field && lastResult.data[field]) {
          substituted = String(lastResult.data[field]);
        }
      }
      
      result[key] = substituted;
    } else {
      result[key] = val;
    }
  }
  return result;
}

runSkill('mission-control', () => {
  // SRE: Initialize Mission ID for the entire pipeline
  const missionId = ui.generateMissionId();
  process.env.MISSION_ID = missionId;
  console.log(`\x1b[35m[Mission Control] Initialized Mission: ${missionId}\x1b[0m\n`);

  if (argv.pipeline) {
    const pipelinePath = path.resolve(argv.pipeline);
    if (!fs.existsSync(pipelinePath)) throw new Error(`Pipeline file not found: ${pipelinePath}`);
    
    const def = yaml.load(fs.readFileSync(pipelinePath, 'utf8'));
    const results = [];
    
    for (const step of def.pipeline) {
      const finalParams = substituteVars(step.params, { dir: argv.dir }, results);
      console.log(`[Mission Control] Executing step: ${step.skill}`);
      
      const stepResult = runPipeline([{ skill: step.skill, params: finalParams }]);
      results.push(stepResult.steps[0]);
      
      if (stepResult.steps[0].status === 'error' && !step.continueOnError) {
        throw new Error(`Pipeline failed at step ${step.skill}: ${stepResult.steps[0].error?.message}`);
      }
    }

    return {
      status: 'completed',
      pipeline: def.name,
      steps: results.length,
      summary: results.map(r => ({ skill: r.skill, status: r.status }))
    };
  }

  return { status: 'success', message: 'No pipeline provided' };
});
