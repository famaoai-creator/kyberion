import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';

const rootDir = process.cwd();
const scriptsDir = path.join(rootDir, 'scripts');

// `test_suite.ts` (and its own `test_suite.test.ts`) is the governed
// `pnpm test` entrypoint (package.json `test`/`test:unit`/... scripts,
// added by commit a877d9c12's SX simplicity pass) — canonical infra, not an
// ad hoc/experimental script the `test_` prefix rule below is meant to
// catch (one-off scratch files like `test_something_manual.ts`).
const CANONICAL_TOP_LEVEL_SCRIPTS = new Set(['test_suite.ts', 'test_suite.test.ts']);

describe('Script topology contract', () => {
  it('keeps ad hoc demo and experimental scripts out of the top-level scripts directory', () => {
    const entries = safeReaddir(scriptsDir).sort((a, b) => a.localeCompare(b));
    const violations = entries.filter(
      (entry) =>
        !CANONICAL_TOP_LEVEL_SCRIPTS.has(entry) &&
        (/^(demo_|test_)/.test(entry) ||
          [
            'debug_pdf_extraction.ts',
            'reproduce_pdf.ts',
            'send_slack_test.ts',
            'slack_echo.ts',
            'mock_agent_cli.sh',
            'gemini_output.txt',
            'tsconfig.temp.json',
          ].includes(entry))
    );

    expect(violations).toEqual([]);
  });
});
