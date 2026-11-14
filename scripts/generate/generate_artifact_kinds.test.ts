import { afterEach, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import { createArtifactKindGenerator } from './generate_artifact_kinds.js';

const tmp = pathResolver.sharedTmp('artifact-kind-generator-test');
afterEach(() => {
  safeRmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});
it('detects schema vocabulary changes in --check without replacing generated output', async () => {
  safeMkdir(tmp, { recursive: true });
  const schema = tmp + '/source.json';
  const output = tmp + '/generated.ts';
  safeWriteFile(schema, JSON.stringify({ enum: ['code', 'summary'] }));
  const generate = createArtifactKindGenerator(schema, output);
  await generate([]);
  expect((await generate(['--check']))?.changed).toEqual([]);
  safeWriteFile(schema, JSON.stringify({ enum: ['code', 'summary', 'new-kind'] }));
  expect((await generate(['--check']))?.changed).toEqual([output]);
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  await generate([]);
  expect((await generate(['--check']))?.changed).toEqual([]);
});
