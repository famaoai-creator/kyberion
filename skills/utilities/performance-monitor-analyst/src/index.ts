import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { calculatePercentile, classifyMetric } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to metrics file or directory',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for performance report',
  })
  .help()
  .parseSync();

runSkill('performance-monitor-analyst', () => {
  const target = path.resolve(argv.input as string);
  let rawMetrics: any[] = [];

  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) {
      const files = fs.readdirSync(target).filter((f) => f.endsWith('.jsonl'));
      files.forEach((f) => {
        const lines = fs.readFileSync(path.join(target, f), 'utf8').trim().split('\n');
        rawMetrics.push(...lines.map((l) => JSON.parse(l)));
      });
    } else {
      const content = fs.readFileSync(target, 'utf8').trim();
      if (target.endsWith('.jsonl')) {
        rawMetrics = content.split('\n').map((l) => JSON.parse(l));
      } else {
        const data = JSON.parse(content);
        rawMetrics = data.metrics || [data];
      }
    }
  }

  const results = rawMetrics.map((m: any) => ({
    skill: m.skill,
    duration_ms: m.duration_ms || m.value,
    timestamp: m.timestamp,
    category: classifyMetric(m.skill || 'unknown', 'ms'),
  }));

  const report = {
    totalExecutions: results.length,
    p95_ms: calculatePercentile(
      results.map((r) => r.duration_ms),
      95
    ),
    metrics: results,
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(report, null, 2));
  }

  return report;
});
