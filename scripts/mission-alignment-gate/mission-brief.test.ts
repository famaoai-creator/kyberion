import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  formatFactoryDelivery,
  isStrictRequirementsFramingEnabled,
  loadMissionBriefAtPath,
  validateFactoryDeliveryConfig,
  validateStrictMissionBriefFraming,
} from './mission-brief.js';

const root = pathResolver.sharedTmp(`mission-brief-loader-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

function writeBrief(value: unknown): string {
  safeMkdir(root, { recursive: true });
  const filePath = path.join(root, 'mission-brief.json');
  safeWriteFile(filePath, JSON.stringify(value), { encoding: 'utf8' });
  return filePath;
}

describe('mission brief canonical loader', () => {
  it('loads a partial brief and preserves example-compatible scalar types', () => {
    const filePath = writeBrief({
      missionId: 'MSN-LOADER',
      gate: { sudoGate: false, riskLevel: 3 },
      risks: [{ risk: 'drift', level: 3 }],
    });

    expect(loadMissionBriefAtPath(filePath)).toEqual({
      missionId: 'MSN-LOADER',
      gate: { sudoGate: false, riskLevel: 3 },
      risks: [{ risk: 'drift', level: 3 }],
    });
  });

  it('rejects unknown fields before a brief can be approved or rendered', () => {
    const filePath = writeBrief({ missionId: 'MSN-LOADER', unexpected: true });

    expect(() => loadMissionBriefAtPath(filePath)).toThrow(/Invalid catalog mission-brief/u);
  });

  it('loads opt-in requirementsGovernance and checks strict framing fields', () => {
    const incompletePath = writeBrief({
      missionId: 'MSN-STRICT-1',
      intent: 'Improve loop traceability',
      victoryConditions: ['All checks pass'],
      requirementsGovernance: {
        strictFraming: true,
        changeLevelRouting: true,
        maturityLevel: 3,
      },
    });
    const incomplete = loadMissionBriefAtPath(incompletePath);
    expect(isStrictRequirementsFramingEnabled(incomplete)).toBe(true);
    expect(isStrictRequirementsFramingEnabled(incomplete, false)).toBe(false);
    const incompleteCheck = validateStrictMissionBriefFraming(incomplete);
    expect(incompleteCheck.ok).toBe(false);
    expect(incompleteCheck.missing).toEqual([
      'scope.in',
      'scope.out',
      'deliverables',
      'assumptions_or_risks',
    ]);

    const completePath = writeBrief({
      missionId: 'MSN-STRICT-2',
      intent: 'Improve loop traceability',
      victoryConditions: ['All checks pass'],
      scope: { in: ['libs/core/mission'], out: ['unrelated surfaces'] },
      deliverables: ['mission-reentry-routing.ts'],
      requirementsGovernance: {
        strictFraming: true,
        assumptions: ['Existing legacy missions stay opt-out by default'],
        maturityLevel: 3,
      },
    });
    const complete = loadMissionBriefAtPath(completePath);
    expect(validateStrictMissionBriefFraming(complete)).toEqual({
      ok: true,
      missing: [],
      reasons: [],
    });
  });

  it('loads and validates optional factoryDelivery 1-shot delegation config', () => {
    const validPath = writeBrief({
      missionId: 'MSN-FACTORY-BRIEF-1',
      factoryDelivery: {
        enabled: true,
        branch: 'agent/factory-brief-01',
        mergeMode: 'veto_window',
        maxCiRepairAttempts: 2,
        allowedPaths: ['docs/**', 'libs/core/example.ts'],
      },
    });
    const brief = loadMissionBriefAtPath(validPath);
    expect(validateFactoryDeliveryConfig(brief)).toEqual({ ok: true, reasons: [] });
    const disclosure = formatFactoryDelivery(brief);
    expect(disclosure).toContain('Factory Delivery Delegation:');
    expect(disclosure).toContain('agent/factory-brief-01');
    expect(disclosure).toContain('veto_window');

    const badBranchPath = writeBrief({
      missionId: 'MSN-FACTORY-BRIEF-2',
      factoryDelivery: {
        enabled: true,
        branch: 'main',
        allowedPaths: ['docs/**'],
      },
    });
    expect(() => loadMissionBriefAtPath(badBranchPath)).toThrow(/Invalid catalog mission-brief/u);

    const incompleteDelegationPath = writeBrief({
      missionId: 'MSN-FACTORY-BRIEF-3',
      factoryDelivery: {
        enabled: true,
      },
    });
    const incomplete = loadMissionBriefAtPath(incompleteDelegationPath);
    const validation = validateFactoryDeliveryConfig(incomplete);
    expect(validation.ok).toBe(false);
    expect(validation.reasons.join(' ')).toContain('factoryDelivery.branch');
    expect(validation.reasons.join(' ')).toContain('factoryDelivery.allowedPaths');

    expect(
      validateFactoryDeliveryConfig({
        missionId: 'MSN-FACTORY-BRIEF-4',
        factoryDelivery: {
          enabled: true,
          branch: 'agent/factory-brief-04',
          allowedPaths: ['../outside/**'],
        },
      }).ok
    ).toBe(false);
    expect(formatFactoryDelivery({ missionId: 'MSN-NO-DELEGATION' })).toBeUndefined();
  });
});
