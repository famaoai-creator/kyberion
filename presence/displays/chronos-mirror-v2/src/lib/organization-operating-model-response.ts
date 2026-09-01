import { isRecord } from '@agent/core/foundation';
import type { OrganizationOperatingModelView } from '../components/OrganizationOperatingModel';

type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HEALTH = ['healthy', 'degraded', 'critical', 'unknown'] as const;
const PRIORITIES = ['high', 'medium', 'low'] as const;
const INTERVENTIONS = ['reconciliation', 'project', 'incident', 'decision', 'operation'] as const;
const APPROVAL = ['draft', 'approved'] as const;
const READINESS_PURPOSE = ['missing', 'draft', 'approved'] as const;
const READINESS_OPERATIONAL = ['missing', 'available'] as const;

function safeRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) && !Object.keys(value).some((key) => DANGEROUS_KEYS.has(key))
    ? value
    : undefined;
}

function hasDangerousKeyDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDangerousKeyDeep);
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).some((key) => DANGEROUS_KEYS.has(key)) ||
    Object.values(value).some(hasDangerousKeyDeep)
  );
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : stringField(record, key);
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function enumField<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function arrayOf<T>(value: unknown, parser: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parser);
  return parsed.every((entry): entry is T => entry !== undefined) ? parsed : undefined;
}

function parseObjectives(
  value: unknown
): Array<{ objective_id: string; title: string }> | undefined {
  return arrayOf(value, (entry) => {
    const record = safeRecord(entry);
    const objective_id = record && stringField(record, 'objective_id');
    const title = record && stringField(record, 'title');
    return objective_id && title ? { objective_id, title } : undefined;
  });
}

function parseView(value: unknown): OrganizationOperatingModelView | undefined {
  const record = safeRecord(value);
  if (!record || hasDangerousKeyDeep(value)) return undefined;
  const organization_id = stringField(record, 'organization_id');
  const purposeValue = record.purpose;
  let purpose: OrganizationOperatingModelView['purpose'] = null;
  if (purposeValue !== null) {
    const source = safeRecord(purposeValue);
    const name = source && stringField(source, 'name');
    const purposeText = source && stringField(source, 'purpose');
    const approval_state = source && enumField(source.approval_state, APPROVAL);
    const objectives =
      source?.objectives === undefined ? undefined : parseObjectives(source.objectives);
    if (
      !source ||
      !name ||
      !purposeText ||
      !approval_state ||
      (source.objectives !== undefined && !objectives)
    )
      return undefined;
    purpose = { name, purpose: purposeText, approval_state, ...(objectives ? { objectives } : {}) };
  }
  const operationalSource =
    record.operational_state === null ? null : safeRecord(record.operational_state);
  const operational_state =
    operationalSource === null
      ? null
      : operationalSource && stringField(operationalSource, 'status')
        ? { status: stringField(operationalSource, 'status')! }
        : undefined;
  if (operational_state === undefined) return undefined;

  const domains = arrayOf(record.domains, (entry) => {
    const source = safeRecord(entry);
    const domain_id = source && stringField(source, 'domain_id');
    const name = source && stringField(source, 'name');
    const capability_ids = source && stringArray(source.capability_ids);
    const service_ids = source && stringArray(source.service_ids);
    return domain_id && name && capability_ids && service_ids
      ? { domain_id, name, capability_ids, service_ids }
      : undefined;
  });
  const capabilities = arrayOf(record.capabilities, (entry) => {
    const source = safeRecord(entry);
    const capability_id = source && stringField(source, 'capability_id');
    const name = source && stringField(source, 'name');
    const service_ids = source && stringArray(source.service_ids);
    return capability_id && name && service_ids ? { capability_id, name, service_ids } : undefined;
  });
  const services = arrayOf(record.services, (entry) => {
    const source = safeRecord(entry);
    const service_id = source && stringField(source, 'service_id');
    const name = source && stringField(source, 'name');
    const outcome = source && stringField(source, 'outcome');
    const status = source && stringField(source, 'status');
    return service_id && name && outcome && status
      ? { service_id, name, outcome, status }
      : undefined;
  });
  const service_states = arrayOf(record.service_states, (entry) => {
    const source = safeRecord(entry);
    const service_id = source && stringField(source, 'service_id');
    const health = source && enumField(source.health, HEALTH);
    return service_id && health ? { service_id, health } : undefined;
  });
  const operations = arrayOf(record.operations, (entry) => {
    const source = safeRecord(entry);
    const operation_id = source && stringField(source, 'operation_id');
    const name = source && stringField(source, 'name');
    const status = source && stringField(source, 'status');
    return operation_id && name && status ? { operation_id, name, status } : undefined;
  });
  const operation_states = arrayOf(record.operation_states, (entry) => {
    const source = safeRecord(entry);
    const operation_id = source && stringField(source, 'operation_id');
    const status = source && stringField(source, 'status');
    const due_status = source && optionalString(source, 'due_status');
    return operation_id && status
      ? { operation_id, status, ...(due_status ? { due_status } : {}) }
      : undefined;
  });
  const incidents = arrayOf(record.incidents, (entry) => {
    const source = safeRecord(entry);
    const incident_id = source && stringField(source, 'incident_id');
    const title = source && stringField(source, 'title');
    const severity = source && stringField(source, 'severity');
    const status = source && stringField(source, 'status');
    return incident_id && title && severity && status
      ? { incident_id, title, severity, status }
      : undefined;
  });
  const decisions = arrayOf(record.decisions, (entry) => {
    const source = safeRecord(entry);
    const decision_id = source && stringField(source, 'decision_id');
    const title = source && stringField(source, 'title');
    const status = source && stringField(source, 'status');
    return decision_id && title && status ? { decision_id, title, status } : undefined;
  });
  const solution_projects = arrayOf(record.solution_projects, (entry) => {
    const source = safeRecord(entry);
    const project_id = source && stringField(source, 'project_id');
    const name = source && stringField(source, 'name');
    const status = source && stringField(source, 'status');
    return project_id && name && status ? { project_id, name, status } : undefined;
  });
  const learning_candidates = arrayOf(record.learning_candidates, (entry) => {
    const source = safeRecord(entry);
    const learning_id = source && stringField(source, 'learning_id');
    const title = source && stringField(source, 'title');
    const status = source && stringField(source, 'status');
    return learning_id && title && status ? { learning_id, title, status } : undefined;
  });
  if (
    !organization_id ||
    !domains ||
    !capabilities ||
    !services ||
    !service_states ||
    !operations ||
    !operation_states ||
    !incidents ||
    !decisions ||
    !solution_projects ||
    !learning_candidates
  )
    return undefined;

  const reconciliationSource = safeRecord(record.reconciliation);
  const reconciliationStatus = reconciliationSource && stringField(reconciliationSource, 'status');
  const overdue_operations =
    reconciliationSource && stringArray(reconciliationSource.overdue_operations);
  const stale_services = reconciliationSource && stringArray(reconciliationSource.stale_services);
  const pending_decisions =
    reconciliationSource && stringArray(reconciliationSource.pending_decisions);
  if (
    !reconciliationSource ||
    !reconciliationStatus ||
    !overdue_operations ||
    !stale_services ||
    !pending_decisions
  )
    return undefined;

  const control = safeRecord(record.control_plane);
  const accounting = control && safeRecord(control.accounting);
  const accountingKeys = [
    'active_projects',
    'active_services',
    'healthy_services',
    'degraded_or_critical_services',
    'active_operations',
    'overdue_operations',
    'open_incidents',
    'pending_decisions',
  ] as const;
  const accountingValues = accountingKeys.map((key) => accounting && numberField(accounting, key));
  const intervention_points =
    control &&
    arrayOf(control.intervention_points, (entry) => {
      const source = safeRecord(entry);
      const kind = source && enumField(source.kind, INTERVENTIONS);
      const id = source && stringField(source, 'id');
      const priority = source && enumField(source.priority, PRIORITIES);
      const reason = source && stringField(source, 'reason');
      return kind && id && priority && reason ? { kind, id, priority, reason } : undefined;
    });
  const outcome = control && safeRecord(control.outcome_accounting);
  const outcomeObjectives =
    outcome &&
    arrayOf(outcome.objectives, (entry) => {
      const source = safeRecord(entry);
      const objective_id = source && stringField(source, 'objective_id');
      const title = source && stringField(source, 'title');
      const coverage = source && enumField(source.coverage, ['linked', 'unlinked'] as const);
      return objective_id && title && coverage ? { objective_id, title, coverage } : undefined;
    });
  if (
    !accounting ||
    accountingValues.some((entry) => entry === undefined) ||
    !intervention_points ||
    !outcomeObjectives
  )
    return undefined;

  const readinessSource = safeRecord(record.readiness);
  const readinessPurpose = readinessSource && enumField(readinessSource.purpose, READINESS_PURPOSE);
  const readinessOperational =
    readinessSource && enumField(readinessSource.operational_state, READINESS_OPERATIONAL);
  const pendingHuman = readinessSource && numberField(readinessSource, 'pending_human_decisions');
  if (!readinessSource || !readinessPurpose || !readinessOperational || pendingHuman === undefined)
    return undefined;

  return {
    organization_id,
    purpose,
    operational_state,
    domains,
    capabilities,
    services,
    service_states,
    operations,
    operation_states,
    incidents,
    decisions,
    solution_projects,
    learning_candidates,
    reconciliation: {
      status: reconciliationStatus,
      overdue_operations,
      stale_services,
      pending_decisions,
    },
    control_plane: {
      accounting: Object.fromEntries(
        accountingKeys.map((key, index) => [key, accountingValues[index]])
      ) as OrganizationOperatingModelView['control_plane']['accounting'],
      intervention_points,
      outcome_accounting: { objectives: outcomeObjectives },
    },
    readiness: {
      purpose: readinessPurpose,
      operational_state: readinessOperational,
      pending_human_decisions: pendingHuman,
    },
  };
}

export function parseOrganizationOperatingModelResponse(value: unknown):
  | {
      view: OrganizationOperatingModelView;
      tenant?: { company_id: string; tenant_slug: string; name: string };
    }
  | undefined {
  const record = safeRecord(value);
  if (!record) return undefined;
  const view = parseView(record.view);
  if (!view) return undefined;
  if (record.tenant === undefined) return { view };
  const tenant = safeRecord(record.tenant);
  const company_id = tenant && stringField(tenant, 'company_id');
  const tenant_slug = tenant && stringField(tenant, 'tenant_slug');
  const name = tenant && stringField(tenant, 'name');
  return company_id && tenant_slug && name
    ? { view, tenant: { company_id, tenant_slug, name } }
    : undefined;
}
