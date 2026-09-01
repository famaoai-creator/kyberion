import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { resolveIntentToTrackPolicy, resolveIntentTrackGate } from './intent-track-resolver.js';

const TMP_ROOT = pathResolver.sharedTmp('intent-track-resolver-tests');
const OVERRIDE_PATH = `${TMP_ROOT}/track-policy-override.json`;
const TRACK_PATH = pathResolver.shared('runtime/project-tracks/TRK-TEST-INTENT-DELIVERY.json');

function cleanup() {
  if (safeExistsSync(OVERRIDE_PATH)) safeRmSync(OVERRIDE_PATH, { force: true });
  if (safeExistsSync(TRACK_PATH)) safeRmSync(TRACK_PATH, { force: true });
}

describe('intent-track-resolver', () => {
  beforeEach(() => {
    cleanup();
  });

  it('resolves a high-confidence delivery intent with policy overrides', async () => {
    safeWriteFile(
      OVERRIDE_PATH,
      JSON.stringify(
        {
          track_types: {
            delivery: {
              entry_criteria: ['tenant approval captured'],
            },
          },
        },
        null,
        2
      )
    );

    const policy = await resolveIntentToTrackPolicy('request-feature-development', 'tenant/a', [
      OVERRIDE_PATH,
    ]);

    expect(policy.track_type).toBe('delivery');
    expect(policy.lifecycle_model).toBe('default-sdlc');
    expect(policy.track_type_policy.entry_criteria).toContain('tenant approval captured');
    expect(policy.lifecycle_policy.gates_per_phase.define).toContain('gate-requirements-baseline');
    expect(policy.override_paths).toEqual([OVERRIDE_PATH]);
  });

  it('requires escalation below the policy confidence threshold', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'request-feature-development',
      confidence: 0.5,
      projectId: 'PRJ-TEST-INTENT',
      persist: false,
    });

    expect(result.status).toBe('escalation_required');
    if (result.status === 'escalation_required') {
      expect(result.min_confidence_to_autostart).toBe(0.75);
    }
    expect(safeExistsSync(TRACK_PATH)).toBe(false);
  });

  it('rejects override paths outside the repository or through symlinks', async () => {
    await expect(
      resolveIntentToTrackPolicy('request-feature-development', undefined, [
        path.resolve(pathResolver.rootDir(), '..', 'outside-policy.json'),
      ])
    ).rejects.toThrow('TRACK_POLICY_SCOPE');

    const link = path.join(TMP_ROOT, 'linked-policy.json');
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    fs.symlinkSync('/tmp', link);
    try {
      await expect(
        resolveIntentToTrackPolicy('request-feature-development', undefined, [
          path.join(link, 'track-policy-override.json'),
        ])
      ).rejects.toThrow('TRACK_POLICY_SCOPE');
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('builds a project-track-compatible record when the gate passes', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'request-feature-development',
      confidence: 0.9,
      projectId: 'PRJ-TEST-INTENT',
      missionId: 'MSN-TEST-INTENT',
      title: 'Intent track fixture',
      persist: true,
    });

    expect(result.status).toBe('ready_to_provision');
    if (result.status !== 'ready_to_provision') return;
    expect(result.track_record.track_id).toBe('TRK-TEST-INTENT-DELIVERY');
    expect(result.track_record.track_type).toBe('delivery');
    expect(result.track_record.lifecycle_model).toBe('sdlc');
    expect(result.track_record.metadata?.logical_lifecycle_model).toBe('default-sdlc');
    expect(result.relationship.track.traceability_refs).toContain(
      'intent:request-feature-development'
    );
    expect(JSON.parse(String(safeReadFile(TRACK_PATH))).track_id).toBe('TRK-TEST-INTENT-DELIVERY');
  });

  it('normalizes governance track intents to compliance project tracks', async () => {
    for (const intentId of ['define-engineering-governance', 'define-operational-process']) {
      const result = await resolveIntentTrackGate({
        intentId,
        confidence: 0.9,
        projectId: 'PRJ-TEST-GOVERNANCE',
        persist: false,
      });

      expect(result.status).toBe('ready_to_provision');
      if (result.status !== 'ready_to_provision') continue;
      expect(result.track_record.track_type).toBe('compliance');
      expect(result.track_record.lifecycle_model).toBe('sdlc');
      expect(result.track_record.metadata?.logical_lifecycle_model).toBe('governance-sdlc');
    }
  });

  it('rejects unknown intent ids', async () => {
    await expect(resolveIntentToTrackPolicy('unknown-intent')).rejects.toThrow(
      'No track intent policy mapping for intent: unknown-intent'
    );
  });
});
