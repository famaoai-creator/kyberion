type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const DEPLOYMENT_ACTUATOR_CAPTURE_OPS = [] as const;
export const DEPLOYMENT_ACTUATOR_TRANSFORM_OPS = [] as const;
export const DEPLOYMENT_ACTUATOR_APPLY_OPS = ['deploy_release'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...DEPLOYMENT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...DEPLOYMENT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...DEPLOYMENT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
