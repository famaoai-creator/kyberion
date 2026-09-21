import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import {
  getSeamTraitOverrides,
  hasSeamSelectionRules,
  listSeamSelectionRules,
  matchSeamSelectionRule,
  removeSeamSelectionRule,
  setSeamSelectionRule,
  setSeamTraitOverrides,
} from './seam-selection-rules.js';

const dir = pathResolver.sharedTmp('seam-selection-rules-test');
const file = path.join(dir, 'rules.json');

describe('operator seam selection rules', () => {
  beforeEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', file);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing overlay as no rules', () => {
    expect(listSeamSelectionRules()).toEqual([]);
    expect(hasSeamSelectionRules('ocr-provider')).toBe(false);
  });

  it('stores, replaces and removes rules by id', () => {
    setSeamSelectionRule({
      rule_id: 'ja-tts',
      seam: 'voice-tts-engine',
      when: { context: { language: 'ja' } },
      prefer: ['kokoro'],
      set_by: 'user:owner',
    });
    setSeamSelectionRule({
      rule_id: 'ja-tts',
      seam: 'voice-tts-engine',
      when: { context: { language: 'ja' } },
      prefer: ['local_say', 'kokoro'],
      set_by: 'user:owner',
    });
    expect(safeExistsSync(file)).toBe(true);
    const rules = listSeamSelectionRules('voice-tts-engine');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.prefer).toEqual(['local_say', 'kokoro']);
    expect(removeSeamSelectionRule('ja-tts')).toBe(true);
    expect(removeSeamSelectionRule('ja-tts')).toBe(false);
  });

  it('picks the most specific matching rule', () => {
    const base = { seam: 'ocr-provider', set_by: 'user:owner' };
    setSeamSelectionRule({ ...base, rule_id: 'any', when: {}, prefer: ['tesseract'] });
    setSeamSelectionRule({
      ...base,
      rule_id: 'acc',
      when: { purpose: 'accuracy' },
      prefer: ['apple_vision'],
    });
    setSeamSelectionRule({
      ...base,
      rule_id: 'acc-ja',
      when: { purpose: 'accuracy', context: { language: 'ja' } },
      prefer: ['llm_api'],
    });
    expect(matchSeamSelectionRule('ocr-provider', {})?.rule_id).toBe('any');
    expect(matchSeamSelectionRule('ocr-provider', { purpose: 'accuracy' })?.rule_id).toBe('acc');
    expect(
      matchSeamSelectionRule('ocr-provider', { purpose: 'accuracy', context: { language: 'ja' } })
        ?.rule_id
    ).toBe('acc-ja');
    expect(matchSeamSelectionRule('ocr-provider', { purpose: 'speed' })?.rule_id).toBe('any');
    expect(matchSeamSelectionRule('image-generation-provider', {})).toBeNull();
  });

  it('merges measured trait overrides per provider and trait', () => {
    setSeamTraitOverrides({ seam: 'ocr-provider', values: { tesseract: { latency: 0.4 } } });
    setSeamTraitOverrides({
      seam: 'ocr-provider',
      values: { tesseract: { accuracy: 0.6 } },
      evidence: ['active/shared/runtime/seam-calibration/x/report.json'],
    });
    expect(getSeamTraitOverrides('ocr-provider').tesseract!.traits).toEqual({
      latency: 0.4,
      accuracy: 0.6,
    });
    const stored = JSON.parse(String(safeReadFile(file, { encoding: 'utf8' })));
    expect(stored.version).toBe('1.0.0');
  });

  it('rejects rules that break the schema', () => {
    expect(() =>
      setSeamSelectionRule({ rule_id: 'Bad Id', seam: 'x', when: {}, prefer: ['a'] })
    ).toThrow();
  });
});
