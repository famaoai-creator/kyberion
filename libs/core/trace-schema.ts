/**
 * PI-06: serializable Trace schema.
 *
 * Trace v1 remains the authoritative wire shape. This module supplies the
 * declarative vocabulary that can be used by replay, redaction, metrics, and
 * the future OTLP exporter without making existing callers know telemetry
 * implementation details.
 */

export type TelemetryAttributeType = 'string' | 'number' | 'boolean';
export type TelemetryCardinality = 'low' | 'high';

export interface TelemetryAttributeDefinition {
  type: TelemetryAttributeType;
  description: string;
  sensitive?: boolean;
  cardinality: TelemetryCardinality;
  values?: readonly string[];
}

export interface TelemetryEventDefinition {
  description: string;
  attributes?: Readonly<Record<string, TelemetryAttributeDefinition>>;
}

export interface TelemetrySpanDefinition {
  name: string;
  description: string;
  /** Allowed parent span kinds; empty means root-only. */
  parents: readonly string[];
  startAttributes: Readonly<Record<string, TelemetryAttributeDefinition>>;
  endAttributes: Readonly<Record<string, TelemetryAttributeDefinition>>;
  events: Readonly<Record<string, TelemetryEventDefinition>>;
  status: {
    default: 'ok' | 'error' | 'unset';
    errorWhen?: string;
  };
}

export interface TraceSchemaIssue {
  path: string;
  message: string;
}

type TelemetryValue<T extends TelemetryAttributeType> = T extends 'string'
  ? string
  : T extends 'number'
    ? number
    : boolean;

type TelemetryAttributesForDefinition<
  T extends Readonly<Record<string, TelemetryAttributeDefinition>>,
> = {
  [K in keyof T]?: T[K] extends TelemetryAttributeDefinition ? TelemetryValue<T[K]['type']> : never;
};

const lowString = (description: string, options: Partial<TelemetryAttributeDefinition> = {}) => ({
  type: 'string' as const,
  description,
  cardinality: 'low' as const,
  ...options,
});

const lowNumber = (description: string, options: Partial<TelemetryAttributeDefinition> = {}) => ({
  type: 'number' as const,
  description,
  cardinality: 'low' as const,
  ...options,
});

const lowBoolean = (description: string, options: Partial<TelemetryAttributeDefinition> = {}) => ({
  type: 'boolean' as const,
  description,
  cardinality: 'low' as const,
  ...options,
});

const highString = (description: string, options: Partial<TelemetryAttributeDefinition> = {}) => ({
  type: 'string' as const,
  description,
  cardinality: 'high' as const,
  ...options,
});

const COMMON_EVENTS = {
  decision: {
    description: 'A governed decision made during the span.',
    attributes: {
      decision: lowString('allow, block, ask, or equivalent decision vocabulary.'),
      reason: highString('Human-readable explanation; never include secrets.'),
    },
  },
  error: {
    description: 'A normalized failure observed by the span.',
    attributes: {
      error_code: lowString('Stable error taxonomy code.'),
      message: highString('Redacted diagnostic message.'),
    },
  },
} satisfies Readonly<Record<string, TelemetryEventDefinition>>;

export const TRACE_SPAN_DEFINITIONS = {
  mission: {
    name: 'mission',
    description: 'A durable mission lifecycle or run boundary.',
    parents: [],
    startAttributes: {
      mission_id: lowString('Canonical mission identifier.'),
      tenant_slug: lowString('Tenant scope identifier.', { sensitive: true }),
    },
    endAttributes: {
      status: lowString('Mission terminal status.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'mission failure or reconciliation rejection' },
  },
  task: {
    name: 'task',
    description: 'A mission task or delegated work item.',
    parents: ['mission'],
    startAttributes: {
      task_id: lowString('Canonical task identifier.'),
      role: lowString('Governed worker role.'),
    },
    endAttributes: {
      outcome: lowString('completed, rejected, failed, or deferred.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'task outcome is failed or rejected' },
  },
  step: {
    name: 'step',
    description: 'One typed pipeline or worker execution step.',
    parents: ['task', 'mission'],
    startAttributes: {
      op: lowString('Canonical namespace:operation identifier.'),
      step_id: lowString('Stable step identifier.'),
    },
    endAttributes: {
      duration_ms: lowNumber('Elapsed duration in milliseconds.'),
      result_schema_ok: lowBoolean('Whether the result passed its contract.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'typed operation returns a failure' },
  },
  tool: {
    name: 'tool',
    description: 'A model-visible tool call and its execution boundary.',
    parents: ['step', 'task', 'mission'],
    startAttributes: {
      tool_name: lowString('Governed tool identifier.'),
      op: lowString('Resolved operation identifier.'),
    },
    endAttributes: {
      decision: lowString('Preflight decision.'),
      duration_ms: lowNumber('Elapsed duration in milliseconds.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'tool call is blocked or failed' },
  },
  compaction: {
    name: 'compaction',
    description: 'Worker context compaction and checkpoint boundary.',
    parents: ['task', 'mission'],
    startAttributes: {
      reason: lowString('manual, threshold, or overflow.', {
        values: ['manual', 'threshold', 'overflow'],
      }),
      tokens_before: lowNumber('Estimated input tokens.'),
    },
    endAttributes: {
      tokens_after: lowNumber('Estimated retained tokens.'),
      estimate_strategy: lowString('char or hybrid.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'summary or checkpoint persistence failed' },
  },
  judge: {
    name: 'judge',
    description: 'A structured route or review judgment.',
    parents: ['step', 'task'],
    startAttributes: {
      schema_ref: lowString('Governed structured-output schema reference.'),
      judge_role: lowString('Role/persona used for the judgment.'),
    },
    endAttributes: {
      selected_route: lowString('Selected route or terminal outcome.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'judgment is invalid or has no matching route' },
  },
  hook: {
    name: 'hook',
    description: 'An extension lifecycle hook invocation.',
    parents: ['tool', 'step', 'task'],
    startAttributes: {
      hook_name: lowString('Governed lifecycle hook name.'),
    },
    endAttributes: {
      decision: lowString('allow, block, ask, or continue.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'hook fails or returns a terminal block' },
  },
  gate: {
    name: 'gate',
    description: 'A policy, approval, scope, or egress gate.',
    parents: ['tool', 'step', 'task'],
    startAttributes: {
      gate_name: lowString('Governed gate identifier.'),
      policy_ref: lowString('Policy or registry reference.'),
    },
    endAttributes: {
      decision: lowString('allow, block, or ask.'),
      reason: highString('Redacted gate explanation.'),
    },
    events: COMMON_EVENTS,
    status: { default: 'ok' as const, errorWhen: 'gate denies or cannot evaluate safely' },
  },
} satisfies Readonly<Record<string, TelemetrySpanDefinition>>;

export type TraceSpanKind = keyof typeof TRACE_SPAN_DEFINITIONS;

/**
 * Exact compile-time vocabulary for span attributes. Object literals checked
 * with `satisfies ExactTelemetryAttributes<...>` reject undeclared keys while
 * keeping the runtime TraceContext API backwards-compatible for extension
 * spans that have not yet been promoted into the schema.
 */
export type ExactTelemetryAttributes<
  Kind extends TraceSpanKind,
  Phase extends 'start' | 'end' = 'start',
> = TelemetryAttributesForDefinition<
  (typeof TRACE_SPAN_DEFINITIONS)[Kind][Phase extends 'start' ? 'startAttributes' : 'endAttributes']
>;

export function resolveTraceSpanKind(name: string): TraceSpanKind | undefined {
  const normalized = name.trim().toLowerCase();
  if (normalized in TRACE_SPAN_DEFINITIONS) return normalized as TraceSpanKind;
  const match = Object.keys(TRACE_SPAN_DEFINITIONS).find(
    (kind) => normalized.startsWith(`${kind}:`) || normalized.startsWith(`${kind}_`)
  );
  return match as TraceSpanKind | undefined;
}

export function getTraceSpanDefinition(name: string): TelemetrySpanDefinition | undefined {
  const kind = resolveTraceSpanKind(name);
  return kind ? TRACE_SPAN_DEFINITIONS[kind] : undefined;
}

function valueMatchesType(value: unknown, type: TelemetryAttributeType): boolean {
  return (
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'boolean' && typeof value === 'boolean')
  );
}

export function validateTraceAttributes(
  spanName: string,
  attributes: Record<string, unknown> | undefined,
  phase: 'start' | 'end' = 'start'
): TraceSchemaIssue[] {
  const definition = getTraceSpanDefinition(spanName);
  if (!definition || !attributes) return [];
  const schema = phase === 'start' ? definition.startAttributes : definition.endAttributes;
  return Object.entries(attributes).flatMap(([key, value]) => {
    const rule = schema[key];
    if (!rule) {
      return [
        {
          path: `${spanName}.${phase}.${key}`,
          message: 'attribute is not declared by the trace schema',
        },
      ];
    }
    if (!valueMatchesType(value, rule.type)) {
      return [{ path: `${spanName}.${phase}.${key}`, message: `expected ${rule.type}` }];
    }
    if (rule.values && !rule.values.includes(String(value))) {
      return [
        {
          path: `${spanName}.${phase}.${key}`,
          message: `expected one of ${rule.values.join(', ')}`,
        },
      ];
    }
    return [];
  });
}

export function redactTraceAttributes(
  spanName: string,
  attributes: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> | undefined {
  if (!attributes) return undefined;
  const definition = getTraceSpanDefinition(spanName);
  if (!definition) return { ...attributes };
  const rules = { ...definition.startAttributes, ...definition.endAttributes };
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      rules[key]?.sensitive ? '[REDACTED]' : value,
    ])
  );
}

/** Remove high-cardinality and sensitive fields before metric aggregation. */
export function traceAttributesForMetrics(
  spanName: string,
  attributes: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> {
  if (!attributes) return {};
  const definition = getTraceSpanDefinition(spanName);
  if (!definition) return {};
  const rules = { ...definition.startAttributes, ...definition.endAttributes };
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => {
      const rule = rules[key];
      return rule && !rule.sensitive && rule.cardinality === 'low';
    })
  );
}

function redactEventAttributes(
  spanName: string,
  eventName: string,
  attributes: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> | undefined {
  if (!attributes) return undefined;
  const definition = getTraceSpanDefinition(spanName)?.events[eventName];
  if (!definition?.attributes) return redactTraceAttributes(spanName, attributes);
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      definition.attributes?.[key]?.sensitive ? '[REDACTED]' : value,
    ])
  );
}

/** Return a persistence-safe copy; the mutable TraceContext is never changed. */
export function sanitizeTraceForPersistence(trace: Trace): Trace {
  const sanitizeSpan = (span: TraceSpan): TraceSpan => ({
    ...span,
    attributes: redactTraceAttributes(span.name, span.attributes),
    events: span.events.map((event: TraceEvent) => ({
      ...event,
      attributes: redactEventAttributes(span.name, event.name, event.attributes),
    })),
    children: span.children.map(sanitizeSpan),
  });
  return { ...trace, rootSpan: sanitizeSpan(trace.rootSpan) };
}

export function validateTraceParent(
  kind: TraceSpanKind,
  parentKind?: TraceSpanKind
): TraceSchemaIssue[] {
  const definition = TRACE_SPAN_DEFINITIONS[kind];
  if (!parentKind && definition.parents.length > 0) {
    return [{ path: `${kind}.parents`, message: 'span kind requires a governed parent' }];
  }
  if (parentKind && !definition.parents.includes(parentKind)) {
    return [
      {
        path: `${kind}.parents`,
        message: `parent must be one of ${definition.parents.join(', ')}`,
      },
    ];
  }
  return [];
}

export interface TraceReplayValidationOptions {
  /** Reject extension span names that are not yet in the governed schema. */
  strictUnknownSpans?: boolean;
}

interface TraceReplayRecord {
  [key: string]: unknown;
}

function isTraceRecord(value: unknown): value is TraceReplayRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validateReplayEvent(
  spanName: string,
  eventName: string,
  attributes: unknown,
  path: string
): TraceSchemaIssue[] {
  if (attributes === undefined) return [];
  if (!isTraceRecord(attributes)) return [{ path, message: 'event attributes must be an object' }];
  const definition = getTraceSpanDefinition(spanName)?.events[eventName];
  if (!definition?.attributes) return [];
  return Object.entries(attributes).flatMap(([key, value]) => {
    const rule = definition.attributes?.[key];
    if (!rule) {
      return [{ path: `${path}.${key}`, message: 'event attribute is not declared' }];
    }
    if (!valueMatchesType(value, rule.type)) {
      return [{ path: `${path}.${key}`, message: `expected ${rule.type}` }];
    }
    if (rule.values && !rule.values.includes(String(value))) {
      return [{ path: `${path}.${key}`, message: `expected one of ${rule.values.join(', ')}` }];
    }
    return [];
  });
}

/**
 * Validate a persisted trace before replay. Extension span names remain
 * structurally replayable by default; exact governed span names receive the
 * full attribute/event contract. Callers that require a closed vocabulary can
 * pass `strictUnknownSpans: true`.
 */
export function validateTraceReplay(
  trace: unknown,
  options: TraceReplayValidationOptions = {}
): TraceSchemaIssue[] {
  const issues: TraceSchemaIssue[] = [];
  if (!isTraceRecord(trace)) return [{ path: 'trace', message: 'trace must be an object' }];
  if (typeof trace.traceId !== 'string' || !trace.traceId.trim()) {
    issues.push({ path: 'trace.traceId', message: 'traceId must be a non-empty string' });
  }
  if (!isTraceRecord(trace.rootSpan)) {
    issues.push({ path: 'trace.rootSpan', message: 'rootSpan must be an object' });
    return issues;
  }

  const visit = (span: TraceReplayRecord, parentKind: TraceSpanKind | undefined, path: string) => {
    if (typeof span.spanId !== 'string' || !span.spanId.trim()) {
      issues.push({ path: `${path}.spanId`, message: 'spanId must be a non-empty string' });
    }
    if (!validTimestamp(span.startTime)) {
      issues.push({ path: `${path}.startTime`, message: 'startTime must be an ISO timestamp' });
    }
    if (span.endTime !== undefined && !validTimestamp(span.endTime)) {
      issues.push({ path: `${path}.endTime`, message: 'endTime must be an ISO timestamp' });
    }
    const name = typeof span.name === 'string' ? span.name : '';
    if (!name) {
      issues.push({ path: `${path}.name`, message: 'span name must be a non-empty string' });
    }
    const kind = name ? resolveTraceSpanKind(name) : undefined;
    if (!kind && options.strictUnknownSpans) {
      issues.push({ path: `${path}.name`, message: `span kind is not governed: ${name}` });
    }
    if (kind && parentKind && validateTraceParent(kind, parentKind).length > 0) {
      issues.push(
        ...validateTraceParent(kind, parentKind).map((issue) => ({
          ...issue,
          path: `${path}.${issue.path}`,
        }))
      );
    }
    if (kind && name === kind && isTraceRecord(span.attributes)) {
      issues.push(...validateTraceAttributes(name, span.attributes));
    }
    if (span.status !== 'ok' && span.status !== 'error' && span.status !== 'in_progress') {
      issues.push({ path: `${path}.status`, message: 'status is invalid' });
    }
    if (span.attributes !== undefined && !isTraceRecord(span.attributes)) {
      issues.push({ path: `${path}.attributes`, message: 'attributes must be an object' });
    }
    if (!Array.isArray(span.events)) {
      issues.push({ path: `${path}.events`, message: 'events must be an array' });
    } else {
      for (const [index, event] of span.events.entries()) {
        if (!isTraceRecord(event) || typeof event.name !== 'string' || !event.name.trim()) {
          issues.push({ path: `${path}.events[${index}]`, message: 'event name is required' });
          continue;
        }
        issues.push(
          ...validateReplayEvent(
            name,
            event.name,
            event.attributes,
            `${path}.events[${index}].attributes`
          )
        );
      }
    }
    if (!Array.isArray(span.artifacts)) {
      issues.push({ path: `${path}.artifacts`, message: 'artifacts must be an array' });
    } else {
      for (const [index, artifact] of span.artifacts.entries()) {
        const artifactPath = `${path}.artifacts[${index}]`;
        if (!isTraceRecord(artifact)) {
          issues.push({ path: artifactPath, message: 'artifact must be an object' });
          continue;
        }
        if (!['screenshot', 'file', 'document', 'log'].includes(String(artifact.type))) {
          issues.push({ path: `${artifactPath}.type`, message: 'artifact type is invalid' });
        }
        if (typeof artifact.path !== 'string' || !artifact.path.trim()) {
          issues.push({ path: `${artifactPath}.path`, message: 'artifact path is required' });
        }
        if (!validTimestamp(artifact.timestamp)) {
          issues.push({
            path: `${artifactPath}.timestamp`,
            message: 'artifact timestamp must be an ISO timestamp',
          });
        }
      }
    }
    if (!Array.isArray(span.knowledgeRefs)) {
      issues.push({ path: `${path}.knowledgeRefs`, message: 'knowledgeRefs must be an array' });
    } else {
      for (const [index, ref] of span.knowledgeRefs.entries()) {
        if (typeof ref !== 'string' || !ref.trim()) {
          issues.push({
            path: `${path}.knowledgeRefs[${index}]`,
            message: 'knowledge reference must be a non-empty string',
          });
        }
      }
    }
    if (span.error !== undefined && typeof span.error !== 'string') {
      issues.push({ path: `${path}.error`, message: 'error must be a string' });
    }
    if (!Array.isArray(span.children)) {
      issues.push({ path: `${path}.children`, message: 'children must be an array' });
      return;
    }
    for (const [index, child] of span.children.entries()) {
      if (!isTraceRecord(child)) {
        issues.push({
          path: `${path}.children[${index}]`,
          message: 'child span must be an object',
        });
        continue;
      }
      visit(child, kind, `${path}.children[${index}]`);
    }
  };

  visit(trace.rootSpan, undefined, 'trace.rootSpan');
  return issues;
}
import type { Trace, TraceEvent, TraceSpan } from './src/trace.js';
