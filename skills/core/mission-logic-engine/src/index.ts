import { runSkillAsync } from '@agent/core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { executeMLE } from './mle-core.js';

runSkillAsync('mission-logic-engine', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('pipeline', {
      alias: 'p',
      type: 'string',
      demandOption: true,
      description: 'Path to mission logic (YAML)',
    })
    .option('signal-dir', {
      alias: 's',
      type: 'string',
      description: 'Directory for signals',
    })
    .option('vars', {
      alias: 'v',
      type: 'string',
      description: 'Pipeline variables (key=val,key2=val2)',
    })
    .parseSync();

  const missionId = process.env.MISSION_ID || `MSN-${Date.now()}`;
  
  // Parse variables
  const vars: Record<string, any> = {};
  if (argv.vars) {
    argv.vars.split(',').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k && v) vars[k.trim()] = v.trim();
    });
  }

  return await executeMLE({
    pipelinePath: argv.pipeline as string,
    missionId,
    vars,
    signalDir: argv.signal_dir as string
  });
});
