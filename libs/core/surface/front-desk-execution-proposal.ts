import type { DotProposal } from '../dot/dot-proposals.js';
import type { FrontDeskExecutionBinding } from './front-desk-execution-contract.js';

export const FRONT_DESK_RECEIPT_PIPELINE = 'pipelines/front-desk-request-receipt.json';

export function frontDeskBindingsEqual(a: FrontDeskExecutionBinding, b: unknown): boolean {
  if (!b || typeof b !== 'object') return false;
  const other = b as Record<string, unknown>;
  return (
    [
      'mapping_id',
      'diagnostic_protocol',
      'config_digest',
      'conversation_key',
      'request_id',
      'revision',
      'request_digest',
      'work_item_id',
      'parent_request_id',
      'parent_revision',
      'parent_sha256',
      'receipt_format',
    ] as const
  ).every((key) => a[key] === other[key]);
}

/** Proposal carries references only. The request body remains in its scoped transcript. */
export function frontDeskExecutionProposal(binding: FrontDeskExecutionBinding): DotProposal {
  return {
    action_id: 'dot_delegate_work',
    title: 'Create a local diagnostic request receipt artifact',
    objective:
      'Materialize and verify the configured request receipt. Request ' +
      binding.request_id +
      ', revision ' +
      binding.revision +
      ', request digest ' +
      binding.request_digest +
      ', configuration digest ' +
      binding.config_digest +
      (binding.parent_request_id
        ? ', parent request ' +
          binding.parent_request_id +
          ', parent revision ' +
          binding.parent_revision +
          ', parent SHA-256 ' +
          binding.parent_sha256 +
          ', requested JSON format ' +
          binding.receipt_format +
          '. Preserve the old artifact; create a separately approved revision.'
        : '.'),
    work_shape: 'pipeline',
    pipeline_ref: FRONT_DESK_RECEIPT_PIPELINE,
    requested_decision: 'approve',
    target: 'work_item:' + binding.work_item_id,
    intent: binding.parent_request_id ? 'update' : 'create',
    front_desk_execution: binding,
  };
}
