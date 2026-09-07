import { describe, expect, it } from 'vitest';
import { buildNextActionFromError, formatNextAction, t } from '@agent/core';
import { classifyError } from '@agent/core';

describe('next action builder', () => {
  it('maps path-scope policy blocks to a runnable follow-up', () => {
    // The vocabulary-backed title renders through the ambient OS locale
    // (LANG); pin KYBERION_LOCALE to 'en' so this assertion is deterministic
    // regardless of the runner's locale, and compare against the catalog's
    // own 'en' text rather than a duplicated literal.
    const previousLocale = process.env.KYBERION_LOCALE;
    process.env.KYBERION_LOCALE = 'en';
    try {
      const classification = classifyError(
        '[POLICY_VIOLATION] Write rejected by path-scope-policy: path is outside project root.'
      );
      const action = buildNextActionFromError(classification, {
        source: 'pipeline',
        pipelinePath: 'pipelines/demo.json',
      });
      expect(action.next_action_type).toBe('request_clarification');
      expect(action.suggested_followup_request).toContain('active/missions');
      expect(formatNextAction(action)[0]).toContain(
        t('next_action:fix_write_path_scope', undefined, 'en')
      );
    } finally {
      if (previousLocale === undefined) delete process.env.KYBERION_LOCALE;
      else process.env.KYBERION_LOCALE = previousLocale;
    }
  });

  it('maps auth failures to onboarding', () => {
    const classification = classifyError('Invalid API key');
    const action = buildNextActionFromError(classification, { source: 'pipeline' });
    expect(action.next_action_type).toBe('bootstrap_environment');
    expect(action.suggested_command).toBe('pnpm onboard');
  });

  it('maps stale surfaces to repair commands', () => {
    const classification = classifyError('surface unhealthy after failed health probe');
    const action = buildNextActionFromError(classification, {
      source: 'surface',
      surfaceId: 'chronos',
      surfaceStateHealth: 'stale',
      surfaceRepairHint: 'stale state record',
    });
    expect(action.next_action_type).toBe('repair_surface');
    expect(action.suggested_command).toBe('pnpm surfaces repair -- --surface chronos');
  });

  it('maps doctor findings to bootstrap commands', () => {
    const classification = classifyError('Missing runtime prerequisite');
    const action = buildNextActionFromError(classification, {
      source: 'doctor',
      manifestId: 'meeting-participation-runtime',
      runtime: 'meeting',
    });
    expect(action.suggested_command).toBe(
      'pnpm env:bootstrap --manifest meeting-participation-runtime --apply'
    );
  });
});
