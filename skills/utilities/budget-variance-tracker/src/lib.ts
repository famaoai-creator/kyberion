export interface CategoryAnalysis {
  name: string;
  forecast: number;
  actual: number;
  variance: number;
  variancePercent: number;
  status: string;
  flagged: boolean;
}

export function analyzeVariance(category: any, threshold: number): CategoryAnalysis {
  const forecast = category.forecast || 0;
  const actual = category.actual || 0;
  const variance = actual - forecast;
  const variancePercent = forecast !== 0 ? Math.round((variance / forecast) * 10000) / 100 : 0;

  const isOverBudget =
    (variance > 0 && category.name.toLowerCase().includes('cost')) ||
    (variance > 0 && !category.name.toLowerCase().includes('revenue'));
  const isUnderRevenue = variance < 0 && category.name.toLowerCase().includes('revenue');

  let status = 'on_track';
  if (Math.abs(variancePercent) > threshold) {
    status = isOverBudget || isUnderRevenue ? 'negative_variance' : 'positive_variance';
  }

  return {
    name: category.name,
    forecast,
    actual,
    variance,
    variancePercent,
    status,
    flagged: Math.abs(variancePercent) > threshold,
  };
}
