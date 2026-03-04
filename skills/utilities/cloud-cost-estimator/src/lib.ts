/**
 * Cloud Cost Estimator Core Library.
 * Estimates monthly/yearly infrastructure costs based on resource definitions.
 */

export interface CloudService {
  name: string;
  type: 'compute' | 'database' | 'storage' | 'cache' | 'serverless';
  provider: 'aws' | 'azure' | 'gcp';
  size: 'small' | 'medium' | 'large' | 'xlarge';
  count?: number;
}

const UNIT_PRICES: Record<string, Record<string, number>> = {
  compute: { small: 15, medium: 45, large: 120, xlarge: 300 },
  database: { small: 30, medium: 90, large: 240, xlarge: 600 },
  storage: { small: 5, medium: 20, large: 100, xlarge: 250 },
  cache: { small: 20, medium: 60, large: 150, xlarge: 400 },
  serverless: { small: 2, medium: 10, large: 50, xlarge: 100 },
};

export function estimateServiceCost(service: CloudService): number {
  const basePrice = UNIT_PRICES[service.type]?.[service.size] || 10;
  return basePrice * (service.count || 1);
}

export function generateRecommendations(services: CloudService[]): string[] {
  const recs: string[] = [];
  const largeCount = services.filter(s => s.size === 'xlarge').length;
  
  if (largeCount > 0) {
    recs.push(`Detected ${largeCount} xlarge resources. Consider reserved instances or spot instances for savings.`);
  }
  
  const computeCount = services.filter(s => s.type === 'compute').length;
  if (computeCount > 5) {
    recs.push('High compute count. Review autoscaling policies to optimize idle capacity.');
  }

  return recs;
}

export function calculateTotalProjectedCost(services: CloudService[]) {
  const totalMonthly = services.reduce((sum, s) => sum + estimateServiceCost(s), 0);
  return {
    monthly: totalMonthly,
    yearly: totalMonthly * 12
  };
}

export function estimateCosts(services: CloudService[]) {
  return calculateTotalProjectedCost(services);
}
