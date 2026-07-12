// AR-02: self-described op catalog replacing the hand-curated registry
// entry, which listed ops this actuator never dispatched (list/read/log/
// notify came from the shared pools anyway) while omitting the real op
// surface. Removed curated ops fall back to the shared pools with the same
// kind, so step-type inference is unchanged; the added ops were previously
// unclassifiable (pipelines reach them via explicit role today).

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const SERVICE_ACTUATOR_CAPTURE_OPS = ['preset'] as const;

export const SERVICE_ACTUATOR_TRANSFORM_OPS = [] as const;

export const SERVICE_ACTUATOR_APPLY_OPS = ['api', 'cli', 'mcp', 'oauth', 'reconcile'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...SERVICE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SERVICE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SERVICE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
