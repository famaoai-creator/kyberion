import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  formatReasoningBackendMenu,
  listReasoningBackendChoices,
  normalizeReasoningBackendChoice,
  readPersistedReasoningBackend,
  resolveReasoningBackendMenuSelection,
  upsertEnvVarLine,
} from './reasoning_backend_selection.js';

describe('reasoning_backend_selection', () => {
  it('uses the foundation reader for persisted operator preferences', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/reasoning_backend_selection.ts'));
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
  });

  it('derives the catalog from the reasoning-backend policy (LC-04c SSoT)', () => {
    const choices = listReasoningBackendChoices();
    // Spot-check the members the guidance/menu previously dropped.
    for (const expected of ['claude-cli', 'codex-cli', 'grok-cli', 'copilot', 'agy-cli', 'stub']) {
      expect(choices).toContain(expected);
    }
    // No alias leakage — allowed_modes are canonical.
    expect(choices).not.toContain('grok');
  });

  it('normalizes aliases and rejects unknown values', () => {
    expect(normalizeReasoningBackendChoice('grok')).toBe('grok-cli');
    expect(normalizeReasoningBackendChoice('claude-cli')).toBe('claude-cli');
    expect(normalizeReasoningBackendChoice('bogus-backend')).toBeNull();
    expect(normalizeReasoningBackendChoice('   ')).toBeNull();
  });

  it('formats a numbered menu with the recommended/offline annotations', () => {
    const lines = formatReasoningBackendMenu(['claude-cli', 'codex-cli', 'stub']);
    expect(lines).toEqual([
      '1. claude-cli (Recommended)',
      '2. codex-cli',
      '3. stub (Offline mock)',
    ]);
  });

  it('resolves menu selections by number, name, and alias', () => {
    const choices = listReasoningBackendChoices();
    expect(resolveReasoningBackendMenuSelection('1', choices)).toBe(choices[0]);
    expect(resolveReasoningBackendMenuSelection(String(choices.length), choices)).toBe(
      choices[choices.length - 1]
    );
    expect(resolveReasoningBackendMenuSelection('0', choices)).toBeNull();
    expect(resolveReasoningBackendMenuSelection(String(choices.length + 1), choices)).toBeNull();
    expect(resolveReasoningBackendMenuSelection('grok', choices)).toBe('grok-cli');
    expect(resolveReasoningBackendMenuSelection('', choices)).toBeNull();
    expect(resolveReasoningBackendMenuSelection('nonsense', choices)).toBeNull();
  });

  it('upserts the env line without disturbing other content', () => {
    expect(upsertEnvVarLine('', 'KYBERION_REASONING_BACKEND', 'claude-cli')).toBe(
      'KYBERION_REASONING_BACKEND=claude-cli\n'
    );
    expect(upsertEnvVarLine('OTHER=1', 'KYBERION_REASONING_BACKEND', 'claude-cli')).toBe(
      'OTHER=1\nKYBERION_REASONING_BACKEND=claude-cli\n'
    );
    expect(
      upsertEnvVarLine(
        'OTHER=1\nKYBERION_REASONING_BACKEND=stub\nMORE=2\n',
        'KYBERION_REASONING_BACKEND',
        'grok-cli'
      )
    ).toBe('OTHER=1\nKYBERION_REASONING_BACKEND=grok-cli\nMORE=2\n');
  });

  it('reads null when no .env.local exists at the given path', () => {
    expect(
      readPersistedReasoningBackend('active/shared/tmp/lc05-nonexistent-env-local')
    ).toBeNull();
  });
});
