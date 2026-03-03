import { runSkill, requireArgs } from '@agent/core';
import { classifyText } from './lib';
import yargs from 'yargs';

runSkill('text-classifier', () => {
  const argv = yargs(process.argv.slice(2)).options({
    input: { type: 'string', demandOption: true },
    type: { type: 'string', choices: ['doc-type', 'domain', 'intent'], default: 'doc-type' }
  }).parseSync();

  return classifyText(argv.input, argv.type as 'doc-type' | 'domain' | 'intent');
});
