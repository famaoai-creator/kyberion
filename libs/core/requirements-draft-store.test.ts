import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    missionEvidenceDir: vi.fn(),
  };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'public',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { missionEvidenceDir } from './path-resolver.js';
import {
  evaluateCustomerSignoffGate,
  evaluateRequirementsCompletenessGate,
  readRequirementsDraft,
  readRequirementsDraftAtPath,
  recordCustomerSignoff,
  saveRequirementsDraft,
  writeRequirementsDraftAtPath,
} from './requirements-draft-store.js';
import type { ExtractedRequirements } from './reasoning-backend.js';

const sampleExtracted: ExtractedRequirements = {
  functional_requirements: [
    {
      id: 'FR-1',
      description: 'ユーザーが音声で打ち合わせの要約を受け取れること',
      priority: 'must',
      acceptance_criteria: ['要約は 3 分以内に配信される'],
    },
  ],
  non_functional_requirements: [
    {
      id: 'NFR-1',
      category: 'availability',
      description: '営業時間中の可用性は 99% 以上',
      target: '99%',
    },
  ],
  constraints: [{ category: 'timeline', description: '初版は 2 週間以内' }],
  assumptions: [],
  open_questions: [],
};

describe('requirements-draft-store', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = pathResolver.sharedTmp(`req-draft-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    (missionEvidenceDir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('save / read', () => {
    it('persists a draft and reads it back', () => {
      const saved = saveRequirementsDraft({
        missionId: 'MSN-1',
        projectName: 'A 社 案件',
        extracted: sampleExtracted,
        customer: { org: 'A 社', person_slug: 'a-sha-tanaka' },
        generatedBy: 'stub',
      });
      expect(saved.version).toBe('v1');
      expect(saved.functional_requirements).toHaveLength(1);
      expect(saved.generated_by).toBe('stub');

      const read = readRequirementsDraft('MSN-1');
      expect(read?.project_name).toBe('A 社 案件');
    });

    it('bumps version when saving a second draft for the same mission', () => {
      saveRequirementsDraft({ missionId: 'MSN-2', projectName: 'X', extracted: sampleExtracted });
      const second = saveRequirementsDraft({
        missionId: 'MSN-2',
        projectName: 'X',
        extracted: sampleExtracted,
      });
      expect(second.version).toBe('v2');
    });

    it('returns null when no draft exists', () => {
      expect(readRequirementsDraft('MSN-MISSING')).toBeNull();
    });

    it('rejects a schema-invalid persisted draft', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'requirements-draft.json'),
        JSON.stringify({ version: 'v1', project_name: 'X', functional_requirements: [] })
      );

      expect(() => readRequirementsDraft('MSN-INVALID')).toThrow(
        /Invalid catalog requirements-draft/
      );
    });

    it('loads an explicitly supplied draft through the same schema boundary', () => {
      const file = path.join(tmpDir, 'explicit-requirements-draft.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 'v1',
          project_name: 'Explicit project',
          ...sampleExtracted,
          generated_at: new Date().toISOString(),
        })
      );

      expect(readRequirementsDraftAtPath(file)?.project_name).toBe('Explicit project');
    });

    it('rejects a schema-invalid explicitly supplied draft', () => {
      const file = path.join(tmpDir, 'explicit-invalid-requirements-draft.json');
      fs.writeFileSync(file, JSON.stringify({ version: 'v1', project_name: 'Broken' }));

      expect(() => readRequirementsDraftAtPath(file)).toThrow(/Invalid catalog requirements-draft/);
    });

    it('preserves the parse error contract for malformed drafts', () => {
      fs.writeFileSync(path.join(tmpDir, 'requirements-draft.json'), '{ malformed');

      expect(() => readRequirementsDraft('MSN-MALFORMED')).toThrow(SyntaxError);
    });

    it('rejects a symlinked mission evidence directory before reading', () => {
      const boundaryRoot = pathResolver.sharedTmp('requirements-draft-boundary');
      const targetDir = path.join(boundaryRoot, 'target');
      const linkedDir = path.join(boundaryRoot, 'linked');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'requirements-draft.json'),
        JSON.stringify({ version: 'v1', project_name: 'outside' })
      );
      fs.symlinkSync(targetDir, linkedDir, 'dir');
      (missionEvidenceDir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(linkedDir);

      try {
        expect(() => readRequirementsDraft('MSN-SYMLINK')).toThrow('[RESOURCE_PATH_SYMLINK]');
        expect(fs.existsSync(path.join(targetDir, 'requirements-draft.json'))).toBe(true);
      } finally {
        fs.rmSync(boundaryRoot, { recursive: true, force: true });
      }
    });
  });

  describe('recordCustomerSignoff', () => {
    it('marks the draft as signed off', () => {
      saveRequirementsDraft({ missionId: 'MSN-3', projectName: 'X', extracted: sampleExtracted });
      const after = recordCustomerSignoff({
        missionId: 'MSN-3',
        signedBy: '田中様 (A 社)',
        channel: 'email',
        notes: 'メールで確認済',
      });
      expect(after.stakeholder_signoff?.customer_signed_off).toBe(true);
      expect(after.stakeholder_signoff?.signed_by).toContain('A 社');
    });

    it('throws when no draft exists', () => {
      expect(() =>
        recordCustomerSignoff({
          missionId: 'MSN-NOPE',
          signedBy: 'x',
          channel: 'email',
        })
      ).toThrow(/no draft found/);
    });
  });

  it('persists the catalog-normalized draft payload', () => {
    const file = path.join(tmpDir, 'normalized-requirements-draft.json');
    const draft = {
      version: 'v1',
      project_name: 'X',
      functional_requirements: sampleExtracted.functional_requirements,
      generated_at: '2026-09-04T00:00:00.000Z',
      $schema: 'governance-metadata',
    } as unknown as Parameters<typeof writeRequirementsDraftAtPath>[1];

    const persisted = writeRequirementsDraftAtPath(file, draft);

    expect(persisted).not.toHaveProperty('$schema');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('$schema');
  });

  describe('evaluateRequirementsCompletenessGate', () => {
    it('passes when FRs exist with acceptance_criteria and no open questions', () => {
      saveRequirementsDraft({ missionId: 'MSN-G1', projectName: 'X', extracted: sampleExtracted });
      const result = evaluateRequirementsCompletenessGate('MSN-G1');
      expect(result.passed).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('fails when a must-have FR has no acceptance_criteria', () => {
      saveRequirementsDraft({
        missionId: 'MSN-G2',
        projectName: 'X',
        extracted: {
          ...sampleExtracted,
          functional_requirements: [{ id: 'FR-1', description: '必須機能', priority: 'must' }],
        },
      });
      const result = evaluateRequirementsCompletenessGate('MSN-G2');
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes('acceptance_criteria'))).toBe(true);
    });

    it('fails when there are open questions', () => {
      saveRequirementsDraft({
        missionId: 'MSN-G3',
        projectName: 'X',
        extracted: {
          ...sampleExtracted,
          open_questions: [{ question: '予算上限は？', status: 'open', blocking: true }],
        },
      });
      const result = evaluateRequirementsCompletenessGate('MSN-G3');
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes('open question'))).toBe(true);
    });

    it('ignores non-blocking open questions', () => {
      saveRequirementsDraft({
        missionId: 'MSN-G4',
        projectName: 'X',
        extracted: {
          ...sampleExtracted,
          open_questions: [{ question: '任意の補足情報', status: 'open', blocking: false }],
        },
      });
      const result = evaluateRequirementsCompletenessGate('MSN-G4');
      expect(result.passed).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('fails when no draft exists', () => {
      const result = evaluateRequirementsCompletenessGate('MSN-NONE');
      expect(result.passed).toBe(false);
    });
  });

  describe('evaluateCustomerSignoffGate', () => {
    it('fails before signoff', () => {
      saveRequirementsDraft({ missionId: 'MSN-S1', projectName: 'X', extracted: sampleExtracted });
      expect(evaluateCustomerSignoffGate('MSN-S1').passed).toBe(false);
    });

    it('passes after signoff is recorded', () => {
      saveRequirementsDraft({ missionId: 'MSN-S2', projectName: 'X', extracted: sampleExtracted });
      recordCustomerSignoff({
        missionId: 'MSN-S2',
        signedBy: 'customer-lead',
        channel: 'docusign',
      });
      expect(evaluateCustomerSignoffGate('MSN-S2').passed).toBe(true);
    });
  });
});
