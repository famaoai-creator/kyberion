import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReaddir } from '../libs/core/secure-io.js';

const rootDir = process.cwd();
const scriptsDir = path.join(rootDir, 'scripts');

describe('Script topology contract', () => {
  it('keeps ad hoc demo and experimental scripts out of the top-level scripts directory', () => {
    const entries = safeReaddir(scriptsDir).sort((a, b) => a.localeCompare(b));
    const violations = entries.filter((entry) =>
      /^(demo_|test_)/.test(entry) ||
      [
        'debug_pdf_extraction.ts',
        'reproduce_pdf.ts',
        'send_slack_test.ts',
        'slack_echo.ts',
        'mock_agent_cli.sh',
        'gemini_output.txt',
        'tsconfig.temp.json',
      ].includes(entry)
    );

    expect(violations).toEqual([]);
  });
});
