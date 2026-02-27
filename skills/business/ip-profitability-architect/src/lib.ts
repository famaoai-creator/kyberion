import {
  ProjectIdentity,
  FinancialMetrics,
  StrategicAction,
} from '@agent/core/shared-business-types';

export interface IPAsset extends ProjectIdentity {
  type?: string;
  status?: string;
  development_cost?: number; // Initial investment
  annual_maintenance?: number; // Annual recurring cost
  potential_annual_revenue?: number;
}

export interface IPAnalysisResult extends IPAsset {
  roi: number;
  profitability: 'high' | 'medium' | 'low' | 'negative';
}

export interface LicensingModel {
  type: string;
  description: string;
  estimatedRevenue: number;
}

export interface AssetLicensing {
  asset: string;
  models: LicensingModel[];
}

export interface PortfolioSummary {
  totalInvestment: number;
  totalPotentialRevenue: number;
  portfolioROI: number;
}

export interface IPStrategyResult {
  source?: string;
  assetCount: number;
  assets: IPAnalysisResult[];
  licensing: AssetLicensing[];
  portfolio: PortfolioSummary;
  recommendations: StrategicAction[];
}

export function analyzeIPAssets(assets: IPAsset[]): IPAnalysisResult[] {
  return assets.map((asset) => {
    const developmentCost = Math.max(0, asset.development_cost || 0);
    const annualMaintenance = Math.max(0, asset.annual_maintenance || 0);
    const potentialRevenue = Math.max(0, asset.potential_annual_revenue || 0);

    // Calculate ROI, handle zero development cost case (infinity ROI capped at 9999%)
    let roi = 0;
    if (developmentCost > 0) {
      roi = Math.round(((potentialRevenue - annualMaintenance) / developmentCost) * 100);
    } else if (potentialRevenue > annualMaintenance) {
      roi = 9999; // Capped representative high ROI
    }

    let profitability: IPAnalysisResult['profitability'] = 'negative';
    if (roi > 100) profitability = 'high';
    else if (roi > 50) profitability = 'medium';
    else if (roi > 0) profitability = 'low';

    return {
      ...asset,
      development_cost: developmentCost,
      annual_maintenance: annualMaintenance,
      potential_annual_revenue: potentialRevenue,
      roi,
      profitability,
    } as IPAnalysisResult;
  });
}

export function designLicensingModels(assets: IPAnalysisResult[]): AssetLicensing[] {
  const models: AssetLicensing[] = [];
  for (const asset of assets) {
    if (asset.profitability === 'high' || asset.profitability === 'medium') {
      const revenue = asset.potential_annual_revenue || 0;
      models.push({
        asset: asset.name,
        models: [
          {
            type: 'SaaS License',
            description: 'Monthly/annual subscription access',
            estimatedRevenue: Math.round(revenue * 0.7),
          },
          {
            type: 'Enterprise License',
            description: 'Unlimited use for large organizations',
            estimatedRevenue: Math.round(revenue * 1.2),
          },
          {
            type: 'Open Core',
            description: 'Free base + paid premium features',
            estimatedRevenue: Math.round(revenue * 0.4),
          },
        ],
      });
    }
  }
  return models;
}

export function processIPStrategy(assets: IPAsset[]): Omit<IPStrategyResult, 'source'> {
  const analyzedAssets = analyzeIPAssets(assets);
  const licensing = designLicensingModels(analyzedAssets);

  const totalCost = analyzedAssets.reduce(
    (s, a) => s + (a.development_cost || 0) + (a.annual_maintenance || 0),
    0
  );
  const totalPotential = analyzedAssets.reduce((s, a) => s + (a.potential_annual_revenue || 0), 0);

  const portfolioROI =
    totalCost > 0 ? Math.round(((totalPotential - totalCost) / totalCost) * 100) : 0;

  return {
    assetCount: analyzedAssets.length,
    assets: analyzedAssets,
    licensing,
    portfolio: {
      totalInvestment: totalCost,
      totalPotentialRevenue: totalPotential,
      portfolioROI,
    },
    recommendations: analyzedAssets
      .filter((a) => a.profitability === 'high')
      .map((a) => ({
        action: `Prioritize commercialization of ${a.name} (ROI ${a.roi}%)`,
        priority: 'high',
        area: 'Commercialization',
        expectedImpact: `Potential annual revenue up to ${a.potential_annual_revenue}`,
      })),
  };
}
