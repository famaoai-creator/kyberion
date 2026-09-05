import { describe, expect, it } from 'vitest';
import { checkInstallScriptAllowlist } from './check_install_script_allowlist.js';

describe('install script allowlist checker', () => {
  it('keeps workspace allowBuilds and the governance policy aligned', () => {
    const result = checkInstallScriptAllowlist();
    expect(result.findings).toEqual([]);
    expect(result.packageCount).toBeGreaterThan(0);
  });
});
