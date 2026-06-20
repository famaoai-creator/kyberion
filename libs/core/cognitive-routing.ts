import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const SCHEMA_PATH = pathResolver.knowledge('product/schemas/cognitive-routing-decision.schema.json');

export type CognitiveTier = 'zero_llm' | 'fast_llm' | 'heavy_reasoning';

export type CognitiveBackendPreference = 'deterministic_pipeline' | 'fast_reasoning' | 'heavy_reasoning';

export interface CognitiveRouteCandidate {
  mission_id: string;
  mission_type?: string;
  tenant_slug?: string;
  assigned_persona?: string;
  status?: string;
  team_role?: string;
  recipient_kind?: string;
  item_id?: string;
  title?: string;
  description?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  prompt?: string;
  context_pack_id?: string;
  context_pack_path?: string;
}

export interface CognitiveRouteDecision {
  tier: CognitiveTier;
  backend_preference: CognitiveBackendPreference;
  deterministic_eligible: boolean;
  risk: number;
  uncertainty: number;
  reason: string;
  mission_id?: string;
  item_id?: string;
  team_role?: string;
  recipient_kind?: string;
  prompt_length?: number;
}

export interface FormatCognitiveRouteDecisionOptions {
  compact?: boolean;
}

type CognitiveRouteDecisionValidator = ValidateFunction;

const DETERMINISTIC_REF_KEYS = [
  'pipeline_ref',
  'pipeline_id',
  'pipeline_path',
  'adf_ref',
  'adf_id',
  'adf_path',
  'sop_ref',
  'workflow_ref',
  'execution_plan_ref',
];

const HIGH_RISK_MARKERS = [
  'architecture',
  'architect',
  'strategy',
  'design',
  'security',
  'compliance',
  'audit',
  'governance',
  'external audience',
  'public audience',
  'investigate',
  'root cause',
  'unknown',
  'ambiguous',
  'refactor',
  'migration',
  'regression',
  'failure',
  'bug',
  'incident',
  'compare',
  'evaluate',
];

const FAST_PATH_MARKERS = [
  'summarize',
  'summary',
  'extract',
  'parse',
  'format',
  'convert',
  'json',
  'markdown',
  'ticket',
  'comment',
  'reflection',
  'update status',
  'close issue',
  'fill in',
];

const DETERMINISTIC_MARKERS = [
  'deterministic_pipeline',
  'replay',
  'known sop',
  'known procedure',
  'static pipeline',
  'adf',
  'compile',
  'pipeline run',
];

let validateFn: CognitiveRouteDecisionValidator | null = null;
let cachedSchemaPath: string | null = null;
let cachedSchemaRaw: string | null = null;

function ensureValidator(): CognitiveRouteDecisionValidator {
  if (validateFn && cachedSchemaPath === SCHEMA_PATH) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  cachedSchemaPath = SCHEMA_PATH;
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim(),
  );
}

function validateDecision(value: unknown): CognitiveRouteDecision {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid cognitive route decision: ${errorsFrom(validate).join('; ')}`);
  }
  return value as CognitiveRouteDecision;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

function lowerText(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractMetadataStrings(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  return Object.entries(metadata).flatMap(([key, value]) => {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [`${key}:${String(value)}`];
    }
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        if (entry === null || entry === undefined) return [];
        if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
          return [`${key}:${String(entry)}`];
        }
        return [];
      });
    }
    return [key];
  });
}

function scoreMarkers(text: string, markers: string[]): { score: number; matches: string[] } {
  const matches = markers.filter((marker) => text.includes(marker));
  return { score: matches.length, matches };
}

function getMetadata(input: CognitiveRouteCandidate): Record<string, unknown> {
  return (input.metadata && typeof input.metadata === 'object' ? input.metadata : {}) as Record<string, unknown>;
}

function hasDeterministicReference(input: CognitiveRouteCandidate, metadata: Record<string, unknown>, text: string): boolean {
  const explicitMode = textValue(metadata.execution_mode);
  if (explicitMode === 'deterministic_pipeline') return true;
  for (const key of DETERMINISTIC_REF_KEYS) {
    if (textValue(metadata[key])) return true;
  }
  return DETERMINISTIC_MARKERS.some((marker) => text.includes(marker));
}

function resolveRiskScore(text: string): { risk: number; uncertainty: number; reason: string } {
  const highRisk = scoreMarkers(text, HIGH_RISK_MARKERS);
  const fastPath = scoreMarkers(text, FAST_PATH_MARKERS);
  const uncertaintySignals = [
    'unknown',
    'ambiguous',
    'investigate',
    'compare',
    'evaluate',
    'proposal',
    'architecture',
    'strategy',
    'design',
    'risk',
    'failure',
  ];
  const uncertainty = scoreMarkers(text, uncertaintySignals);
  const risk = Math.min(100, highRisk.score * 18 + uncertainty.score * 9);
  const uncertaintyScore = Math.min(100, uncertainty.score * 16 + (fastPath.score === 0 ? 8 : 0));
  const reasonParts = [
    highRisk.matches.length ? `high-risk markers: ${highRisk.matches.slice(0, 3).join(', ')}` : '',
    uncertainty.matches.length ? `uncertainty markers: ${uncertainty.matches.slice(0, 3).join(', ')}` : '',
    fastPath.matches.length ? `fast-path markers: ${fastPath.matches.slice(0, 3).join(', ')}` : '',
  ].filter(Boolean);
  return {
    risk,
    uncertainty: uncertaintyScore,
    reason: reasonParts.join(' | '),
  };
}

function selectTier(input: CognitiveRouteCandidate, text: string): CognitiveRouteDecision {
  const metadata = getMetadata(input);
  const deterministicEligible = hasDeterministicReference(input, metadata, text);
  const riskSignals = resolveRiskScore(text);
  const fastPathSignals = scoreMarkers(text, FAST_PATH_MARKERS);
  const heavySignals = scoreMarkers(text, HIGH_RISK_MARKERS);

  if (deterministicEligible) {
    const decision: Record<string, unknown> = {
      tier: 'zero_llm',
      backend_preference: 'deterministic_pipeline',
      deterministic_eligible: true,
      risk: Math.min(20, riskSignals.risk),
      uncertainty: Math.min(20, riskSignals.uncertainty),
      reason: 'deterministic pipeline or ADF reference detected',
      mission_id: input.mission_id,
    };
    if (input.item_id) decision.item_id = input.item_id;
    if (input.team_role) decision.team_role = input.team_role;
    if (input.recipient_kind) decision.recipient_kind = input.recipient_kind;
    if (text.length > 0) decision.prompt_length = text.length;
    return validateDecision(decision);
  }

  const preferHeavy = heavySignals.score >= 2 || riskSignals.risk >= 36 || riskSignals.uncertainty >= 34;

  const decision: Record<string, unknown> = {
    tier: preferHeavy ? 'heavy_reasoning' : 'fast_llm',
    backend_preference: preferHeavy ? 'heavy_reasoning' : 'fast_reasoning',
    deterministic_eligible: false,
    risk: Math.max(riskSignals.risk, preferHeavy ? 48 : fastPathSignals.score > 0 ? 8 : 16),
    uncertainty: Math.max(riskSignals.uncertainty, preferHeavy ? 42 : 12),
    reason: preferHeavy
      ? (riskSignals.reason || 'high-risk or uncertain mission task detected')
      : (fastPathSignals.matches.length ? `fast-path task markers: ${fastPathSignals.matches.slice(0, 3).join(', ')}` : 'routine task suitable for minimal reasoning'),
    mission_id: input.mission_id,
  };
  if (input.item_id) decision.item_id = input.item_id;
  if (input.team_role) decision.team_role = input.team_role;
  if (input.recipient_kind) decision.recipient_kind = input.recipient_kind;
  if (text.length > 0) decision.prompt_length = text.length;
  return validateDecision(decision);
}

export function buildCognitiveRouteDecision(input: CognitiveRouteCandidate): CognitiveRouteDecision {
  const metadata = getMetadata(input);
  const text = lowerText([
    input.mission_id,
    input.mission_type,
    input.tenant_slug,
    input.assigned_persona,
    input.status,
    input.team_role,
    input.recipient_kind,
    input.item_id,
    input.title,
    input.description,
    input.prompt,
    ...extractMetadataStrings(metadata),
  ]);
  const decision = selectTier(input, text);
  return decision;
}

export function formatCognitiveRouteDecision(
  decision: CognitiveRouteDecision,
  options: FormatCognitiveRouteDecisionOptions = {},
): string {
  const parts = [
    `tier=${decision.tier}`,
    `backend=${decision.backend_preference}`,
    `deterministic=${decision.deterministic_eligible ? 'yes' : 'no'}`,
    `risk=${decision.risk}`,
    `uncertainty=${decision.uncertainty}`,
  ];
  if (!options.compact && decision.reason) {
    parts.push(`reason=${decision.reason}`);
  }
  return parts.join('; ');
}

export function loadCognitiveRoutingSchema(): unknown {
  if (!safeExistsSync(SCHEMA_PATH)) {
    throw new Error(`Cognitive routing schema not found at ${SCHEMA_PATH}`);
  }
  const raw = safeReadFile(SCHEMA_PATH, { encoding: 'utf8' }) as string;
  if (cachedSchemaRaw === raw && cachedSchemaPath === SCHEMA_PATH) {
    return JSON.parse(raw);
  }
  cachedSchemaRaw = raw;
  return JSON.parse(raw);
}

export function resetCognitiveRoutingCache(): void {
  validateFn = null;
  cachedSchemaPath = null;
  cachedSchemaRaw = null;
}
