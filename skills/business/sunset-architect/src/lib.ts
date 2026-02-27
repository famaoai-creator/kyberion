import { StrategicAction } from '@agent/core/shared-business-types';

export interface FeatureData {
  name: string;
  reason?: string;
  active_users?: number;
  monthly_revenue?: number;
  dependencies?: string[];
}

export interface TimelinePhase {
  phase: string;
  week: number;
  action: string;
  status: 'pending' | 'completed';
}

export interface ImpactAssessment {
  activeUsers: number;
  monthlyRevenue: number;
  dependencyCount: number;
  dependencies: string[];
  risk: 'low' | 'medium' | 'high';
  migrationComplexity: 'low' | 'medium' | 'high';
}

export interface SunsetPlan {
  feature: string;
  reason: string;
  impact: ImpactAssessment;
  deprecationTimeline: TimelinePhase[];
}

export interface SunsetResult {
  source?: string;
  featureCount: number;
  plans: SunsetPlan[];
  totalAffectedUsers: number;
  totalRevenueImpact: number;
  recommendations: StrategicAction[];
}

export function planDeprecation(featureName: string): TimelinePhase[] {
  return [
    {
      phase: 'Announce',
      week: 1,
      action: `Announce deprecation of "${featureName}" via changelog and in-app notice`,
      status: 'pending',
    },
    {
      phase: 'Soft Deprecation',
      week: 2,
      action: 'Add deprecation warnings in logs and API responses',
      status: 'pending',
    },
    {
      phase: 'Migration Support',
      week: 4,
      action: 'Provide migration guide and alternative recommendations',
      status: 'pending',
    },
    {
      phase: 'Hard Deprecation',
      week: 8,
      action: 'Return errors for deprecated endpoints, disable UI features',
      status: 'pending',
    },
    {
      phase: 'Data Archive',
      week: 10,
      action: 'Archive related data, export user data if applicable',
      status: 'pending',
    },
    {
      phase: 'Removal',
      week: 12,
      action: 'Remove code, clean up database, update documentation',
      status: 'pending',
    },
  ];
}

export function assessImpact(feature: FeatureData): ImpactAssessment {
  const users = feature.active_users || 0;
  const revenue = feature.monthly_revenue || 0;
  const dependencies = feature.dependencies || [];

  let risk: ImpactAssessment['risk'] = 'low';
  if (users > 1000 || revenue > 5000) risk = 'high';
  else if (users > 100 || revenue > 500) risk = 'medium';

  return {
    activeUsers: users,
    monthlyRevenue: revenue,
    dependencyCount: dependencies.length,
    dependencies,
    risk,
    migrationComplexity:
      dependencies.length > 3 ? 'high' : dependencies.length > 0 ? 'medium' : 'low',
  };
}

export function processSunsetPlans(features: FeatureData[]): Omit<SunsetResult, 'source'> {
  const plans = features.map((f) => ({
    feature: f.name || 'unnamed-feature',
    reason: f.reason || 'End of life',
    impact: assessImpact(f),
    deprecationTimeline: planDeprecation(f.name || 'unnamed-feature'),
  }));

  const recommendations: StrategicAction[] = [];

  plans
    .filter((p) => p.impact.risk === 'high')
    .forEach((p) => {
      recommendations.push({
        action: `Careful migration needed for "${p.feature}" due to high active user count (${p.impact.activeUsers})`,
        priority: 'high',
        area: 'User Retention',
      });
    });

  // Schedule density check
  if (plans.length > 3) {
    recommendations.push({
      action: `Manage communication overhead for simultaneous sunset of ${plans.length} features`,
      priority: 'medium',
      area: 'Customer Communication',
    });
  }

  if (plans.length > 0) {
    recommendations.push({
      action: 'Execute 12-week standard deprecation timeline for all selected features',
      priority: 'low',
      area: 'SDLC',
    });
  }

  return {
    featureCount: plans.length,
    plans,
    totalAffectedUsers: plans.reduce((s, p) => s + p.impact.activeUsers, 0),
    totalRevenueImpact: plans.reduce((s, p) => s + p.impact.monthlyRevenue, 0),
    recommendations,
  };
}
