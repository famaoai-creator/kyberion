export interface CostEstimateResult {
  totalCost: number;
  findings: any[];
}

export function estimateCosts(
  adf: any,
  instancePricing: any,
  optimizationRules: any[]
): CostEstimateResult {
  let totalMonthlyCost = 0;
  const findings: any[] = [];

  if (!adf.nodes || !Array.isArray(adf.nodes)) return { totalCost: 0, findings: [] };

  adf.nodes.forEach((node: any) => {
    const pricing = instancePricing[node.type];
    if (pricing) {
      const unitCost = pricing[node.details?.size || 't3.micro'] || 0.01;
      const monthlyCost = unitCost * 24 * 30;
      totalMonthlyCost += monthlyCost;

      optimizationRules.forEach((rule) => {
        if (node.type === rule.target) {
          findings.push({
            resource: node.id,
            action: rule.action,
            potential_savings: rule.savings ? monthlyCost * rule.savings : 0,
          });
        }
      });
    }
  });

  return { totalCost: totalMonthlyCost, findings };
}
