import { describe, expect, it } from 'vitest';
import {
  buildServiceAuthNextAction,
  buildServiceConnectionSetupCommand,
} from './services_setup.js';

describe('services setup guidance', () => {
  it('routes connection completion through the services-only onboarding phase', () => {
    expect(buildServiceConnectionSetupCommand('voice')).toBe(
      'pnpm onboard -- --services-only --service voice'
    );
    expect(buildServiceConnectionSetupCommand('voice')).not.toBe('pnpm services:setup');
  });

  it('routes OAuth-backed auth to the governed setup script', () => {
    const action = buildServiceAuthNextAction('notion', {
      setupHint: 'Missing credentials',
      oauthAvailable: true,
      requiredSecrets: ['NOTION_ACCESS_TOKEN'],
    });
    expect(action.suggested_command).toContain('scripts/setup_oauth.ts');
    expect(action.suggested_command).toContain('KYBERION_OAUTH_SERVICE_ID=notion');
  });

  it('does not invent a self-referential command for secret-backed auth', () => {
    const action = buildServiceAuthNextAction('slack', {
      setupHint: 'Set a token',
      requiredSecrets: ['SLACK_ACCESS_TOKEN'],
    });
    expect(action.suggested_command).toBeUndefined();
    expect(action.suggested_followup_request).toContain('SLACK_ACCESS_TOKEN');
  });
});
