import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { loadTaskScenario, parseTaskRecord, validateTaskScenario } from './lib/task-scenario.js';

const validScenario = {
  id: 'daily-report',
  title: 'Daily report',
  description: 'Prepare a daily report.',
  trigger: { type: 'manual', prompt: 'Prepare the report.' },
  input: { sources: ['calendar'], required_params: [] },
  first_run: {
    reasoning_required: false,
    questions: ['Audience?'],
    profile_output: 'knowledge/personal/report.json',
  },
  repeat_run: { pipeline_template: 'pipelines/report.json', params_from_profile: false },
  result: { artifacts: ['report.md'], summary_format: 'markdown' },
  approval_boundary: { required_for: ['send'], default_action: 'requires-human-approval' },
};

describe('TaskScenario schema boundary', () => {
  it('accepts a schema-valid scenario', () => {
    expect(validateTaskScenario(validScenario)).toMatchObject({ id: 'daily-report' });
  });

  it.each([
    null,
    [],
    { ...validScenario, id: 'Not a valid id' },
    { ...validScenario, first_run: { ...validScenario.first_run, questions: [] } },
  ])('rejects malformed scenario input: %j', (value) => {
    expect(() => validateTaskScenario(value)).toThrow('Invalid TaskScenario');
  });
});

describe('TaskScenario persisted loader', () => {
  const root = pathResolver.sharedTmp('task-scenario-loader-tests');

  it('loads only schema-valid regular files through the path-bound catalog', () => {
    safeMkdir(root, { recursive: true });
    const validPath = path.join(root, 'valid.json');
    const invalidPath = path.join(root, 'invalid.json');
    const directoryPath = path.join(root, 'directory.json');
    const linkPath = path.join(root, 'link.json');
    safeWriteFile(validPath, `${JSON.stringify(validScenario)}\n`);
    safeWriteFile(invalidPath, `${JSON.stringify({ ...validScenario, unexpected: true })}\n`);
    safeMkdir(directoryPath, { recursive: true });
    safeSymlinkSync(validPath, linkPath);

    try {
      expect(loadTaskScenario(validPath).id).toBe('daily-report');
      expect(() => loadTaskScenario(invalidPath)).toThrow(/Invalid catalog task-scenario/);
      expect(() => loadTaskScenario(directoryPath)).toThrow(/must be a regular file/);
      expect(() => loadTaskScenario(linkPath)).toThrow(/must be a regular file|symbolic link/);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TaskScenario record boundary', () => {
  it('accepts object answers and profiles', () => {
    expect(parseTaskRecord({ audience: 'operators' }, 'TaskScenario answers')).toEqual({
      audience: 'operators',
    });
  });

  it.each([null, [], 'answers', 42])('rejects non-object records: %j', (value) => {
    expect(() => parseTaskRecord(value, 'TaskScenario answers')).toThrow(
      'TaskScenario answers must be a JSON object'
    );
  });

  it('rejects nested dangerous keys before profile persistence', () => {
    expect(() =>
      parseTaskRecord({ preferences: { constructor: { polluted: true } } }, 'TaskScenario answers')
    ).toThrow('TaskScenario answers contains a dangerous JSON key');
  });
});
