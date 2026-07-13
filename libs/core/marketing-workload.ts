import { createHash } from 'node:crypto';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { computeApprovalPayloadHash, type ApprovalRequestRecord } from './approval-store.js';
import { evaluateArtifactReviews } from './artifact-review.js';

export type MarketingRiskLevel = 0 | 1 | 2 | 3 | 4;
export type MarketingGateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
export type ReviewVerdict = 'approved' | 'changes_requested' | 'rejected';

export interface MarketingIntake {
  outcome: string;
  audience: string[];
  owner: string;
  approvers?: string[];
  channels: string[];
  deliverables: string[];
  deadline: string;
  success_criteria: string[];
  data_classification: 'public' | 'confidential' | 'personal';
  publication_intent: 'none' | 'internal' | 'public';
  risk_level: MarketingRiskLevel;
  claim_ids?: string[];
}

export interface ClaimRecord {
  id: string;
  text: string;
  source: string;
  source_location?: string;
  confidence: 'unverified' | 'reviewed' | 'verified';
  public_use: boolean;
  permitted_channels: string[];
}

export interface ArtifactBinding {
  path: string;
  sha256: string;
}

export interface MarketingReview {
  review_id: string;
  artifact_path: string;
  artifact_sha256: string;
  reviewer_role: string;
  verdict: ReviewVerdict;
  findings: Array<{
    severity: 'blocking' | 'suggestion';
    category: string;
    description: string;
    required_action?: string;
    location?: Record<string, string>;
  }>;
}

export interface PublicationApproval {
  approval_id: string;
  mission_id: string;
  approved_artifacts: Record<string, ArtifactBinding>;
  destination: {
    service: string;
    account: string;
    visibility: string;
    publish_at?: string;
  };
  title: string;
  description: string;
  cta_url?: string;
  approved_by: string[];
  approval_decisions: Array<{
    approved_by: string;
    decided_by_type: 'human';
    authenticated: true;
    approved_at: string;
  }>;
  approved_at: string;
  expires_at: string;
  risk_level: MarketingRiskLevel;
  review_ids: string[];
  shared_approval: {
    storage_channel: string;
    request_id: string;
    payload_hash: string;
    effect_binding: string;
  };
}

export interface MarketingRiskPolicy {
  version: string;
  levels: Record<
    string,
    {
      required_gates: MarketingGateId[];
      required_reviewers: string[];
      required_approvals: number;
      dry_run_required?: boolean;
    }
  >;
  allowed_channels: string[];
  cta_domain_allowlist: string[];
}

export interface GateResult {
  gate_id: MarketingGateId;
  status: 'passed' | 'failed';
  reasons: string[];
  evidence: string[];
}

export interface SensitiveDataScanResult {
  pii_findings: Array<{ category: string; location: string }>;
  secret_findings: Array<{ category: string; location: string }>;
  passed: boolean;
}

export interface MarketingCompletionEvidence {
  workload: 'marketing-video-production';
  run_id: string;
  publication_intent: MarketingIntake['publication_intent'];
  dry_run: boolean;
  required_gates: MarketingGateId[];
  gate_results: GateResult[];
  artifact_bindings: Record<string, ArtifactBinding>;
  sensitive_data_scan: SensitiveDataScanResult;
  completion_eligible: boolean;
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/marketing-risk-policy.json');

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function scanMarketingTextForSensitiveData(
  documents: Array<{ location: string; content: string }>
): SensitiveDataScanResult {
  const piiPatterns: Array<[string, RegExp]> = [
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['phone', /(?:\+?\d[\d ()-]{7,}\d)/],
    ['credit_card', /\b(?:\d[ -]*?){13,19}\b/],
  ];
  const secretPatterns: Array<[string, RegExp]> = [
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i],
    [
      'credential_assignment',
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i,
    ],
    ['github_token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ];
  const pii_findings: SensitiveDataScanResult['pii_findings'] = [];
  const secret_findings: SensitiveDataScanResult['secret_findings'] = [];
  for (const document of documents) {
    for (const [category, pattern] of piiPatterns) {
      if (pattern.test(document.content))
        pii_findings.push({ category, location: document.location });
    }
    for (const [category, pattern] of secretPatterns) {
      if (pattern.test(document.content))
        secret_findings.push({ category, location: document.location });
    }
  }
  return {
    pii_findings,
    secret_findings,
    passed: pii_findings.length === 0 && secret_findings.length === 0,
  };
}

export function validateMarketingIntake(input: Partial<MarketingIntake>): GateResult {
  const reasons: string[] = [];
  if (!input.outcome?.trim()) reasons.push('outcome is required');
  if (!input.audience?.length) reasons.push('audience is required');
  if (!input.owner?.trim()) reasons.push('owner is required');
  if (!input.channels?.length) reasons.push('channel is required');
  if (!input.deliverables?.length) reasons.push('deliverables are required');
  if (!input.deadline || Number.isNaN(Date.parse(input.deadline)))
    reasons.push('valid deadline is required');
  if (!input.success_criteria?.length) reasons.push('success criteria are required');
  if (!input.data_classification) reasons.push('data classification is required');
  if (input.publication_intent === 'public' && !input.approvers?.length) {
    reasons.push('public publication requires an approver');
  }
  if (input.publication_intent === 'public' && !input.claim_ids?.length) {
    reasons.push('public claims require explicit claim ids');
  }
  return gateResult('G0', reasons);
}

export function validateClaims(
  referencedClaimIds: string[],
  claims: ClaimRecord[],
  channel: string
): GateResult {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const reasons = referencedClaimIds.flatMap((id) => {
    const claim = byId.get(id);
    if (!claim) return [`claim ${id} is not registered`];
    if (!claim.source.trim()) return [`claim ${id} has no evidence source`];
    if (!claim.public_use) return [`claim ${id} is not approved for public use`];
    if (!claim.permitted_channels.includes(channel))
      return [`claim ${id} is not permitted on ${channel}`];
    if (claim.confidence !== 'verified') return [`claim ${id} is not verified`];
    return [];
  });
  return gateResult('G2', reasons);
}

export function validatePublicationClassification(input: {
  source_classifications: Array<'public' | 'confidential' | 'personal' | 'customer_scoped'>;
  publication_allowed: boolean;
  requires_redaction: boolean;
  pii_detected?: boolean;
  secret_detected?: boolean;
}): GateResult {
  const reasons: string[] = [];
  if (!input.publication_allowed) reasons.push('publication is prohibited by data classification');
  if (input.requires_redaction) reasons.push('required redaction is incomplete');
  if (input.pii_detected) reasons.push('PII was detected');
  if (input.secret_detected) reasons.push('secret material was detected');
  if (input.source_classifications.includes('personal'))
    reasons.push('personal tier content cannot be published directly');
  if (input.source_classifications.includes('customer_scoped'))
    reasons.push('customer-scoped content requires explicit publication clearance');
  return gateResult('G1', reasons);
}

export function validateVideoTechnicalArtifacts(input: {
  video_exists: boolean;
  readable: boolean;
  duration_seconds?: number;
  resolution?: string;
  frame_rate?: number;
  audio_track: boolean;
  captions_exist: boolean;
  thumbnail_exists: boolean;
  corrupted?: boolean;
  file_size_bytes?: number;
  max_black_frame_seconds?: number;
  max_silence_seconds?: number;
  cta_url?: string;
  spec: {
    allowed_resolutions: string[];
    allowed_frame_rates: number[];
    max_duration_seconds: number;
    captions_required: boolean;
    thumbnail_required: boolean;
    max_file_size_bytes?: number;
    max_black_frame_seconds?: number;
    max_silence_seconds?: number;
    cta_domain_allowlist: string[];
  };
}): GateResult {
  const reasons: string[] = [];
  if (!input.video_exists) reasons.push('video file is missing');
  if (!input.readable || input.corrupted) reasons.push('video is unreadable or corrupted');
  if (
    input.duration_seconds === undefined ||
    input.duration_seconds > input.spec.max_duration_seconds
  )
    reasons.push('video duration exceeds policy or is unavailable');
  if (!input.resolution || !input.spec.allowed_resolutions.includes(input.resolution))
    reasons.push('video resolution is not allowed');
  if (input.frame_rate === undefined || !input.spec.allowed_frame_rates.includes(input.frame_rate))
    reasons.push('video frame rate is not allowed');
  if (!input.audio_track) reasons.push('audio track is missing');
  if (
    input.spec.max_file_size_bytes !== undefined &&
    (input.file_size_bytes === undefined || input.file_size_bytes > input.spec.max_file_size_bytes)
  )
    reasons.push('video file size exceeds policy or is unavailable');
  if (
    input.spec.max_black_frame_seconds !== undefined &&
    (input.max_black_frame_seconds ?? 0) > input.spec.max_black_frame_seconds
  )
    reasons.push('black frame duration exceeds policy');
  if (
    input.spec.max_silence_seconds !== undefined &&
    (input.max_silence_seconds ?? 0) > input.spec.max_silence_seconds
  )
    reasons.push('silence duration exceeds policy');
  if (input.spec.captions_required && !input.captions_exist) reasons.push('captions are missing');
  if (input.spec.thumbnail_required && !input.thumbnail_exists)
    reasons.push('thumbnail is missing');
  if (input.cta_url) {
    try {
      if (!input.spec.cta_domain_allowlist.includes(new URL(input.cta_url).hostname))
        reasons.push('CTA destination is not allowed');
    } catch {
      reasons.push('CTA URL is invalid');
    }
  }
  return gateResult('G3', reasons);
}

export function validateMarketingTextArtifact(input: {
  content: string;
  format: 'text' | 'markdown' | 'html';
  max_characters: number;
  required_cta?: string;
  required_disclaimers?: string[];
  prohibited_terms?: string[];
  referenced_claim_ids?: string[];
  registered_claim_ids?: string[];
  urls?: string[];
}): GateResult {
  const reasons: string[] = [];
  if (!input.content.trim()) reasons.push('text artifact is empty');
  if (input.content.length > input.max_characters)
    reasons.push('text artifact exceeds maximum length');
  if (input.required_cta && !input.content.includes(input.required_cta))
    reasons.push('required CTA is missing');
  for (const disclaimer of input.required_disclaimers || []) {
    if (!input.content.includes(disclaimer))
      reasons.push(`required disclaimer is missing: ${disclaimer}`);
  }
  for (const term of input.prohibited_terms || []) {
    if (input.content.toLowerCase().includes(term.toLowerCase()))
      reasons.push(`prohibited term is present: ${term}`);
  }
  const registeredClaims = new Set(input.registered_claim_ids || []);
  for (const claimId of input.referenced_claim_ids || []) {
    if (!registeredClaims.has(claimId))
      reasons.push(`referenced claim is not registered: ${claimId}`);
  }
  for (const url of input.urls || []) {
    try {
      new URL(url);
    } catch {
      reasons.push(`URL is invalid: ${url}`);
    }
  }
  if (input.format === 'markdown' && !/^#{1,6}\s+\S+/m.test(input.content))
    reasons.push('Markdown artifact has no heading');
  if (input.format === 'html' && !/<(?:main|article|section|p|h[1-6])\b/i.test(input.content))
    reasons.push('HTML artifact has no content structure');
  const sensitive = scanMarketingTextForSensitiveData([
    { location: 'text-artifact', content: input.content },
  ]);
  if (sensitive.pii_findings.length) reasons.push('text artifact contains PII-like content');
  if (sensitive.secret_findings.length) reasons.push('text artifact contains secret-like content');
  return gateResult('G3', reasons);
}

export function validateMarketingImageArtifact(input: {
  width?: number;
  height?: number;
  file_size_bytes?: number;
  max_file_size_bytes: number;
  allowed_resolutions?: string[];
  allowed_aspect_ratios: number[];
  alpha_channel: boolean;
  alpha_allowed: boolean;
  sensitive_metadata_keys?: string[];
  brand_tokens_valid: boolean;
  text_overflow_detected: boolean;
}): GateResult {
  const reasons: string[] = [];
  if (!input.width || !input.height) reasons.push('image dimensions are unavailable');
  const resolution = input.width && input.height ? `${input.width}x${input.height}` : '';
  if (input.allowed_resolutions?.length && !input.allowed_resolutions.includes(resolution))
    reasons.push('image resolution is not allowed');
  if (input.width && input.height) {
    const ratio = input.width / input.height;
    if (!input.allowed_aspect_ratios.some((allowed) => Math.abs(ratio - allowed) < 0.01))
      reasons.push('image aspect ratio is not allowed');
  }
  if (input.file_size_bytes === undefined || input.file_size_bytes > input.max_file_size_bytes)
    reasons.push('image file size exceeds policy or is unavailable');
  if (input.alpha_channel && !input.alpha_allowed)
    reasons.push('image alpha channel is prohibited');
  if (input.sensitive_metadata_keys?.length) reasons.push('image contains sensitive metadata');
  if (!input.brand_tokens_valid) reasons.push('image does not satisfy brand tokens');
  if (input.text_overflow_detected) reasons.push('image text region overflows its bounds');
  return gateResult('G3', reasons);
}

export function aggregateMarketingReviews(input: {
  artifacts: Record<string, ArtifactBinding>;
  reviews: MarketingReview[];
  requiredReviewerRoles: string[];
}): GateResult {
  const evaluation = evaluateArtifactReviews({
    artifacts: Object.values(input.artifacts),
    reviews: input.reviews.map((review) => ({
      review_id: review.review_id,
      artifact_path: review.artifact_path,
      artifact_sha256: review.artifact_sha256,
      reviewer_role: review.reviewer_role,
      verdict: review.verdict,
      findings: review.findings.map((finding) => ({
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        ...(finding.required_action ? { required_action: finding.required_action } : {}),
        ...(finding.location ? { location: JSON.stringify(finding.location) } : {}),
      })),
    })),
    requiredReviewerRoles: input.requiredReviewerRoles,
  });
  return gateResult('G4', evaluation.reasons, evaluation.review_ids);
}

export function validatePublicationApproval(input: {
  approval?: PublicationApproval;
  artifacts: Record<string, ArtifactBinding>;
  destination: PublicationApproval['destination'];
  title: string;
  description: string;
  cta_url?: string;
  requiredApprovals: number;
  now?: Date;
}): GateResult {
  const reasons: string[] = [];
  const approval = input.approval;
  if (!approval) return gateResult('G5', ['human publication approval is required']);
  const now = input.now ?? new Date();
  if (Date.parse(approval.expires_at) <= now.getTime()) reasons.push('approval has expired');
  if (approval.approved_by.length < input.requiredApprovals)
    reasons.push('insufficient human approvers');
  const authenticatedHumans = new Set(
    approval.approval_decisions
      .filter((decision) => decision.decided_by_type === 'human' && decision.authenticated === true)
      .map((decision) => decision.approved_by)
  );
  if (authenticatedHumans.size < input.requiredApprovals)
    reasons.push('insufficient authenticated human approvers');
  if (approval.approved_by.some((approver) => !authenticatedHumans.has(approver)))
    reasons.push('approval identity is not backed by an authenticated human decision');
  for (const [name, artifact] of Object.entries(input.artifacts)) {
    const approved = approval.approved_artifacts[name];
    if (!approved || approved.path !== artifact.path || approved.sha256 !== artifact.sha256) {
      reasons.push(`artifact binding changed: ${name}`);
    }
  }
  if (JSON.stringify(approval.destination) !== JSON.stringify(input.destination))
    reasons.push('destination binding changed');
  if (approval.title !== input.title) reasons.push('title binding changed');
  if (approval.description !== input.description) reasons.push('description binding changed');
  if ((approval.cta_url ?? '') !== (input.cta_url ?? '')) reasons.push('CTA binding changed');
  return gateResult('G5', reasons, [approval.approval_id]);
}

export function buildPublicationEffectPayload(
  approval: PublicationApproval
): Record<string, unknown> {
  return {
    mission_id: approval.mission_id,
    approved_artifacts: approval.approved_artifacts,
    destination: approval.destination,
    title: approval.title,
    description: approval.description,
    cta_url: approval.cta_url || null,
    risk_level: approval.risk_level,
    review_ids: approval.review_ids,
  };
}

export function validateSharedPublicationApproval(input: {
  approval: PublicationApproval;
  request: ApprovalRequestRecord | null;
}): GateResult {
  const reasons: string[] = [];
  const request = input.request;
  const binding = input.approval.shared_approval;
  if (!request) return gateResult('G5', ['shared approval request was not found']);
  if (request.id !== binding.request_id) reasons.push('shared approval request id changed');
  if (request.storageChannel !== binding.storage_channel)
    reasons.push('shared approval storage channel changed');
  if (request.status !== 'approved') reasons.push(`shared approval request is ${request.status}`);
  const expectedPayloadHash = computeApprovalPayloadHash(
    buildPublicationEffectPayload(input.approval)
  );
  if (binding.payload_hash !== expectedPayloadHash)
    reasons.push('publication payload differs from shared approval binding');
  if (request.accountability?.finalDecision !== 'human_only')
    reasons.push('shared approval does not require human final accountability');
  if (request.accountability?.payloadHash !== binding.payload_hash)
    reasons.push('shared approval accountability payload hash changed');
  if (request.accountability?.effectBinding !== binding.effect_binding)
    reasons.push('shared approval accountability effect binding changed');
  const approvedHumanPrincipals = new Set(
    (request.workflow?.approvals || [])
      .filter(
        (decision) =>
          decision.status === 'approved' &&
          decision.decidedByType === 'human' &&
          decision.authenticated === true &&
          decision.payloadHash === binding.payload_hash &&
          decision.effectBinding === binding.effect_binding
      )
      .map((decision) => decision.approvedBy || '')
      .filter(Boolean)
  );
  for (const approver of input.approval.approved_by) {
    if (!approvedHumanPrincipals.has(approver))
      reasons.push(`publication approver is not ratified in shared approval: ${approver}`);
  }
  return gateResult('G5', reasons, reasons.length ? [] : [request.id]);
}

export function evaluatePublicationVerification(input: {
  publication_url?: string;
  expected_visibility: string;
  actual_visibility?: string;
  artifact_hash_matches: boolean;
  cta_status?: 'passed' | 'failed';
  captions_enabled?: boolean;
  thumbnail_set?: boolean;
  dry_run: boolean;
}): GateResult {
  const reasons: string[] = [];
  if (!input.publication_url) reasons.push('publication URL is missing');
  if (input.expected_visibility !== input.actual_visibility)
    reasons.push('visibility verification failed');
  if (!input.artifact_hash_matches) reasons.push('published artifact hash differs from approval');
  if (input.cta_status !== 'passed') reasons.push('CTA verification failed');
  if (input.captions_enabled !== true) reasons.push('captions verification failed');
  if (input.thumbnail_set !== true) reasons.push('thumbnail verification failed');
  const evidence = input.publication_url ? [input.publication_url] : [];
  if (input.dry_run) evidence.push('dry-run:not-a-publication');
  return gateResult('G6', reasons, evidence);
}

export function canCompleteMarketingMission(input: {
  requiredGates: MarketingGateId[];
  gateResults: GateResult[];
  publicationIntent: MarketingIntake['publication_intent'];
  dryRun: boolean;
}): boolean {
  const results = new Map(input.gateResults.map((result) => [result.gate_id, result]));
  if (input.publicationIntent === 'public' && input.dryRun) return false;
  return input.requiredGates.every((gate) => {
    const result = results.get(gate);
    return result?.status === 'passed' && result.evidence.length > 0;
  });
}

export function validateMarketingCompletionEvidence(input: {
  evidence: MarketingCompletionEvidence;
  currentArtifacts: Record<string, ArtifactBinding>;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const computedEligible = canCompleteMarketingMission({
    requiredGates: input.evidence.required_gates,
    gateResults: input.evidence.gate_results,
    publicationIntent: input.evidence.publication_intent,
    dryRun: input.evidence.dry_run,
  });
  if (!computedEligible || input.evidence.completion_eligible !== true) {
    reasons.push('marketing completion gates are not eligible');
  }
  if (!input.evidence.sensitive_data_scan.passed) {
    reasons.push('marketing sensitive-data scan did not pass');
  }
  for (const [name, approved] of Object.entries(input.evidence.artifact_bindings)) {
    const current = input.currentArtifacts[name];
    if (!current || current.path !== approved.path || current.sha256 !== approved.sha256) {
      reasons.push(`marketing completion artifact changed: ${name}`);
    }
  }
  if (Object.keys(input.evidence.artifact_bindings).length === 0) {
    reasons.push('marketing completion evidence has no artifact bindings');
  }
  return { ok: reasons.length === 0, reasons };
}

export function loadMarketingRiskPolicy(env: NodeJS.ProcessEnv = process.env): MarketingRiskPolicy {
  const overlay = customerResolver.customerRoot('policy/marketing-risk-policy.json', env);
  const source = overlay && safeExistsSync(overlay) ? overlay : DEFAULT_POLICY_PATH;
  return JSON.parse(safeReadFile(source, { encoding: 'utf8' }) as string) as MarketingRiskPolicy;
}

export function requiredMarketingControls(
  riskLevel: MarketingRiskLevel,
  policy = loadMarketingRiskPolicy()
): MarketingRiskPolicy['levels'][string] {
  const controls = policy.levels[String(riskLevel)];
  if (!controls) throw new Error(`Unsupported marketing risk level: ${riskLevel}`);
  return controls;
}

function gateResult(
  gate_id: MarketingGateId,
  reasons: string[],
  evidence: string[] = []
): GateResult {
  return {
    gate_id,
    status: reasons.length ? 'failed' : 'passed',
    reasons,
    evidence: evidence.length ? evidence : reasons.length ? [] : [`${gate_id}:validated`],
  };
}
