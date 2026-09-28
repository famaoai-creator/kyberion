import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('mission controller contract', () => {
  it('documents customer-aware vision defaults in the CLI help', () => {
    const controller = read('scripts/mission_controller.ts');
    // DS refactor: help text lives in refactor/mission-controller-help.ts
    const helpModule = read('scripts/refactor/mission-controller-help.ts');
    expect(helpModule).toContain(
      'Defaults to the active customer vision when KYBERION_CUSTOMER is set'
    );
  });
});
