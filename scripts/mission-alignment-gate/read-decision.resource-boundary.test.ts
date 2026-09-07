import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { main, resolveDecisionResourcePath } from './read-decision.js';

const tempRoot = pathResolver.sharedTmp(`read-decision-output-${process.pid}`);

let previousLocale: string | undefined;

beforeEach(() => {
  // The human-readable banner goes through the i18n catalog, which resolves
  // the locale from ambient env (LANG on CI is C.UTF-8). Pin Japanese so the
  // banner assertions below are hermetic on every runner.
  previousLocale = process.env.KYBERION_LOCALE;
  process.env.KYBERION_LOCALE = 'ja';
});

afterEach(() => {
  if (previousLocale === undefined) delete process.env.KYBERION_LOCALE;
  else process.env.KYBERION_LOCALE = previousLocale;
  safeRmSync(tempRoot, { recursive: true, force: true });
});

function writeFixture(decision: string): [string, string] {
  safeMkdir(tempRoot, { recursive: true });
  const htmlPath = path.join(tempRoot, 'reviewed.html');
  const jsonPath = path.join(tempRoot, 'mission-brief.json');
  safeWriteFile(
    htmlPath,
    `<div id="mg-gate" data-decision="${decision}" data-decided-by="operator"></div>`,
    { encoding: 'utf8' }
  );
  safeWriteFile(jsonPath, JSON.stringify({ missionId: 'MSN-READ-DECISION' }), {
    encoding: 'utf8',
  });
  return [htmlPath, jsonPath];
}

describe('mission alignment decision resource boundary', () => {
  it('rejects repository-external reviewed resources', () => {
    expect(() => resolveDecisionResourcePath('/tmp/reviewed.html', true)).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
    expect(() => resolveDecisionResourcePath('../outside/brief.json', true)).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });

  it('routes the decision report through the supplied printer', () => {
    const [htmlPath, jsonPath] = writeFixture('pending');
    const output: unknown[] = [];

    main([htmlPath, jsonPath], (value) => output.push(value));

    expect(output).toHaveLength(2);
    expect(String(output[0])).toContain('"decision": "pending"');
    expect(String(output[1])).toContain('pending');
    const source = readTextFile(
      pathResolver.rootResolve('scripts/mission-alignment-gate/read-decision.ts')
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
  });

  it('preserves approved exit semantics after printing the report', () => {
    const [htmlPath, jsonPath] = writeFixture('approved');
    const output: unknown[] = [];

    expect(() => main([htmlPath, jsonPath], (value) => output.push(value))).toThrow();
    expect(output).toHaveLength(4);
    expect(String(output[1])).toContain('承認済み');
    expect(String(output[2])).toContain('Static HTML is not an approval record');
  });
});
