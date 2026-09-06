import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import {
  loadWorkCoordinationIssue,
  parseWorkCoordinationJson,
  resolveWorkCoordinationInputPath,
} from './work_coordination.js';

const issuePath = pathResolver.sharedTmp(`work-coordination-issue-${process.pid}.json`);

afterEach(() => {
  safeRmSync(issuePath, { force: true });
});

describe('work coordination resource boundary', () => {
  it('rejects repository-external issue input', () => {
    expect(() => resolveWorkCoordinationInputPath('/tmp/issue.json')).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });

  it('accepts JSON objects and rejects non-object or dangerous input', () => {
    expect(parseWorkCoordinationJson('{"tenant_slug":"acme"}')).toEqual({
      tenant_slug: 'acme',
    });
    expect(() => parseWorkCoordinationJson('[]')).toThrow('safe JSON object');
    expect(() => parseWorkCoordinationJson('{"constructor":{"polluted":true}}')).toThrow(
      'safe JSON object'
    );
    expect(() => parseWorkCoordinationJson('{"nested":{"__proto__":true}}')).toThrow(
      'safe JSON object'
    );
  });

  it('fails closed for dangerous persisted issue input', () => {
    safeWriteFile(issuePath, '{"__proto__":{"polluted":true},"id":1}');
    expect(() => loadWorkCoordinationIssue(issuePath)).toThrow('dangerous JSON key');
  });

  it('routes coordination output through the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/work_coordination.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
