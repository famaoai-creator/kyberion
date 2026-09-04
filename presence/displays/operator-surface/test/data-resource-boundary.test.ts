import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import {
  getMissionDetail,
  getProviderPins,
  listMissions,
  listRecentAuditEvents,
} from '../src/lib/data';

const suffix = `${process.pid}-${Date.now()}`;
const missionDir = pathResolver.rootResolve(`active/missions/public/MSN-BOUNDARY-${suffix}`);
const auditDir = pathResolver.rootResolve('active/audit');
const auditLink = path.join(auditDir, `boundary-${suffix}.jsonl`);
const auditFile = path.join(auditDir, `boundary-regular-${suffix}.jsonl`);
const missionTarget = pathResolver.sharedTmp(`operator-surface-${suffix}-mission-state.json`);
const auditTarget = pathResolver.sharedTmp(`operator-surface-${suffix}-audit.jsonl`);
const providerPinsDir = pathResolver.rootResolve('active/shared/runtime/provider-pins');
const providerPinsTarget = pathResolver.sharedTmp(`operator-surface-${suffix}-provider-pins.json`);
const providerPinsLink = path.join(providerPinsDir, `boundary-${suffix}.json`);
const providerPinsMalformed = path.join(providerPinsDir, `boundary-malformed-${suffix}.json`);
const evidenceTarget = pathResolver.sharedTmp(`operator-surface-${suffix}-evidence.json`);
const evidenceLink = path.join(missionDir, 'evidence', 'linked.json');

afterEach(() => {
  vi.unstubAllEnvs();
  withExecutionContext('mission_controller', () => {
    safeRmSync(missionDir, { recursive: true, force: true });
    safeRmSync(auditLink, { force: true });
    safeRmSync(auditFile, { force: true });
    safeRmSync(missionTarget, { force: true });
    safeRmSync(auditTarget, { force: true });
    safeRmSync(providerPinsTarget, { force: true });
    safeRmSync(providerPinsLink, { force: true });
    safeRmSync(providerPinsMalformed, { force: true });
    safeRmSync(evidenceTarget, { force: true });
  });
});

describe('operator surface resource boundaries', () => {
  it('does not project symlinked mission state or audit ledger files', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeMkdir(auditDir, { recursive: true });
      safeWriteFile(
        missionTarget,
        JSON.stringify({ mission_id: `MSN-BOUNDARY-${suffix}`, status: 'active' })
      );
      safeWriteFile(
        auditTarget,
        `${JSON.stringify({ id: `audit-${suffix}`, timestamp: new Date().toISOString(), action: 'linked' })}\n`
      );
      safeSymlinkSync(missionTarget, path.join(missionDir, 'mission-state.json'));
      safeSymlinkSync(auditTarget, auditLink);

      expect(
        listMissions().some((mission) => mission.mission_id === `MSN-BOUNDARY-${suffix}`)
      ).toBe(false);
      expect(listRecentAuditEvents().some((event) => event.id === `audit-${suffix}`)).toBe(false);
      expect(getMissionDetail(`MSN-BOUNDARY-${suffix}`)).toBeNull();
    });
  });

  it('skips malformed mission state without failing the projection', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(path.join(missionDir, 'mission-state.json'), '{malformed\n');

      expect(
        listMissions().some((mission) => mission.mission_id === `MSN-BOUNDARY-${suffix}`)
      ).toBe(false);
    });
  });

  it('projects schema-valid mission state through the canonical loader', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({
          mission_id: `MSN-BOUNDARY-${suffix}`,
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'operator',
          confidence_score: 1,
          git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
          history: [],
        })
      );

      expect(listMissions()).toContainEqual(
        expect.objectContaining({
          mission_id: `MSN-BOUNDARY-${suffix}`,
          status: 'active',
          tier: 'public',
        })
      );
      expect(getMissionDetail(`MSN-BOUNDARY-${suffix}`)).toMatchObject({
        mission_id: `MSN-BOUNDARY-${suffix}`,
        status: 'active',
        tier: 'public',
      });
    });
  });

  it('fails closed for malformed and tenantless audit events in a tenant scope', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    withExecutionContext('mission_controller', () => {
      safeMkdir(auditDir, { recursive: true });
      safeWriteFile(
        auditFile,
        [
          JSON.stringify({
            id: `audit-tenant-${suffix}`,
            timestamp: new Date().toISOString(),
            action: 'allowed',
            tenant_slug: 'tenant-a',
          }),
          JSON.stringify({
            id: `audit-other-${suffix}`,
            timestamp: new Date().toISOString(),
            action: 'hidden',
            tenant_slug: 'tenant-b',
          }),
          JSON.stringify({
            id: `audit-global-${suffix}`,
            timestamp: new Date().toISOString(),
            action: 'hidden',
          }),
          JSON.stringify({
            id: `audit-malformed-${suffix}`,
            timestamp: new Date().toISOString(),
            action: 'hidden',
            tenant_slug: { value: 'tenant-a' },
          }),
          JSON.stringify({
            id: `audit-dangerous-${suffix}`,
            timestamp: new Date().toISOString(),
            action: 'hidden',
            metadata: { nested: { constructor: { polluted: true } } },
          }),
        ].join('\n') + '\n'
      );

      const events = listRecentAuditEvents();
      expect(events.some((event) => event.id === `audit-tenant-${suffix}`)).toBe(true);
      expect(events.some((event) => event.id === `audit-other-${suffix}`)).toBe(false);
      expect(events.some((event) => event.id === `audit-global-${suffix}`)).toBe(false);
      expect(events.some((event) => event.id === `audit-malformed-${suffix}`)).toBe(false);
      expect(events.some((event) => event.id === `audit-dangerous-${suffix}`)).toBe(false);

      vi.stubEnv('KYBERION_TENANT', '');
      const unscopedEvents = listRecentAuditEvents();
      expect(unscopedEvents.some((event) => event.id === `audit-tenant-${suffix}`)).toBe(false);
      expect(unscopedEvents.some((event) => event.id === `audit-other-${suffix}`)).toBe(false);
      expect(unscopedEvents.some((event) => event.id === `audit-global-${suffix}`)).toBe(true);
    });
  });

  it('does not list symlinked mission evidence', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(path.join(missionDir, 'evidence'), { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({
          mission_id: `MSN-BOUNDARY-${suffix}`,
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'operator',
          confidence_score: 1,
          git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
          history: [],
        })
      );
      safeWriteFile(evidenceTarget, JSON.stringify({ linked: true }));
      safeSymlinkSync(evidenceTarget, evidenceLink);

      expect(getMissionDetail(`MSN-BOUNDARY-${suffix}`)?.evidence_files).toEqual([]);
    });
  });

  it('does not load symlinked provider pin projections', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(providerPinsDir, { recursive: true });
      safeWriteFile(providerPinsTarget, JSON.stringify({ pins: { boundary: 'linked' } }));
      safeSymlinkSync(providerPinsTarget, providerPinsLink);

      expect(getProviderPins()).not.toHaveProperty('boundary');
    });
  });

  it('does not project non-object provider pins', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(providerPinsDir, { recursive: true });
      safeWriteFile(providerPinsMalformed, JSON.stringify({ pins: ['unexpected'] }));

      expect(getProviderPins()).not.toHaveProperty('0');
    });
  });
});
