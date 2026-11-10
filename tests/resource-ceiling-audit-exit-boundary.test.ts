import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { productSourceFiles } from './helpers/store-grant-boundary.js';

// S4 (scope model P4): leaving the request resource ceilings is reserved for
// the audit chain's own record of a store grant disclosure. Only
// resource-access-scope.ts defines the exit and only authority.ts's disclosure
// writer names it, as the persistence step of `auditChain.recordDurable`.
const EXIT = 'runDisclosureAuditOutsideResourceCeilings';
const DEFINITION = 'libs/core/foundation/resource-access-scope.ts';
const WRITER = 'libs/core/authority.ts';

describe('resource ceiling exit for disclosure audit records', () => {
  it('is named only by its definition and the disclosure writer', () => {
    const root = process.cwd();
    const naming = productSourceFiles()
      .filter((file) => (safeReadFile(file, { encoding: 'utf8' }) as string).includes(EXIT))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .sort();
    expect(naming).toEqual([WRITER, DEFINITION].sort());
  });

  it('is used by the writer only to persist the disclosure record', () => {
    const text = safeReadFile(path.join(process.cwd(), WRITER), { encoding: 'utf8' }) as string;
    const uses = text.split(EXIT).length - 1;
    // One import binding and one use as recordDurable's persistence step.
    expect(uses).toBe(2);
    expect(text).toContain(`auditChain.recordDurable(entry, ${EXIT})`);
  });
});
