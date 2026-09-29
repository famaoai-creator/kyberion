import { describe, expect, it } from 'vitest';
import { buildProfileSetupNextAction } from './setup_report.js';

describe('setup report onboarding action', () => {
  it('places an onboarding command when identity or profile artifacts are missing', () => {
    const action = buildProfileSetupNextAction({
      checks: [
        { id: 'sovereign_identity', label: 'Sovereign Identity', status: 'missing' },
        { id: 'agent_identity', label: 'Agent Identity', status: 'ok' },
        { id: 'sovereign_vision', label: 'Sovereign Vision', status: 'missing' },
        { id: 'onboarding_summary', label: 'Onboarding Summary', status: 'ok' },
      ],
    });

    expect(action).toMatchObject({
      title: 'Complete identity and onboarding profile',
      suggested_command: 'pnpm onboard',
    });
    expect(action?.reason).toContain('2 missing or invalid profile files');
  });

  it('does not recommend onboarding when all profile artifacts are ready', () => {
    expect(
      buildProfileSetupNextAction({
        checks: [
          { id: 'sovereign_identity', label: 'Sovereign Identity', status: 'ok' },
          { id: 'agent_identity', label: 'Agent Identity', status: 'ok' },
          { id: 'sovereign_vision', label: 'Sovereign Vision', status: 'ok' },
          { id: 'onboarding_summary', label: 'Onboarding Summary', status: 'ok' },
        ],
      })
    ).toBeUndefined();
  });
});
