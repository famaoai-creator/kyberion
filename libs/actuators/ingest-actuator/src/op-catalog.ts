// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// DA-04: parse → normalize → dedup are pure capture/transform ops;
// staleness_report is a side-effect-free ledger comparison. DA-05's
// ingest:commit (apply) is the explicit ingest ceremony — the ONLY op in
// this actuator that writes into knowledge/confidential/. DA-03's
// ingest:sync_source (capture) lists source-side changes incrementally and
// maintains the per-tenant watermark under active/shared/runtime/ingest-cursors/.

import { getOpInputContract } from '@agent/core/op-input-contracts';

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

export const INGEST_ACTUATOR_CAPTURE_OPS = ['parse_document', 'sync_source'] as const;

export const INGEST_ACTUATOR_TRANSFORM_OPS = [
  'dedup',
  'normalize_card',
  'staleness_report',
] as const;

export const INGEST_ACTUATOR_APPLY_OPS = ['commit'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const contract = getOpInputContract('ingest', op);
  return contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : { op, kind };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...INGEST_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...INGEST_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...INGEST_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
