import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import {
  analyzeCodeComplexity,
  detectTechDebt,
  getRecentVelocity,
  checkInfrastructure,
  generateRoadmap,
  RoadmapResult,
} from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory to analyze',
  })
  .option('months', {
    alias: 'm',
    type: 'number',
    default: 3,
    description: 'Planning horizon in months',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .parseSync();

runSkill('strategic-roadmap-planner', () => {
  const targetDir = path.resolve(argv.dir as string);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const complexity = analyzeCodeComplexity(targetDir);
  const debt = detectTechDebt(targetDir);
  const velocity = getRecentVelocity(targetDir);
  const infra = checkInfrastructure(targetDir);
  const roadmap = generateRoadmap(complexity, debt, velocity, infra, argv.months as number);

  const result: RoadmapResult = {
    directory: targetDir,
    planningHorizon: `${argv.months} months`,
    codeAnalysis: {
      totalFiles: complexity.totalFiles,
      totalLines: complexity.totalLines,
      avgFileSize: complexity.avgFileSize,
      languages: complexity.languages,
      largeFiles: complexity.largeFiles.slice(0, 5),
    },
    techDebt: debt,
    velocity,
    infrastructure: infra,
    roadmap: roadmap.phases,
    priorities: roadmap.priorities,
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
