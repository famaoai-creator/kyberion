import { describe, expect, it } from 'vitest';
import {
  cliCommandCredentialRequirement,
  missionActionCredentialRequirement,
} from './command-credential-policy.js';

describe('missionActionCredentialRequirement', () => {
  it('classifies journal and view verbs as none', () => {
    for (const action of [
      'help',
      'create',
      'start',
      'kickoff',
      'record-task',
      'record-evidence',
      'prepare-source-workspace',
      'review-task',
      'triage',
      'scope-approve',
      'verify',
      'distill',
      'finish',
      'review-worker-output',
      'list',
      'status',
      'outbox',
      'suggestions',
      'hygiene',
      'organization-catalogs',
      'organization-profiles',
      'organization-profile',
      'organization-discovery',
      'memory-queue',
      'memory-review',
      'memory-approve',
      'memory-reject',
    ]) {
      expect(missionActionCredentialRequirement(action), action).toBe('none');
    }
  });

  it('classifies optional-model verbs as degrading', () => {
    expect(missionActionCredentialRequirement('memory-promote')).toBe('degrading');
    expect(missionActionCredentialRequirement('memory-promote-pending')).toBe('degrading');
  });

  it('fails safe toward required for unknown or absent actions', () => {
    expect(missionActionCredentialRequirement(undefined)).toBe('required');
    expect(missionActionCredentialRequirement('--')).toBe('required');
    expect(missionActionCredentialRequirement('some-new-verb')).toBe('required');
    expect(missionActionCredentialRequirement('dispatch-workitems')).toBe('required');
  });
});

describe('cliCommandCredentialRequirement', () => {
  it('keeps readiness observations credential-free', () => {
    expect(cliCommandCredentialRequirement({ command: 'list' })).toBe('none');
    expect(cliCommandCredentialRequirement({ command: 'list', subcommand: '--check' })).toBe(
      'none'
    );
    expect(cliCommandCredentialRequirement({ command: 'task', subcommand: 'scenario' })).toBe(
      'none'
    );
    for (const subcommand of [undefined, 'help', 'status']) {
      expect(
        cliCommandCredentialRequirement({ command: 'calendar', subcommand }),
        `calendar ${subcommand}`
      ).toBe('none');
    }
    for (const subcommand of [undefined, 'help', 'status', 'latest-draft']) {
      expect(
        cliCommandCredentialRequirement({ command: 'email', subcommand }),
        `email ${subcommand}`
      ).toBe('none');
    }
  });

  it('keeps live operations and unknown commands required', () => {
    expect(cliCommandCredentialRequirement({ command: 'calendar', subcommand: 'agenda' })).toBe(
      'required'
    );
    expect(cliCommandCredentialRequirement({ command: 'email', subcommand: 'deliver' })).toBe(
      'required'
    );
    expect(cliCommandCredentialRequirement({ command: 'task', subcommand: 'plan' })).toBe(
      'required'
    );
    expect(cliCommandCredentialRequirement({ command: 'unlisted-verb' })).toBe('required');
  });
});
