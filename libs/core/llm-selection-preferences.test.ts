import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import { loadLlmSelectionPreferences } from './llm-selection-preferences.js';

describe('llm-selection-preferences persistence boundary', () => {
  beforeEach(() => {
    profileRoot.value = pathResolver.sharedTmp(`llm-selection-test-${process.pid}`);
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });

  it('loads a schema-valid selection through the catalog', () => {
    const filePath = path.join(profileRoot.value, 'onboarding', 'llm-selection.json');
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        provider: 'codex-cli',
        model_id: 'gpt-5',
        updated_at: '2026-09-03T00:00:00.000Z',
      })
    );

    expect(loadLlmSelectionPreferences()).toEqual({
      version: '1.0.0',
      provider: 'codex-cli',
      model_id: 'gpt-5',
      updated_at: '2026-09-03T00:00:00.000Z',
    });
  });

  it('rejects schema-invalid and non-file selections', () => {
    const filePath = path.join(profileRoot.value, 'onboarding', 'llm-selection.json');
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({ version: '1.0.0', provider: 'codex-cli', unexpected: true })
    );
    expect(loadLlmSelectionPreferences()).toBeNull();

    safeRmSync(filePath, { force: true });
    safeMkdir(filePath, { recursive: true });
    expect(loadLlmSelectionPreferences()).toBeNull();
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });
});
