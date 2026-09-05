/**
 * libs/core/dynamic-permission-guard.ts
 * Kyberion Autonomous Nerve System (KANS) - Dynamic Permission Guard v1.0
 * [CORE COMPONENT - DIRECT FS AUTHORIZED]
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';
import { sensoryMemory } from './sensory-memory.js';
import { createLogger } from './logger.js';

const logger = createLogger('dynamic-permission-guard');

export interface DynamicPolicy {
  id: string;
  condition: {
    intent: string;
    keyword?: string;
    lookback_ms: number;
  };
  grant: {
    role: string;
    allow_paths: string[];
  };
}

interface DynamicPolicyFile {
  version: string;
  policies: DynamicPolicy[];
}

const POLICY_PATH = pathResolver.resolve('knowledge/product/governance/dynamic-policies.json');
const POLICY_SCHEMA_PATH = pathResolver.resolve(
  'knowledge/product/schemas/dynamic-permission-policy.schema.json'
);
const dynamicPolicyCatalog = defineCatalog<DynamicPolicyFile>({
  id: 'dynamic-permission-policy',
  path: POLICY_PATH,
  schema: POLICY_SCHEMA_PATH,
});

class DynamicPermissionGuard {
  private static instance: DynamicPermissionGuard;
  private policies: DynamicPolicy[] = [];

  private constructor() {
    this.loadPolicies();
  }

  public static getInstance(): DynamicPermissionGuard {
    if (!DynamicPermissionGuard.instance) {
      DynamicPermissionGuard.instance = new DynamicPermissionGuard();
    }
    return DynamicPermissionGuard.instance;
  }

  public loadPolicies() {
    if (!safeExistsSync(POLICY_PATH)) {
      this.policies = [];
      return;
    }
    try {
      this.policies = dynamicPolicyCatalog.load().policies;
    } catch (err) {
      this.policies = [];
      // Fail-closed (no dynamic grants), but never silently: operators must see why grants vanished.
      logger.warn(`dynamic-policies.json unreadable — no dynamic grants active: ${err}`);
    }
  }

  public evaluate(role: string, filePath: string): { allowed: boolean; reason?: string } {
    const relativePath = path.relative(pathResolver.rootDir(), filePath);

    for (const policy of this.policies) {
      if (policy.grant.role !== role) continue;

      const pathMatch = policy.grant.allow_paths.some((p) => relativePath.startsWith(p));
      if (!pathMatch) continue;

      // EV-04: both branches are bounded by lookback_ms. The intent-only branch
      // used to ignore it entirely, so one historical stimulus kept the grant
      // open permanently — the opposite of a time-boxed emergency grant.
      const isContextActive = policy.condition.keyword
        ? sensoryMemory.hasActiveContext(policy.condition.keyword, policy.condition.lookback_ms)
        : Boolean(
            sensoryMemory.getLatestByIntent(policy.condition.intent, policy.condition.lookback_ms)
          );

      if (isContextActive) {
        return { allowed: true, reason: `Contextual grant via ${policy.id}` };
      }
    }

    return { allowed: false };
  }
}

export const dynamicPermGuard = DynamicPermissionGuard.getInstance();
