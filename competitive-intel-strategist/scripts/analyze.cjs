#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * competitive-intel-strategist: Analyzes competitive landscape from a JSON data file.
 * Performs gap analysis, identifies differentiation opportunities, and generates strategy.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON file with competitive data',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

/**
 * Expected input JSON:
 * {
 *   "our_product": {
 *     "name": "Our SaaS",
 *     "features": ["API", "Dashboard", "SSO", "Webhooks"],
 *     "pricing": { "basic": 29, "pro": 99, "enterprise": 299 },
 *     "strengths": ["Fast API", "Developer experience"],
 *     "weaknesses": ["Limited integrations", "No mobile app"]
 *   },
 *   "competitors": [
 *     {
 *       "name": "Competitor A",
 *       "features": ["API", "Dashboard", "Mobile App", "AI Assistant"],
 *       "pricing": { "basic": 39, "pro": 129 },
 *       "strengths": ["Brand recognition", "Mobile app"],
 *       "weaknesses": ["Slow API", "Complex pricing"]
 *     }
 *   ]
 * }
 */

function analyzeGaps(ourProduct, competitors) {
  const ourFeatures = new Set(ourProduct.features || []);
  const gaps = [];
  const advantages = [];

  const allCompetitorFeatures = new Set();
  for (const comp of competitors) {
    for (const f of comp.features || []) {
      allCompetitorFeatures.add(f);
      if (!ourFeatures.has(f)) {
        const competitorsWithFeature = competitors
          .filter((c) => (c.features || []).includes(f))
          .map((c) => c.name);
        gaps.push({ feature: f, offeredBy: competitorsWithFeature });
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

function analyzePricing(ourProduct, competitors) {
  const ourPricing = ourProduct.pricing || {};
  const tiers = Object.keys(ourPricing);
  const analysis = [];

  for (const tier of tiers) {
    const ourPrice = ourPricing[tier];
    const competitorPrices = competitors
      .filter((c) => c.pricing && c.pricing[tier] !== undefined)
      .map((c) => ({ name: c.name, price: c.pricing[tier] }));

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

function generateStrategy(ourProduct, competitors, gapAnalysis, pricingAnalysis) {
  const strategies = [];

  // Feature gap strategy
  if (gapAnalysis.gaps.length > 0) {
    const topGaps = gapAnalysis.gaps.slice(0, 3);
    strategies.push({
      area: 'Feature Gaps',
      priority: gapAnalysis.gaps.length > 3 ? 'high' : 'medium',
      recommendation: `${gapAnalysis.gaps.length} features offered by competitors but not by us. Top gaps: ${topGaps.map((g) => g.feature).join(', ')}`,
    });
  }

  // Unique advantage strategy
  if (gapAnalysis.advantages.length > 0) {
    strategies.push({
      area: 'Differentiation',
      priority: 'high',
      recommendation: `Leverage unique features: ${gapAnalysis.advantages.map((a) => a.feature).join(', ')}. Double down on marketing these differentiators.`,
    });
  }

  // Pricing strategy
  const belowMarket = pricingAnalysis.filter((p) => p.position === 'below_market');
  const aboveMarket = pricingAnalysis.filter((p) => p.position === 'above_market');
  if (belowMarket.length > 0) {
    strategies.push({
      area: 'Pricing',
      priority: 'medium',
      recommendation: `${belowMarket.map((p) => p.tier).join(', ')} tier(s) priced below market. Consider price increase to capture margin.`,
    });
  }
  if (aboveMarket.length > 0) {
    strategies.push({
      area: 'Pricing',
      priority: 'medium',
      recommendation: `${aboveMarket.map((p) => p.tier).join(', ')} tier(s) above market. Ensure value proposition justifies premium.`,
    });
  }

  // Weakness exploitation
  const competitorWeaknesses = [];
  for (const comp of competitors) {
    for (const w of comp.weaknesses || []) {
      competitorWeaknesses.push({ competitor: comp.name, weakness: w });
    }
  }
  if (competitorWeaknesses.length > 0) {
    strategies.push({
      area: 'Competitor Weakness',
      priority: 'high',
      recommendation: `Exploit competitor weaknesses: ${competitorWeaknesses
        .slice(0, 3)
        .map((w) => `${w.competitor}: ${w.weakness}`)
        .join('; ')}`,
    });
  }

  return strategies;
}

runSkill('competitive-intel-strategist', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!data.our_product) throw new Error('Input must contain "our_product" object');
  if (!data.competitors || !Array.isArray(data.competitors))
    throw new Error('Input must contain "competitors" array');

  const gapAnalysis = analyzeGaps(data.our_product, data.competitors);
  const pricingAnalysis = analyzePricing(data.our_product, data.competitors);
  const strategies = generateStrategy(
    data.our_product,
    data.competitors,
    gapAnalysis,
    pricingAnalysis
  );

  const result = {
    source: path.basename(resolved),
    ourProduct: data.our_product.name,
    competitorCount: data.competitors.length,
    gapAnalysis,
    pricingAnalysis,
    strategies,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
