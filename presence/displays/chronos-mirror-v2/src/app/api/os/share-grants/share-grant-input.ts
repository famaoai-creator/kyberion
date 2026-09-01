import {
  SHARE_GRANT_ROLES,
  SHARE_GRANT_TAINTS,
  SHARE_LINK_MAX_TTL_MS,
  type ShareGrantRole,
  type ShareGrantTaint,
} from '@agent/core/share-grant-graph';

const OPERATIONS = [
  'register_resource',
  'grant_edge',
  'revoke_edge',
  'issue_link',
  'revoke_link',
  'register_session',
] as const;

type ShareGrantOperation = (typeof OPERATIONS)[number];

export type ShareGrantRequestInput =
  | {
      operation: 'register_resource';
      resourceRef: string;
      tenantSlug: string;
      taint: ShareGrantTaint;
      provenanceMissionId?: string;
    }
  | {
      operation: 'grant_edge';
      resourceRef: string;
      grantee: string;
      targetTenantSlug: string;
      role: ShareGrantRole;
      audienceFloor?: ShareGrantTaint;
    }
  | { operation: 'revoke_edge'; edgeId: string }
  | {
      operation: 'issue_link';
      resourceRef: string;
      role: ShareGrantRole;
      ttlMs?: number;
      expiresAt?: string;
      audienceFloor?: ShareGrantTaint;
    }
  | { operation: 'revoke_link'; linkId: string }
  | {
      operation: 'register_session';
      resourceRef: string;
      token: string;
      sessionId: string;
      connectedAt?: string;
    };

function assertKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const unexpected = Object.keys(record).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`unexpected share grant field: ${unexpected}`);
}

function requiredString(record: Record<string, unknown>, key: string, max = 512): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${key} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  max = 512
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`${key} must be a string up to ${max} characters`);
  }
  return value.trim() || undefined;
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T {
  const value = requiredString(record, key, 64);
  if (!values.includes(value as T)) throw new Error(`${key} is invalid`);
  return value as T;
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T | undefined {
  if (record[key] === undefined) return undefined;
  return enumValue(record, key, values);
}

export function parseShareGrantInput(value: unknown): ShareGrantRequestInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('share grant payload must be an object');
  }
  const record = value as Record<string, unknown>;
  const operationValue = record.operation;
  if (
    typeof operationValue !== 'string' ||
    !OPERATIONS.includes(operationValue as ShareGrantOperation)
  ) {
    throw new Error('operation is invalid');
  }
  const operation = operationValue as ShareGrantOperation;

  switch (operation) {
    case 'register_resource': {
      assertKeys(record, [
        'operation',
        'resourceRef',
        'tenantSlug',
        'taint',
        'provenanceMissionId',
      ]);
      const taint = enumValue(record, 'taint', SHARE_GRANT_TAINTS);
      const provenanceMissionId = optionalString(record, 'provenanceMissionId');
      if (taint !== 'public' && !provenanceMissionId) {
        throw new Error('provenanceMissionId is required for non-public taint');
      }
      return {
        operation,
        resourceRef: requiredString(record, 'resourceRef'),
        tenantSlug: requiredString(record, 'tenantSlug', 128),
        taint,
        ...(provenanceMissionId ? { provenanceMissionId } : {}),
      };
    }
    case 'grant_edge': {
      assertKeys(record, [
        'operation',
        'resourceRef',
        'grantee',
        'targetTenantSlug',
        'role',
        'audienceFloor',
      ]);
      const audienceFloor = optionalEnum(record, 'audienceFloor', SHARE_GRANT_TAINTS);
      return {
        operation,
        resourceRef: requiredString(record, 'resourceRef'),
        grantee: requiredString(record, 'grantee'),
        targetTenantSlug: requiredString(record, 'targetTenantSlug', 128),
        role: enumValue(record, 'role', SHARE_GRANT_ROLES),
        ...(audienceFloor ? { audienceFloor } : {}),
      };
    }
    case 'revoke_edge':
      assertKeys(record, ['operation', 'edgeId']);
      return { operation, edgeId: requiredString(record, 'edgeId') };
    case 'issue_link': {
      assertKeys(record, [
        'operation',
        'resourceRef',
        'role',
        'ttlMs',
        'expiresAt',
        'audienceFloor',
      ]);
      const ttlMs = record.ttlMs;
      if (
        ttlMs !== undefined &&
        (typeof ttlMs !== 'number' ||
          !Number.isSafeInteger(ttlMs) ||
          ttlMs < 1 ||
          ttlMs > SHARE_LINK_MAX_TTL_MS)
      ) {
        throw new Error(`ttlMs must be an integer between 1 and ${SHARE_LINK_MAX_TTL_MS}`);
      }
      const expiresAt = optionalString(record, 'expiresAt', 128);
      if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
        throw new Error('expiresAt must be a valid date');
      }
      const audienceFloor = optionalEnum(record, 'audienceFloor', SHARE_GRANT_TAINTS);
      return {
        operation,
        resourceRef: requiredString(record, 'resourceRef'),
        role: enumValue(record, 'role', SHARE_GRANT_ROLES),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(audienceFloor ? { audienceFloor } : {}),
      };
    }
    case 'revoke_link':
      assertKeys(record, ['operation', 'linkId']);
      return { operation, linkId: requiredString(record, 'linkId') };
    case 'register_session': {
      assertKeys(record, ['operation', 'resourceRef', 'token', 'sessionId', 'connectedAt']);
      const connectedAt = optionalString(record, 'connectedAt', 128);
      if (connectedAt && !Number.isFinite(Date.parse(connectedAt))) {
        throw new Error('connectedAt must be a valid date');
      }
      return {
        operation,
        resourceRef: requiredString(record, 'resourceRef'),
        token: requiredString(record, 'token'),
        sessionId: requiredString(record, 'sessionId'),
        ...(connectedAt ? { connectedAt } : {}),
      };
    }
  }
}
