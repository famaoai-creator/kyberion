import { describe, expect, it } from 'vitest';
import type { EnvironmentManifest } from '@agent/core';
import { classifyDoctorDomains, classifyDoctorSeverity, formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

describe('environment-doctor', () => {
  it('classifies critical meeting/bootstrap capabilities as must and optional runtime knobs as nice', () => {
    expect(
      classifyDoctorSeverity({
        capability_id: 'node-runtime',
        kind: 'binary',
        description: 'node',
        required_for: ['all-of-kyberion'],
        probe: { kind: 'command', command: 'node' },
      }),
    ).toBe('must');
    expect(
      classifyDoctorSeverity({
        capability_id: 'voice-consent',
        kind: 'mission-evidence',
        description: 'voice consent',
        required_for: ['meeting-actuator.speak'],
        probe: { kind: 'mission-evidence', filename: 'voice-consent.json' },
      }),
    ).toBe('must');
    expect(
      classifyDoctorSeverity({
        capability_id: 'stt-command',
        kind: 'env-var',
        description: 'stt command',
        required_for: ['streaming-stt'],
        optional: true,
        probe: { kind: 'env', name: 'KYBERION_STT_COMMAND' },
      }),
    ).toBe('nice');
  });

  it('groups missing capabilities into a concise doctor summary', () => {
    const manifest: EnvironmentManifest = {
      manifest_id: 'meeting-participation-runtime',
      version: 'test',
      capabilities: [
        {
          capability_id: 'playwright-chromium',
          kind: 'npm-package',
          description: 'browser',
          required_for: ['browser-meeting-join-driver'],
          probe: { kind: 'module', specifier: 'playwright' },
        },
        {
          capability_id: 'stt-command',
          kind: 'env-var',
          description: 'stt',
          required_for: ['streaming-stt'],
          optional: true,
          probe: { kind: 'env', name: 'KYBERION_STT_COMMAND' },
        },
      ],
    };
    const summary = summarizeManifestDoctor(manifest, [
      {
        capability_id: 'playwright-chromium',
        satisfied: false,
        reason: 'cannot import playright',
      },
      {
        capability_id: 'stt-command',
        satisfied: false,
        reason: 'env var KYBERION_STT_COMMAND is unset',
      },
    ]);
    expect(summary.counts.must).toBe(1);
    expect(summary.counts.nice).toBe(1);
    const lines = formatDoctorSummary(summary);
    expect(lines.join('\n')).toContain('must=1 should=0 nice=1');
    expect(lines.join('\n')).toContain('[browser,meeting]');
    expect(lines.join('\n')).toContain('[voice]');
    expect(lines.join('\n')).toContain('playwright-chromium');
    expect(lines.join('\n')).toContain('stt-command');
  });

  it('classifies meeting runtime gaps by meeting, voice, browser, and audio domains', () => {
    expect(
      classifyDoctorDomains({
        capability_id: 'playwright-chromium',
        kind: 'npm-package',
        description: 'browser automation',
        required_for: ['browser-meeting-join-driver'],
        probe: { kind: 'module', specifier: 'playwright' },
      }),
    ).toEqual(['browser', 'meeting']);
    expect(
      classifyDoctorDomains({
        capability_id: 'voice-consent',
        kind: 'mission-evidence',
        description: 'voice consent',
        required_for: ['meeting-actuator.speak'],
        probe: { kind: 'mission-evidence', filename: 'voice-consent.json' },
      }),
    ).toEqual(['meeting', 'voice']);
    expect(
      classifyDoctorDomains({
        capability_id: 'ffmpeg',
        kind: 'binary',
        description: 'audio bridge dependency',
        required_for: ['blackhole-audio-bus'],
        probe: { kind: 'command', command: 'ffmpeg' },
      }),
    ).toEqual(['audio']);
  });
});
