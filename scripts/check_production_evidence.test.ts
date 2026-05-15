import { describe, expect, it } from 'vitest';
import {
  checkProductionEvidenceRegister,
  isValidEvidenceRef,
  loadProductionEvidenceRegister,
  REQUIRED_PRODUCTION_EVIDENCE_IDS,
  type ProductionEvidenceRegister,
} from './check_production_evidence.js';

function verifiedRegister(): ProductionEvidenceRegister {
  const register = loadProductionEvidenceRegister();
  return {
    ...register,
    release_decision: 'verified',
    items: register.items.map((item) => ({
      ...item,
      status: 'verified',
      reviewed_at: '2026-05-15',
      reviewer: 'release-owner',
      evidence_refs: verifiedEvidenceRefsFor(item.id),
    })),
  };
}

function verifiedEvidenceRefsFor(id: string): string[] {
  if (id === 'EV-30DAY-OPS') {
    return [
      'docs/operator/templates/production-evidence-30day-ops.md',
      'active/shared/logs/traces/',
      'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
    ];
  }
  if (id === 'EV-EXT-CONTRIB') {
    return [
      'docs/operator/templates/production-evidence-external-contribution.md',
      'https://github.com/famaoai-creator/kyberion/issues/1',
      'https://github.com/famaoai-creator/kyberion/pull/1',
    ];
  }
  return [
    'docs/operator/templates/production-evidence-fde-deployment.md',
    'docs/operator/DEPLOYMENT.md',
    'active/shared/tmp/first-win-session.png',
    'migration/README.md',
  ];
}

describe('production evidence checker', () => {
  it('passes the default register check while reporting pending external evidence', () => {
    const register = loadProductionEvidenceRegister();
    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(true);
    expect(summary.complete).toBe(false);
    expect(summary.pending.map((item) => item.id)).toEqual([...REQUIRED_PRODUCTION_EVIDENCE_IDS]);
    expect(register.items.map((item) => item.template_ref)).toEqual([
      'docs/operator/templates/production-evidence-30day-ops.md',
      'docs/operator/templates/production-evidence-external-contribution.md',
      'docs/operator/templates/production-evidence-fde-deployment.md',
    ]);
    expect(register.items.every((item) => item.acceptance_criteria.length > 0)).toBe(true);
  });

  it('requires the register version to use MAJOR.MINOR.PATCH', () => {
    const register = loadProductionEvidenceRegister();
    register.version = 'release-candidate';

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('register.version must be MAJOR.MINOR.PATCH');
  });

  it('requires register version to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.version = '   ';

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('register.version is required');
  });

  it('requires evidence item owners to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      owner: '   ',
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.owner is required');
  });

  it('requires evidence item gate, required evidence, and verification artifact to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      gate: '   ',
      required_evidence: '   ',
      verification_artifact: '   ',
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.gate is required');
    expect(summary.invalid).toContain('EV-30DAY-OPS.required_evidence is required');
    expect(summary.invalid).toContain('EV-30DAY-OPS.verification_artifact is required');
  });

  it('requires item ids and ref requirement ids to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      ref_requirements: [
        {
          ...register.items[0].ref_requirements[0],
          id: '   ',
        },
        ...register.items[0].ref_requirements.slice(1),
      ],
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.ref_requirements.id is required');
  });

  it('requires item ids to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      id: '   ',
      ref_requirements: [
        ...register.items[0].ref_requirements,
      ],
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('item.id is required');
  });

  it('fails the promotion gate while external evidence is pending', () => {
    const register = loadProductionEvidenceRegister();
    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.complete).toBe(false);
  });

  it('rejects a verified release decision while any evidence item is pending', () => {
    const register = {
      ...loadProductionEvidenceRegister(),
      release_decision: 'verified' as const,
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('register.release_decision cannot be verified while evidence items are pending');
  });

  it('rejects a pending release decision once every evidence item is verified', () => {
    const register = {
      ...verifiedRegister(),
      release_decision: 'pending_external_evidence' as const,
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('register.release_decision must be verified when all evidence items are verified');
  });

  it('allows promotion when all evidence items are reviewed and verified', () => {
    const summary = checkProductionEvidenceRegister(verifiedRegister(), { requireComplete: true });

    expect(summary.ok).toBe(true);
    expect(summary.complete).toBe(true);
    expect(summary.pending).toEqual([]);
  });

  it('rejects malformed or future reviewed_at dates for verified evidence', () => {
    const malformed = verifiedRegister();
    malformed.items[0] = {
      ...malformed.items[0],
      reviewed_at: '2026/05/15',
    };

    const malformedSummary = checkProductionEvidenceRegister(malformed, { requireComplete: true });

    expect(malformedSummary.ok).toBe(false);
    expect(malformedSummary.invalid).toContain('EV-30DAY-OPS.reviewed_at must be an ISO date that is not in the future');

    const impossible = verifiedRegister();
    impossible.items[0] = {
      ...impossible.items[0],
      reviewed_at: '2026-00-00',
    };

    const impossibleSummary = checkProductionEvidenceRegister(impossible, { requireComplete: true });

    expect(impossibleSummary.ok).toBe(false);
    expect(impossibleSummary.invalid).toContain('EV-30DAY-OPS.reviewed_at must be an ISO date that is not in the future');

    const future = verifiedRegister();
    future.items[0] = {
      ...future.items[0],
      reviewed_at: '2999-01-01',
    };

    const futureSummary = checkProductionEvidenceRegister(future, { requireComplete: true });

    expect(futureSummary.ok).toBe(false);
    expect(futureSummary.invalid).toContain('EV-30DAY-OPS.reviewed_at must be an ISO date that is not in the future');
  });

  it('rejects verified evidence that points at missing local artifacts', () => {
    const malformed = verifiedRegister();
    malformed.items[0] = {
      ...malformed.items[0],
      evidence_refs: [
        'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
        'active/shared/tmp/does-not-exist.txt',
        'https://example.com/evidence/trace-bundle.zip',
      ],
    };

    const summary = checkProductionEvidenceRegister(malformed, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain(
      'EV-30DAY-OPS.evidence_refs missing existing local artifact: active/shared/tmp/does-not-exist.txt',
    );
  });

  it('rejects blank reviewer values for verified evidence', () => {
    const register = verifiedRegister();
    register.items[0] = {
      ...register.items[0],
      reviewer: '   ',
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.reviewer is required when verified');
  });

  it('rejects malformed or future register last_updated dates', () => {
    const malformed = loadProductionEvidenceRegister();
    malformed.last_updated = '2026/05/15';

    const malformedSummary = checkProductionEvidenceRegister(malformed);

    expect(malformedSummary.ok).toBe(false);
    expect(malformedSummary.invalid).toContain('register.last_updated must be an ISO date that is not in the future');

    const impossible = loadProductionEvidenceRegister();
    impossible.last_updated = '2026-02-31';

    const impossibleSummary = checkProductionEvidenceRegister(impossible);

    expect(impossibleSummary.ok).toBe(false);
    expect(impossibleSummary.invalid).toContain('register.last_updated must be an ISO date that is not in the future');

    const future = loadProductionEvidenceRegister();
    future.last_updated = '2999-01-01';

    const futureSummary = checkProductionEvidenceRegister(future);

    expect(futureSummary.ok).toBe(false);
    expect(futureSummary.invalid).toContain('register.last_updated must be an ISO date that is not in the future');
  });

  it('rejects verified evidence refs that are neither URLs nor existing repo-local artifacts', () => {
    const register = verifiedRegister();
    register.items[0] = {
      ...register.items[0],
      evidence_refs: ['artifact:EV-30DAY-OPS'],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain(
      'EV-30DAY-OPS.evidence_refs contains unsupported or missing artifact: artifact:EV-30DAY-OPS'
    );
  });

  it('rejects verified evidence refs with surrounding whitespace', () => {
    const register = verifiedRegister();
    register.items[0] = {
      ...register.items[0],
      evidence_refs: [
        ' docs/operator/templates/production-evidence-30day-ops.md ',
        'active/shared/logs/traces/',
        'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
      ],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain(
      'EV-30DAY-OPS.evidence_refs contains artifact with surrounding whitespace:  docs/operator/templates/production-evidence-30day-ops.md '
    );
  });

  it('requires verified items to include the runbook minimum evidence refs', () => {
    const register = verifiedRegister();
    register.items[2] = {
      ...register.items[2],
      evidence_refs: ['docs/operator/templates/production-evidence-fde-deployment.md'],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-FDE-DEPLOY.evidence_refs must include at least 4 artifacts when verified');
  });

  it('rejects duplicate verified evidence refs', () => {
    const register = verifiedRegister();
    register.items[2] = {
      ...register.items[2],
      evidence_refs: [
        'docs/operator/templates/production-evidence-fde-deployment.md',
        'docs/operator/DEPLOYMENT.md',
        'active/shared/tmp/first-win-session.png',
        'migration/README.md',
        'migration/README.md',
      ],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-FDE-DEPLOY.evidence_refs contains duplicate artifact: migration/README.md');
  });

  it('requires verified evidence refs to satisfy each item category', () => {
    const register = verifiedRegister();
    register.items[1] = {
      ...register.items[1],
      evidence_refs: [
        'docs/operator/templates/production-evidence-external-contribution.md',
        'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
        'docs/operator/README.md',
      ],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-EXT-CONTRIB.evidence_refs missing required category: issue_url');
    expect(summary.invalid).toContain('EV-EXT-CONTRIB.evidence_refs missing required category: pr_url');
  });

  it('requires verified evidence categories to use distinct artifacts', () => {
    const register = verifiedRegister();
    register.items[0] = {
      ...register.items[0],
      evidence_refs: [
        'docs/operator/templates/production-evidence-30day-ops.md',
        'active/shared/logs/traces/',
        'active/shared/tmp/first-win-session.png',
      ],
    };

    const summary = checkProductionEvidenceRegister(register, { requireComplete: true });

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.evidence_refs missing distinct required category: incident_summary');
  });

  it('distinguishes external contribution issue URLs from PR URLs', () => {
    const onlyIssue = verifiedRegister();
    onlyIssue.items[1] = {
      ...onlyIssue.items[1],
      evidence_refs: [
        'https://github.com/famaoai-creator/kyberion/issues/1',
        'https://github.com/famaoai-creator/kyberion/issues/2',
        'docs/operator/templates/production-evidence-external-contribution.md',
      ],
    };

    const onlyIssueSummary = checkProductionEvidenceRegister(onlyIssue, { requireComplete: true });

    expect(onlyIssueSummary.ok).toBe(false);
    expect(onlyIssueSummary.invalid).toContain('EV-EXT-CONTRIB.evidence_refs missing required category: pr_url');

    const onlyPr = verifiedRegister();
    onlyPr.items[1] = {
      ...onlyPr.items[1],
      evidence_refs: [
        'https://github.com/famaoai-creator/kyberion/pull/1',
        'https://github.com/famaoai-creator/kyberion/pull/2',
        'docs/operator/templates/production-evidence-external-contribution.md',
      ],
    };

    const onlyPrSummary = checkProductionEvidenceRegister(onlyPr, { requireComplete: true });

    expect(onlyPrSummary.ok).toBe(false);
    expect(onlyPrSummary.invalid).toContain('EV-EXT-CONTRIB.evidence_refs missing required category: issue_url');
  });

  it('requires ref requirements to be present and unique', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      ref_requirements: [
        ...register.items[0].ref_requirements,
        register.items[0].ref_requirements[0],
      ],
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.ref_requirements contains duplicate id: run_summary');
  });

  it('requires each evidence item to keep its canonical ref requirement categories', () => {
    const missing = loadProductionEvidenceRegister();
    missing.items[0] = {
      ...missing.items[0],
      ref_requirements: missing.items[0].ref_requirements.filter((requirement) => requirement.id !== 'incident_summary'),
    };

    const missingSummary = checkProductionEvidenceRegister(missing);

    expect(missingSummary.ok).toBe(false);
    expect(missingSummary.invalid).toContain('EV-30DAY-OPS.ref_requirements missing required category id: incident_summary');

    const unknown = loadProductionEvidenceRegister();
    unknown.items[1] = {
      ...unknown.items[1],
      ref_requirements: [
        ...unknown.items[1].ref_requirements,
        {
          id: 'misc_url',
          description: 'Non-canonical evidence URL',
          accepted_ref_patterns: ['https://'],
        },
      ],
    };

    const unknownSummary = checkProductionEvidenceRegister(unknown);

    expect(unknownSummary.ok).toBe(false);
    expect(unknownSummary.invalid).toContain('EV-EXT-CONTRIB.ref_requirements contains unknown category id: misc_url');
  });

  it('requires each canonical ref requirement to keep its accepted ref patterns', () => {
    const register = loadProductionEvidenceRegister();
    register.items[1] = {
      ...register.items[1],
      ref_requirements: register.items[1].ref_requirements.map((requirement) =>
        requirement.id === 'issue_url'
          ? {
              ...requirement,
              accepted_ref_patterns: ['https://github.com/'],
            }
          : requirement
      ),
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-EXT-CONTRIB.issue_url.accepted_ref_patterns must be /issues/');
  });

  it('requires accepted ref patterns to be nonblank strings', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      ref_requirements: register.items[0].ref_requirements.map((requirement) =>
        requirement.id === 'run_summary'
          ? {
              ...requirement,
              accepted_ref_patterns: ['   '],
            }
          : requirement
      ),
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.run_summary.accepted_ref_patterns contains an empty pattern');
  });

  it('requires ref requirement descriptions to be nonblank strings', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      ref_requirements: register.items[0].ref_requirements.map((requirement) =>
        requirement.id === 'run_summary'
          ? {
              ...requirement,
              description: '   ',
            }
          : requirement
      ),
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.run_summary.description is required');
  });

  it('requires template refs to point at existing repo-local templates', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      template_ref: 'docs/operator/templates/missing-template.md',
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.template_ref must point to an existing repo-local template');
  });

  it('requires template refs to be nonblank', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      template_ref: '   ',
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.template_ref is required');
  });

  it('requires each canonical evidence id to use its matching template ref', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      template_ref: 'docs/operator/templates/production-evidence-fde-deployment.md',
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain(
      'EV-30DAY-OPS.template_ref must be docs/operator/templates/production-evidence-30day-ops.md'
    );
  });

  it('requires each evidence item to carry acceptance criteria', () => {
    const register = loadProductionEvidenceRegister();
    register.items[0] = {
      ...register.items[0],
      acceptance_criteria: [],
    };

    const summary = checkProductionEvidenceRegister(register);

    expect(summary.ok).toBe(false);
    expect(summary.invalid).toContain('EV-30DAY-OPS.acceptance_criteria must include at least one criterion');
  });

  it('requires the canonical production evidence id set', () => {
    const missing = loadProductionEvidenceRegister();
    missing.items = missing.items.filter((item) => item.id !== 'EV-FDE-DEPLOY');

    const missingSummary = checkProductionEvidenceRegister(missing);

    expect(missingSummary.ok).toBe(false);
    expect(missingSummary.invalid).toContain('register.items missing required evidence id: EV-FDE-DEPLOY');

    const unknown = loadProductionEvidenceRegister();
    unknown.items = [
      ...unknown.items,
      {
        ...unknown.items[0],
        id: 'EV-UNTRACKED',
      },
    ];

    const unknownSummary = checkProductionEvidenceRegister(unknown);

    expect(unknownSummary.ok).toBe(false);
    expect(unknownSummary.invalid).toContain('register.items contains unknown evidence id: EV-UNTRACKED');
  });

  it('accepts https URLs and existing repo-local evidence refs', () => {
    expect(isValidEvidenceRef('https://github.com/famaoai-creator/kyberion/pull/1')).toBe(true);
    expect(isValidEvidenceRef('docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md')).toBe(true);
    expect(isValidEvidenceRef('../outside.md')).toBe(false);
    expect(isValidEvidenceRef('docs/operator/missing-evidence.md')).toBe(false);
  });
});
