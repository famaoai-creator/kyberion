import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { loadScenarioFile } from '@agent/core/scenario-definition';
import { runScenario } from '@agent/core/scenario-executor';
import { collectScenarioFiles, createInProcessPipelineRunner } from '../scripts/scenario_runner.js';

const files = collectScenarioFiles('eval/scenarios');
const runPipeline = createInProcessPipelineRunner();

describe('ES-08 starter scenario suite (eval/scenarios)', () => {
  it('ships the five pr-deterministic, simulated, model-free starter scenarios', () => {
    const defs = files.map((file) => loadScenarioFile(file));
    expect(defs.map((def) => def.id)).toEqual([
      'pipeline-stubbed-apply',
      'approval-rejected-no-side-effect',
      'approval-approved-transition',
      'unstubbed-op-fails-closed',
      'trace-span-and-artifact',
    ]);
    for (const def of defs) {
      expect(def).toMatchObject({
        lane: 'pr-deterministic',
        executionProfile: 'simulated',
        modelFixtures: 'model-free',
      });
    }
  });

  it.each(files.map((file) => [pathResolver.toRepoRelative(file), file]))(
    '%s passes',
    async (_label, file) => {
      const report = await runScenario(loadScenarioFile(file), {
        lane: 'pr-deterministic',
        baseDir: path.dirname(file),
        seedNonce: `starter-suite-${process.pid}`,
        runPipeline,
      });
      const failures = [
        ...report.turns.flatMap((turn) => [
          ...(turn.error ? [turn.error] : []),
          ...turn.checks.filter((check) => !check.pass).map((check) => check.detail),
        ]),
        ...report.final_checks.filter((check) => !check.pass).map((check) => check.detail),
      ];
      expect(failures).toEqual([]);
      expect(report.status).toBe('pass');
      expect(report.evidence_class).toBe('simulated');
      expect(report.final_checks.length).toBeGreaterThan(0);
    }
  );
});
