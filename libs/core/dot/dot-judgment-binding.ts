/** Server-authored synthetic references, not persisted-source proof or execution authority. */
import { z } from 'zod';
import type { ScopeContext } from '../scope-context-validation.js';
import {
  judgmentBindingSchema,
  judgmentScopeSchema,
  type JudgmentBinding,
} from '../organization/judgment-contract.js';
import {
  judgmentEvidenceParent,
  parseJudgmentReceiptAddress,
  type JudgmentReceiptAddress,
} from '../organization/judgment-evidence.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import type { DotCharter } from './dot-charter.js';
import { normalizeDotProposal, type DotProposal } from './dot-proposals.js';

export interface DotJudgmentBinding {
  schema_version: '1';
  mode: 'synthetic_fixture';
  scope: ScopeContext;
  judgment_binding: JudgmentBinding;
  evaluation_parent_key: string;
  effect_ref: string;
  effect_key: string;
  /** Immutable admission audit selector; freshness and actual origin proof are checked later. */
  origin_receipt: JudgmentReceiptAddress;
  original_proposal_hash: string;
  charter_hash: string;
  /** Effect gate policy is distinct from the semantic evaluator policy version. */
  effect_policy_version: string;
}
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z
  .object({
    schema_version: z.literal('1'),
    mode: z.literal('synthetic_fixture'),
    scope: judgmentScopeSchema,
    judgment_binding: judgmentBindingSchema,
    evaluation_parent_key: hash,
    effect_ref: key,
    effect_key: hash,
    origin_receipt: z.unknown(),
    original_proposal_hash: hash,
    charter_hash: hash,
    effect_policy_version: key,
  })
  .strict();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Absent legacy metadata is off; an invalid present reference is never upgraded or discarded. */
export function parseDotJudgmentBinding(value: unknown): DotJudgmentBinding | undefined {
  if (value === undefined) return undefined;
  const before = judgmentCanonicalHash(value);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024)
    throw new Error('Synthetic judgment binding exceeds its byte bound');
  const parsed = bindingSchema.parse(value);
  const result: DotJudgmentBinding = {
    schema_version: parsed.schema_version,
    mode: parsed.mode,
    scope: judgmentScopeSchema.parse(parsed.scope),
    judgment_binding: judgmentBindingSchema.parse(parsed.judgment_binding),
    evaluation_parent_key: parsed.evaluation_parent_key,
    effect_ref: parsed.effect_ref,
    effect_key: parsed.effect_key,
    origin_receipt: parseJudgmentReceiptAddress(parsed.origin_receipt),
    original_proposal_hash: parsed.original_proposal_hash,
    charter_hash: parsed.charter_hash,
    effect_policy_version: parsed.effect_policy_version,
  };
  if (before !== judgmentCanonicalHash(result))
    throw new Error('Synthetic judgment binding is not canonical JSON');
  const parent = judgmentEvidenceParent({
    scope: result.scope,
    binding: result.judgment_binding,
    effectRef: result.effect_ref,
  });
  if (
    result.evaluation_parent_key !== parent.evaluation_key ||
    result.effect_key !== parent.effect_key ||
    result.origin_receipt.evaluation_key !== parent.evaluation_key ||
    result.origin_receipt.effect_key !== parent.effect_key
  )
    throw new Error('Synthetic judgment parent, effect or origin identity differs');
  return freeze(result);
}

/**
 * Validate already server-bound proposals without feeding the reserved field to the model
 * parser, discarding it or authoring a replacement. This verifies metadata integrity only;
 * persisted origin/current evidence and effect authority still require separate checks.
 */
export function validateServerDotJudgmentProposal(
  proposal: DotProposal
): DotJudgmentBinding | undefined {
  if ('private_content_hash' in proposal)
    throw new Error('Shared action index is not an executable proposal');
  const descriptor = Object.getOwnPropertyDescriptor(proposal, 'semantic_judgment');
  if (!descriptor) {
    if ('semantic_judgment' in proposal) throw new Error('Inherited judgment binding is invalid');
    return undefined;
  }
  if (!('value' in descriptor)) throw new Error('Judgment binding accessor is invalid');
  if (descriptor.value === undefined) return undefined;
  judgmentCanonicalHash(proposal);
  const binding = parseDotJudgmentBinding(descriptor.value);
  if (!binding) throw new Error('Present judgment binding is required');
  if (
    proposal.work_shape !== 'pipeline' ||
    !proposal.pipeline_ref ||
    ['front_desk_execution', 'continuous_work', 'mission_admission', 'handoff_to'].some((field) =>
      Object.hasOwn(proposal, field)
    )
  )
    throw new Error('Judged proposals cannot combine managed, diagnostic or handoff provenance');
  const base = Object.fromEntries(
    Object.entries(proposal).filter(([field]) => field !== 'semantic_judgment')
  );
  const normalized = normalizeDotProposal(base);
  const baseHash = judgmentCanonicalHash(base);
  if (baseHash !== judgmentCanonicalHash(normalized) || baseHash !== binding.original_proposal_hash)
    throw new Error('Original normalized proposal differs from the judgment binding');
  return binding;
}

/** Pins the full server-owned JSON charter; edits fail closed rather than silently rebinding. */
export function dotJudgmentCharterHash(charter: DotCharter): string {
  return judgmentCanonicalHash(charter);
}

export interface SyntheticDotJudgmentBindingInput {
  mode: 'synthetic_fixture';
  proposal: DotProposal;
  charter: DotCharter;
  scope: ScopeContext;
  judgmentBinding: JudgmentBinding;
  originReceipt: JudgmentReceiptAddress;
  effectRef: string;
  effectPolicyVersion: string;
}

/**
 * Pure authoring only. A well-shaped address or caller label cannot prove a persisted origin.
 * The synthetic pre-effect adapter must read the actual historical origin and current latest
 * receipt, then separately verify current charter/role/gate/effect approval. No runtime caller
 * is installed here, and shadow configuration can never attach this reference.
 */
export function bindSyntheticDotJudgmentProposal(
  input: SyntheticDotJudgmentBindingInput
): DotProposal & { semantic_judgment: DotJudgmentBinding } {
  judgmentCanonicalHash(input);
  const expectedKeys = [
    'mode',
    'proposal',
    'charter',
    'scope',
    'judgmentBinding',
    'originReceipt',
    'effectRef',
    'effectPolicyVersion',
  ];
  if (
    Object.keys(input).some((field) => !expectedKeys.includes(field)) ||
    input.mode !== 'synthetic_fixture'
  )
    throw new Error('Only explicit synthetic binding authoring is supported');
  const { proposal, charter } = input;
  if (
    Object.hasOwn(proposal, 'semantic_judgment') ||
    Object.hasOwn(proposal, 'front_desk_execution') ||
    Object.hasOwn(proposal, 'continuous_work') ||
    Object.hasOwn(proposal, 'mission_admission') ||
    Object.hasOwn(proposal, 'handoff_to') ||
    (charter.runtime.semantic_judgment !== undefined &&
      (charter.runtime.semantic_judgment.mode !== 'off' ||
        Object.keys(charter.runtime.semantic_judgment).some((field) => field !== 'mode'))) ||
    charter.runtime.execution_mode !== undefined
  )
    throw new Error(
      'Synthetic authoring cannot replace bindings or attach to shadow/diagnostic/managed/handoff work'
    );
  if (
    charter.status !== 'active' ||
    proposal.work_shape !== 'pipeline' ||
    !proposal.pipeline_ref ||
    !(charter.authority.allowed_pipelines ?? []).includes(proposal.pipeline_ref) ||
    !(charter.authority.allowed_work_shapes ?? []).includes('pipeline')
  )
    throw new Error('Synthetic authoring requires an already bounded pipeline proposal');
  const normalized = normalizeDotProposal(proposal);
  if (judgmentCanonicalHash(proposal) !== judgmentCanonicalHash(normalized))
    throw new Error('Synthetic proposal must already be canonically normalized');
  const scope = judgmentScopeSchema.parse(input.scope);
  const charterScope = judgmentScopeSchema.parse(charter.scope);
  if (
    judgmentCanonicalHash(input.scope) !== judgmentCanonicalHash(scope) ||
    judgmentCanonicalHash(charter.scope) !== judgmentCanonicalHash(charterScope) ||
    judgmentCanonicalHash(scope) !== judgmentCanonicalHash(charterScope)
  )
    throw new Error('Synthetic judgment requires the exact declared charter scope');
  const parent = judgmentEvidenceParent({
    scope,
    binding: input.judgmentBinding,
    effectRef: input.effectRef,
  });
  const bound = parseDotJudgmentBinding({
    schema_version: '1',
    mode: 'synthetic_fixture',
    scope,
    judgment_binding: input.judgmentBinding,
    evaluation_parent_key: parent.evaluation_key,
    effect_ref: input.effectRef,
    effect_key: parent.effect_key,
    origin_receipt: input.originReceipt,
    original_proposal_hash: judgmentCanonicalHash(normalized),
    charter_hash: dotJudgmentCharterHash(charter),
    effect_policy_version: input.effectPolicyVersion,
  });
  if (!bound) throw new Error('Synthetic binding is required');
  // The model parser is never applied to the bound object; it is used only before authoring.
  return freeze({ ...structuredClone(normalized), semantic_judgment: bound });
}
