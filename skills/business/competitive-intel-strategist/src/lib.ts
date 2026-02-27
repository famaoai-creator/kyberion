import { ProjectIdentity, StrategicAction } from '@agent/core/shared-business-types';

export interface Product extends ProjectIdentity {
  features?: string[];
  pricing?: Record<string, number>;
  strengths?: string[];
  weaknesses?: string[];
}

export interface CompetitiveInput {
  our_product: Product;
  competitors: Product[];
}

export interface GapAnalysis {
  gaps: { feature: string; offeredBy: string[] }[];
  advantages: { feature: string; unique: boolean }[];
}

export interface PricingAnalysis {
  tier: string;
  ourPrice: number;
  avgCompetitorPrice: number;
  priceDifferencePercent: number;
  position: 'below_market' | 'above_market' | 'competitive';
}

export interface StrategyRecommendation extends StrategicAction {
  // area, priority, recommendation (as action) are covered or mapped
}

export interface CompetitiveResult {
  source?: string;
  ourProduct: string;
  competitorCount: number;
  gapAnalysis: GapAnalysis;
  pricingAnalysis: PricingAnalysis[];
  strategies: StrategyRecommendation[];
}

export function analyzeGaps(ourProduct: Product, competitors: Product[]): GapAnalysis {
  const ourFeatures = new Set(ourProduct.features || []);
  const gaps: GapAnalysis['gaps'] = [];
  const advantages: GapAnalysis['advantages'] = [];

  const allCompetitorFeatures = new Set<string>();
  for (const comp of competitors) {
    for (const f of comp.features || []) {
      allCompetitorFeatures.add(f);
      if (!ourFeatures.has(f)) {
        const competitorsWithFeature = competitors
          .filter((c) => (c.features || []).includes(f))
          .map((c) => c.name);
        // Only add each gap once
        if (!gaps.some((g) => g.feature === f)) {
          gaps.push({ feature: f, offeredBy: competitorsWithFeature });
        }
      }
    }
  }

  for (const f of ourFeatures) {
    if (!allCompetitorFeatures.has(f)) {
      advantages.push({ feature: f, unique: true });
    }
  }

  return { gaps, advantages };
}

export function analyzePricing(ourProduct: Product, competitors: Product[]): PricingAnalysis[] {
  const ourPricing = ourProduct.pricing || {};
  const tiers = Object.keys(ourPricing);
  const analysis: PricingAnalysis[] = [];

  for (const tier of tiers) {
    const ourPrice = ourPricing[tier];
    const competitorPrices = competitors
      .filter((c) => c.pricing && c.pricing[tier] !== undefined)
      .map((c) => ({ name: c.name, price: c.pricing[tier]! }));

    if (competitorPrices.length === 0) continue;

    const avgCompPrice =
      competitorPrices.reduce((s, c) => s + c.price, 0) / competitorPrices.length;
    const priceDiff = Math.round(((ourPrice - avgCompPrice) / avgCompPrice) * 100);

    analysis.push({
      tier,
      ourPrice,
      avgCompetitorPrice: Math.round(avgCompPrice),
      priceDifferencePercent: priceDiff,
      position: priceDiff < -10 ? 'below_market' : priceDiff > 10 ? 'above_market' : 'competitive',
    });
  }

  return analysis;
}

export function generateStrategy(
  ourProduct: Product,
  competitors: Product[],
  gapAnalysis: GapAnalysis,
  pricingAnalysis: PricingAnalysis[]
): StrategyRecommendation[] {
  const strategies: StrategyRecommendation[] = [];

  // Feature gap strategy
  if (gapAnalysis.gaps.length > 0) {
    const topGaps = gapAnalysis.gaps.slice(0, 3);
    strategies.push({
      area: 'Feature Gaps',
      priority: gapAnalysis.gaps.length > 3 ? 'high' : 'medium',
      action: `${gapAnalysis.gaps.length} features offered by competitors but not by us. Top gaps: ${topGaps.map((g) => g.feature).join(', ')}`,
    });
  }

  // Unique advantage strategy
  if (gapAnalysis.advantages.length > 0) {
    strategies.push({
      area: 'Differentiation',
      priority: 'high',
      action: `Leverage unique features: ${gapAnalysis.advantages.map((a) => a.feature).join(', ')}. Double down on marketing these differentiators.`,
    });
  }

  // Pricing strategy
  const belowMarket = pricingAnalysis.filter((p) => p.position === 'below_market');
  const aboveMarket = pricingAnalysis.filter((p) => p.position === 'above_market');
  if (belowMarket.length > 0) {
    strategies.push({
      area: 'Pricing',
      priority: 'medium',
      action: `${belowMarket.map((p) => p.tier).join(', ')} tier(s) priced below market. Consider price increase to capture margin.`,
    });
  }
  if (aboveMarket.length > 0) {
    strategies.push({
      area: 'Pricing',
      priority: 'medium',
      action: `${aboveMarket.map((p) => p.tier).join(', ')} tier(s) above market. Ensure value proposition justifies premium.`,
    });
  }

  // Weakness exploitation
  const competitorWeaknesses: { competitor: string; weakness: string }[] = [];
  for (const comp of competitors) {
    for (const w of comp.weaknesses || []) {
      competitorWeaknesses.push({ competitor: comp.name, weakness: w });
    }
  }
  if (competitorWeaknesses.length > 0) {
    strategies.push({
      area: 'Competitor Weakness',
      priority: 'high',
      action: `Exploit competitor weaknesses: ${competitorWeaknesses
        .slice(0, 3)
        .map((w) => `${w.competitor}: ${w.weakness}`)
        .join('; ')}`,
    });
  }

  // Add data-driven recommendations if input is sparse (moved here for consistency)
  if (competitors.length === 0) {
    strategies.push({
      area: 'Market Research',
      priority: 'high',
      action:
        'No competitors identified. Focus on identifying potential indirect competitors or market substitutes to validate positioning.',
    });
  }

  return strategies;
}

export function processCompetitiveAnalysis(input: CompetitiveInput): CompetitiveResult {
  const ourProduct = input.our_product;
  const competitors = input.competitors || [];

  const gapAnalysis = analyzeGaps(ourProduct, competitors);
  const pricingAnalysis = analyzePricing(ourProduct, competitors);
  const strategies = generateStrategy(ourProduct, competitors, gapAnalysis, pricingAnalysis);

  return {
    ourProduct: ourProduct.name,
    competitorCount: competitors.length,
    gapAnalysis,
    pricingAnalysis,
    strategies,
  };
}
