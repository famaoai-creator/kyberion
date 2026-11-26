import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { ARGS_SUGGESTION_CAVEAT } from '@agent/core/pipeline/run-manifest';
import { runPipelineCheck } from './pipeline-execution-part-manifest.js';

const PIPELINE = {
  pipeline_id: 'suggest-args-fixture',
  steps: [
    { id: 'open', op: 'browser:goto', params: { url: 'https://app.example.test/' } },
    {
      id: 'pick',
      op: 'browser:evaluate',
      params: { script: "(() => '{{target}}'.split(' | ')[0])()", export_as: 'first' },
    },
    {
      id: 'regex',
      op: 'browser:evaluate',
      params: { script: '(() => /{{pattern}}/.test(document.title))()' },
    },
    {
      id: 'token',
      op: 'browser:evaluate',
      params: { script: "(() => fetch('/api', { headers: { t: '{{env.PORTAL_TOKEN}}' } }))()" },
    },
  ],
};

describe('pnpm pipeline check --suggest-args', () => {
  let dir = '';
  afterEach(() => {
    if (dir) safeRmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('prints one snippet per templated step and never writes the file', async () => {
    dir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `suggest-args-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    safeMkdir(dir, { recursive: true });
    const file = path.join(dir, 'pipeline.json');
    // A big integer and the authored formatting must survive: nothing is re-serialized.
    const text = JSON.stringify(PIPELINE, null, 2).replace(
      '"pipeline_id"',
      '"context": { "limit": 12345678901234567890 },\n  "pipeline_id"'
    );
    safeWriteFile(file, text);
    const printed: unknown[] = [];
    await runPipelineCheck({
      inputPath: pathResolver.toRepoRelative(file),
      trustResolved: false,
      delegatedTrustRequested: false,
      json: false,
      suggestArgs: true,
      print: (value) => printed.push(value),
    });
    expect(printed).toHaveLength(3);
    expect(String(printed[0])).toBe(
      `step 1: "script": "(a) => String(a.target).split(' | ')[0]", "args": {"target":"{{target}}"} — ${ARGS_SUGGESTION_CAVEAT}`
    );
    expect(String(printed[1])).toMatch(
      /^step 2: no args suggestion — a template sits inside a regular expression/u
    );
    expect(String(printed[2])).toMatch(
      /^step 3: no args suggestion — \{\{env\.PORTAL_TOKEN\}\} carries a credential \(env\/PORTAL_TOKEN\)/u
    );
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(text);
  });
});
