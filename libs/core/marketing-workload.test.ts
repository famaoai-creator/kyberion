import { describe, expect, it } from 'vitest';
import * as customerResolver from './customer-resolver.js';
import {
  aggregateMarketingReviews,
  canCompleteMarketingMission,
  evaluatePublicationVerification,
  loadMarketingRiskPolicy,
  requiredMarketingControls,
  scanMarketingTextForSensitiveData,
  validateClaims,
  validateMarketingIntake,
  validateMarketingImageArtifact,
  validateMarketingTextArtifact,
  validateMarketingCompletionEvidence,
  validatePublicationApproval,
  validatePublicationClassification,
  validateVideoTechnicalArtifacts,
  type ArtifactBinding,
  type MarketingRiskPolicy,
  type PublicationApproval,
} from './marketing-workload.js';

const artifact: ArtifactBinding = { path: 'artifacts/final.mp4', sha256: 'a'.repeat(64) };

function approval(overrides: Partial<PublicationApproval> = {}): PublicationApproval {
  return {
    approval_id: 'approval-001',
    mission_id: 'mission-001',
    approved_artifacts: { video: artifact },
    destination: { service: 'youtube', account: 'official', visibility: 'unlisted' },
    title: 'Title',
    description: 'Description',
    cta_url: 'https://example.com/cta',
    approved_by: ['human:owner'],
    approval_decisions: [
      {
        approved_by: 'human:owner',
        decided_by_type: 'human',
        authenticated: true,
        approved_at: '2026-07-11T00:00:00.000Z',
      },
    ],
    approved_at: '2026-07-11T00:00:00.000Z',
    expires_at: '2026-07-13T00:00:00.000Z',
    risk_level: 2,
    review_ids: ['review-001'],
    shared_approval: {
      storage_channel: 'terminal',
      request_id: '00000000-0000-4000-8000-000000000001',
      payload_hash: 'a'.repeat(64),
      effect_binding: 'marketing-publication:mission-001',
    },
    ...overrides,
  };
}

describe('marketing workload gates', () => {
  it('fails intake when publication-critical fields are missing', () => {
    const result = validateMarketingIntake({ publication_intent: 'public', risk_level: 2 });
    expect(result.status).toBe('failed');
    expect(result.reasons).toContain('outcome is required');
    expect(result.reasons).toContain('public publication requires an approver');
    expect(result.reasons).toContain('public claims require explicit claim ids');
  });

  it('rejects unregistered and non-public claims', () => {
    const result = validateClaims(
      ['claim-001', 'missing'],
      [
        {
          id: 'claim-001',
          text: '50% faster',
          source: 'study.md',
          confidence: 'verified',
          public_use: false,
          permitted_channels: ['youtube'],
        },
      ],
      'youtube'
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'claim claim-001 is not approved for public use',
        'claim missing is not registered',
      ])
    );
  });

  it('blocks personal, customer-scoped, PII, and secret material from publication', () => {
    const result = validatePublicationClassification({
      source_classifications: ['personal', 'customer_scoped'],
      publication_allowed: true,
      requires_redaction: false,
      pii_detected: true,
      secret_detected: true,
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toHaveLength(4);
  });

  it('detects PII and secrets without persisting their raw values', () => {
    const result = scanMarketingTextForSensitiveData([
      { location: 'description.md', content: 'Contact alice@example.com or +81 90 1234 5678' },
      { location: 'script.md', content: 'api_key=super-secret-value' },
    ]);
    expect(result.passed).toBe(false);
    expect(result.pii_findings).toEqual([
      { category: 'email', location: 'description.md' },
      { category: 'phone', location: 'description.md' },
    ]);
    expect(result.secret_findings).toEqual([
      { category: 'credential_assignment', location: 'script.md' },
    ]);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('fails technical validation for missing media and an invalid CTA', () => {
    const result = validateVideoTechnicalArtifacts({
      video_exists: false,
      readable: false,
      audio_track: false,
      captions_exist: false,
      thumbnail_exists: false,
      cta_url: 'not a url',
      spec: {
        allowed_resolutions: ['1920x1080'],
        allowed_frame_rates: [30],
        max_duration_seconds: 95,
        captions_required: true,
        thumbnail_required: true,
        cta_domain_allowlist: ['example.com'],
      },
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'video file is missing',
        'captions are missing',
        'thumbnail is missing',
        'CTA URL is invalid',
      ])
    );
  });

  it('rejects oversized video, long black frames, and long silence', () => {
    const result = validateVideoTechnicalArtifacts({
      video_exists: true,
      readable: true,
      duration_seconds: 10,
      resolution: '1920x1080',
      frame_rate: 30,
      audio_track: true,
      captions_exist: true,
      thumbnail_exists: true,
      file_size_bytes: 101,
      max_black_frame_seconds: 1.1,
      max_silence_seconds: 3.1,
      spec: {
        allowed_resolutions: ['1920x1080'],
        allowed_frame_rates: [30],
        max_duration_seconds: 95,
        captions_required: true,
        thumbnail_required: true,
        max_file_size_bytes: 100,
        max_black_frame_seconds: 1,
        max_silence_seconds: 3,
        cta_domain_allowlist: [],
      },
    });
    expect(result.reasons).toEqual([
      'video file size exceeds policy or is unavailable',
      'black frame duration exceeds policy',
      'silence duration exceeds policy',
    ]);
  });

  it('validates text CTA, disclaimers, claims, structure, URLs, and sensitive data', () => {
    const result = validateMarketingTextArtifact({
      content: 'Contact alice@example.com and use claim-missing',
      format: 'markdown',
      max_characters: 500,
      required_cta: 'Request a demo',
      required_disclaimers: ['Terms apply'],
      prohibited_terms: ['guaranteed'],
      referenced_claim_ids: ['claim-missing'],
      registered_claim_ids: [],
      urls: ['not-a-url'],
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'required CTA is missing',
        'required disclaimer is missing: Terms apply',
        'referenced claim is not registered: claim-missing',
        'URL is invalid: not-a-url',
        'Markdown artifact has no heading',
        'text artifact contains PII-like content',
      ])
    );
  });

  it('validates image dimensions, ratio, size, alpha, metadata, brand, and overflow', () => {
    const result = validateMarketingImageArtifact({
      width: 800,
      height: 800,
      file_size_bytes: 101,
      max_file_size_bytes: 100,
      allowed_resolutions: ['1920x1080'],
      allowed_aspect_ratios: [16 / 9],
      alpha_channel: true,
      alpha_allowed: false,
      sensitive_metadata_keys: ['GPSLatitude'],
      brand_tokens_valid: false,
      text_overflow_detected: true,
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toHaveLength(7);
  });

  it('invalidates review after artifact change and blocks blocking findings', () => {
    const result = aggregateMarketingReviews({
      artifacts: { video: artifact },
      requiredReviewerRoles: ['legal-reviewer'],
      reviews: [
        {
          review_id: 'review-001',
          artifact_path: artifact.path,
          artifact_sha256: 'b'.repeat(64),
          reviewer_role: 'content-reviewer',
          verdict: 'approved',
          findings: [{ severity: 'blocking', category: 'claim', description: 'unsupported' }],
        },
      ],
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'review review-001 was invalidated by artifact change',
        'review review-001 has blocking findings',
        'required reviewer role is missing: legal-reviewer',
        `artifact has no current review: ${artifact.path}`,
      ])
    );
  });

  it('allows suggestion-only review for the same artifact hash', () => {
    const result = aggregateMarketingReviews({
      artifacts: { video: artifact },
      requiredReviewerRoles: ['content-reviewer'],
      reviews: [
        {
          review_id: 'review-001',
          artifact_path: artifact.path,
          artifact_sha256: artifact.sha256,
          reviewer_role: 'content-reviewer',
          verdict: 'approved',
          findings: [
            { severity: 'suggestion', category: 'readability', description: 'slow caption' },
          ],
        },
      ],
    });
    expect(result.status).toBe('passed');
  });

  it.each([
    ['missing approval', undefined, {}, 'human publication approval is required'],
    ['expired', approval({ expires_at: '2026-07-11T00:00:00.000Z' }), {}, 'approval has expired'],
    [
      'artifact hash',
      approval(),
      { artifacts: { video: { ...artifact, sha256: 'c'.repeat(64) } } },
      'artifact binding changed: video',
    ],
    ['title', approval(), { title: 'Changed' }, 'title binding changed'],
    ['description', approval(), { description: 'Changed' }, 'description binding changed'],
    [
      'visibility',
      approval(),
      { destination: { service: 'youtube', account: 'official', visibility: 'public' } },
      'destination binding changed',
    ],
    [
      'destination',
      approval(),
      { destination: { service: 'other', account: 'official', visibility: 'unlisted' } },
      'destination binding changed',
    ],
    ['two-person rule', approval(), { requiredApprovals: 2 }, 'insufficient human approvers'],
    [
      'unauthenticated approval identity',
      approval({ approval_decisions: [] }),
      {},
      'insufficient authenticated human approvers',
    ],
  ])('rejects publication for %s', (_name, record, changes, reason) => {
    const result = validatePublicationApproval({
      approval: record as PublicationApproval | undefined,
      artifacts: { video: artifact },
      destination: { service: 'youtube', account: 'official', visibility: 'unlisted' },
      title: 'Title',
      description: 'Description',
      cta_url: 'https://example.com/cta',
      requiredApprovals: 1,
      now: new Date('2026-07-12T00:00:00.000Z'),
      ...changes,
    });
    expect(result.reasons).toContain(reason);
  });

  it('does not treat dry-run as completed public publication', () => {
    const verification = evaluatePublicationVerification({
      publication_url: 'local://preview/youtube.html',
      expected_visibility: 'unlisted',
      actual_visibility: 'unlisted',
      artifact_hash_matches: true,
      cta_status: 'passed',
      captions_enabled: true,
      thumbnail_set: true,
      dry_run: true,
    });
    expect(verification.status).toBe('passed');
    expect(
      canCompleteMarketingMission({
        requiredGates: ['G6'],
        gateResults: [verification],
        publicationIntent: 'public',
        dryRun: true,
      })
    ).toBe(false);
  });

  it('accepts bound local completion evidence and invalidates changed artifacts', () => {
    const evidence = {
      workload: 'marketing-video-production' as const,
      run_id: 'run-1',
      publication_intent: 'none' as const,
      dry_run: true,
      required_gates: ['G0', 'G1', 'G3'] as const,
      gate_results: [
        { gate_id: 'G0' as const, status: 'passed' as const, reasons: [], evidence: ['intake'] },
        { gate_id: 'G1' as const, status: 'passed' as const, reasons: [], evidence: ['scan'] },
        { gate_id: 'G3' as const, status: 'passed' as const, reasons: [], evidence: ['probe'] },
      ],
      artifact_bindings: { video: artifact },
      sensitive_data_scan: { pii_findings: [], secret_findings: [], passed: true },
      completion_eligible: true,
    };
    expect(
      validateMarketingCompletionEvidence({ evidence, currentArtifacts: { video: artifact } })
    ).toEqual({ ok: true, reasons: [] });
    expect(
      validateMarketingCompletionEvidence({
        evidence,
        currentArtifacts: { video: { ...artifact, sha256: 'b'.repeat(64) } },
      }).reasons
    ).toContain('marketing completion artifact changed: video');
  });

  it('resolves risk controls and rejects an unknown risk level', () => {
    const policy: MarketingRiskPolicy = {
      version: '1',
      allowed_channels: ['youtube'],
      cta_domain_allowlist: ['example.com'],
      levels: {
        '4': {
          required_gates: ['G0', 'G5', 'G6'],
          required_reviewers: [],
          required_approvals: 2,
          dry_run_required: true,
        },
      },
    };
    expect(requiredMarketingControls(4, policy).required_approvals).toBe(2);
    expect(() => requiredMarketingControls(3, policy)).toThrow('Unsupported marketing risk level');
  });

  it('rejects unsafe customer selectors and preserves the no-customer fallback', () => {
    const defaultPolicy = loadMarketingRiskPolicy({});
    expect(defaultPolicy.allowed_channels).toContain('linkedin');
    expect(() => loadMarketingRiskPolicy({ KYBERION_CUSTOMER: '../other-customer' })).toThrow(
      'Invalid KYBERION_CUSTOMER'
    );
  });

  it('resolves different customers to isolated policy roots', () => {
    const customerA = customerResolver.customerRoot('policy/marketing-risk-policy.json', {
      KYBERION_CUSTOMER: 'customer-a',
    });
    const customerB = customerResolver.customerRoot('policy/marketing-risk-policy.json', {
      KYBERION_CUSTOMER: 'customer-b',
    });
    expect(customerA).toContain('/customer/customer-a/policy/marketing-risk-policy.json');
    expect(customerB).toContain('/customer/customer-b/policy/marketing-risk-policy.json');
    expect(customerA).not.toBe(customerB);
    expect(customerResolver.customerRoot('policy/marketing-risk-policy.json', {})).toBeNull();
  });
});
