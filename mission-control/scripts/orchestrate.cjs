#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { runSkill, ui } = require('@agent/core');
const { runPipeline } = require('@agent/core/orchestrator');

// Improved argument extraction to handle CLI runner artifacts
function getArgs() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const yargs = require('yargs/yargs')(args)
    .option('pipeline', { alias: 'p', type: 'string' })
    .option('skills', { alias: 's', type: 'string' })
    .option('dir', { alias: 'd', type: 'string', default: '.' }).argv;
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

    console.log(chalk.bold.cyan(`\u25bc Pipeline: ${def.name}`));

    for (let i = 0; i < def.pipeline.length; i++) {
      const step = def.pipeline[i];
      const isLast = i === def.pipeline.length - 1;
      const prefix = isLast ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500';

      const finalParams = substituteVars(step.params, { dir: argv.dir }, results);
      process.stdout.write(`${chalk.dim(prefix)} ${chalk.white(step.skill)} ... `);

      const stepResult = runPipeline([{ skill: step.skill, params: finalParams }]);
      const res = stepResult.steps[0];
      results.push(res);

      const statusIcon = res.status === 'success' ? chalk.green('\u2714') : chalk.red('\u2718');
      process.stdout.write(
        `\r${chalk.dim(prefix)} ${chalk.white(step.skill.padEnd(25))} ${statusIcon}\n`
      );

      if (res.status === 'error' && !step.continueOnError) {
        console.log(chalk.red(`\n\u26a0\ufe0f  Mission aborted due to failure in ${step.skill}`));
        throw new Error(res.error?.message);
      }
    }

    return {
      status: 'completed',
      pipeline: def.name,
      steps: results.length,
      summary: results.map((r) => ({ skill: r.skill, status: r.status })),
    };
  }

  return { status: 'success', message: 'No pipeline provided' };
});
