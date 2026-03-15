/**
 * libs/core/dynamic-permission-guard.ts
 * Kyberion Autonomous Nerve System (KANS) - Dynamic Permission Guard v1.0
 * [CORE COMPONENT - DIRECT FS AUTHORIZED]
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { sensoryMemory } from './sensory-memory.js';

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

class DynamicPermissionGuard {
  private static instance: DynamicPermissionGuard;
  private policies: DynamicPolicy[] = [];
  private readonly POLICY_PATH = pathResolver.resolve('knowledge/governance/dynamic-policies.json');

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
    if (!safeExistsSync(this.POLICY_PATH)) return;
    try {
      const content = safeReadFile(this.POLICY_PATH, { encoding: 'utf8' }) as string;
      this.policies = JSON.parse(content).policies;
    } catch (_) {}
  }

  public evaluate(role: string, filePath: string): { allowed: boolean; reason?: string } {
    const relativePath = path.relative(process.cwd(), filePath);

    for (const policy of this.policies) {
      if (policy.grant.role !== role) continue;

      const pathMatch = policy.grant.allow_paths.some(p => relativePath.startsWith(p));
      if (!pathMatch) continue;

      const isContextActive = policy.condition.keyword 
        ? sensoryMemory.hasActiveContext(policy.condition.keyword, policy.condition.lookback_ms)
        : !!sensoryMemory.getLatestByIntent(policy.condition.intent);

      if (isContextActive) {
        return { allowed: true, reason: `Contextual grant via ${policy.id}` };
      }
    }

    return { allowed: false };
  }
}

export const dynamicPermGuard = DynamicPermissionGuard.getInstance();
