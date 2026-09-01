import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';

export type GuspStimulusStatus = 'pending' | 'injected' | 'processed' | 'expired' | 'failed';

export interface GuspStimulus {
  id: string;
  ts: string;
  ttl: number;
  origin: {
    channel: string;
    source_id: string;
    context?: string;
    metadata?: Record<string, unknown>;
  };
  signal: {
    intent?: string;
    type?: string;
    priority: number;
    payload: string;
  };
  policy?: {
    flow?: string;
    feedback?: string;
    retention?: string;
  };
  control: {
    status: GuspStimulusStatus;
    feedback?: string;
    evidence: Array<{ step: string; ts: string; agent: string }>;
  };
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} has unexpected field '${unexpected}'`);
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`);
  return value;
}

function parseOrigin(value: unknown): GuspStimulus['origin'] {
  if (!isRecord(value)) throw new Error('stimulus.origin must be an object');
  assertAllowedKeys(value, ['channel', 'source_id', 'context', 'metadata'], 'stimulus.origin');
  const metadata = value.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error('stimulus.origin.metadata must be an object');
  }
  const metadataRecord = metadata as Record<string, unknown> | undefined;
  return {
    channel: requiredString(value, 'channel', 'stimulus.origin'),
    source_id: requiredString(value, 'source_id', 'stimulus.origin'),
    ...(value.context !== undefined
      ? { context: optionalString(value, 'context', 'stimulus.origin') }
      : {}),
    ...(metadataRecord !== undefined ? { metadata: metadataRecord } : {}),
  };
}

function parseSignal(value: unknown): GuspStimulus['signal'] {
  if (!isRecord(value)) throw new Error('stimulus.signal must be an object');
  assertAllowedKeys(value, ['intent', 'type', 'priority', 'payload'], 'stimulus.signal');
  const intent = optionalString(value, 'intent', 'stimulus.signal');
  const type = optionalString(value, 'type', 'stimulus.signal');
  if (!intent && !type) throw new Error('stimulus.signal.intent or type is required');
  const priority = value.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new Error('stimulus.signal.priority must be finite');
  }
  return {
    ...(intent ? { intent } : {}),
    ...(type ? { type } : {}),
    priority,
    payload: requiredString(value, 'payload', 'stimulus.signal'),
  };
}

function parsePolicy(value: unknown): GuspStimulus['policy'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('stimulus.policy must be an object');
  assertAllowedKeys(value, ['flow', 'feedback', 'retention'], 'stimulus.policy');
  return {
    ...(value.flow !== undefined ? { flow: optionalString(value, 'flow', 'stimulus.policy') } : {}),
    ...(value.feedback !== undefined
      ? { feedback: optionalString(value, 'feedback', 'stimulus.policy') }
      : {}),
    ...(value.retention !== undefined
      ? { retention: optionalString(value, 'retention', 'stimulus.policy') }
      : {}),
  };
}

function parseEvidence(value: unknown): GuspStimulus['control']['evidence'] {
  if (!Array.isArray(value)) throw new Error('stimulus.control.evidence must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`stimulus.control.evidence[${index}] must be an object`);
    assertAllowedKeys(entry, ['step', 'ts', 'agent'], `stimulus.control.evidence[${index}]`);
    return {
      step: requiredString(entry, 'step', `stimulus.control.evidence[${index}]`),
      ts: requiredString(entry, 'ts', `stimulus.control.evidence[${index}]`),
      agent: requiredString(entry, 'agent', `stimulus.control.evidence[${index}]`),
    };
  });
}

function parseControl(value: unknown): GuspStimulus['control'] {
  if (!isRecord(value)) throw new Error('stimulus.control must be an object');
  assertAllowedKeys(value, ['status', 'feedback', 'evidence'], 'stimulus.control');
  const status = value.status;
  if (
    status !== 'pending' &&
    status !== 'injected' &&
    status !== 'processed' &&
    status !== 'expired' &&
    status !== 'failed'
  ) {
    throw new Error('stimulus.control.status is invalid');
  }
  return {
    status,
    ...(value.feedback !== undefined
      ? { feedback: optionalString(value, 'feedback', 'stimulus.control') }
      : {}),
    evidence: parseEvidence(value.evidence),
  };
}

export function normalizeGuspStimulus(value: unknown): GuspStimulus {
  if (!isRecord(value)) throw new Error('stimulus must be an object');
  assertAllowedKeys(
    value,
    ['id', 'ts', 'ttl', 'origin', 'signal', 'policy', 'control'],
    'stimulus'
  );
  const ts = requiredString(value, 'ts', 'stimulus');
  if (!Number.isFinite(Date.parse(ts))) throw new Error('stimulus.ts must be a valid timestamp');
  const ttl = value.ttl;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
    throw new Error('stimulus.ttl must be a finite non-negative number');
  }
  return {
    id: requiredString(value, 'id', 'stimulus'),
    ts,
    ttl,
    origin: parseOrigin(value.origin),
    signal: parseSignal(value.signal),
    ...(value.policy !== undefined ? { policy: parsePolicy(value.policy) } : {}),
    control: parseControl(value.control),
  };
}

export function parseGuspStimulusLine(line: string): GuspStimulus | undefined {
  try {
    return normalizeGuspStimulus(parseSafeJsonInput(line, 'Nexus stimulus'));
  } catch {
    return undefined;
  }
}
