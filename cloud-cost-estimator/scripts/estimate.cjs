#!/usr/bin/env node
/**
 * cloud-cost-estimator: Estimates cloud infrastructure costs based on a
 * YAML or JSON configuration file defining services.
 *
 * Usage:
 *   node estimate.cjs --input <config-file.yaml|config-file.json>
 *
 * Config format (YAML or JSON):
 *   services:
 *     - name: web-server
 *       type: compute
 *       provider: aws
 *       size: medium
 *       count: 2
 *     - name: database
 *       type: database
 *       provider: aws
 *       size: large
 *       engine: postgres
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to a YAML or JSON config file defining cloud services',
  })
  .help()
  .argv;

// --- Pricing heuristics (monthly USD, approximate on-demand pricing) ---
const PRICING = {
  compute: {
    aws: { small: 15, medium: 70, large: 140, xlarge: 280 },
    azure: { small: 14, medium: 65, large: 135, xlarge: 270 },
    gcp: { small: 12, medium: 60, large: 125, xlarge: 250 },
  },
  database: {
    aws: { small: 25, medium: 100, large: 350, xlarge: 700 },
    azure: { small: 28, medium: 110, large: 370, xlarge: 750 },
    gcp: { small: 22, medium: 95, large: 330, xlarge: 680 },
  },
  storage: {
    aws: { small: 5, medium: 23, large: 50, xlarge: 100 },
    azure: { small: 5, medium: 21, large: 48, xlarge: 95 },
    gcp: { small: 4, medium: 20, large: 45, xlarge: 90 },
  },
  cache: {
    aws: { small: 15, medium: 50, large: 150, xlarge: 300 },
    azure: { small: 16, medium: 55, large: 160, xlarge: 320 },
    gcp: { small: 13, medium: 45, large: 140, xlarge: 280 },
  },
  loadbalancer: {
    aws: { small: 18, medium: 18, large: 18, xlarge: 18 },
    azure: { small: 20, medium: 20, large: 20, xlarge: 20 },
    gcp: { small: 18, medium: 18, large: 18, xlarge: 18 },
  },
  cdn: {
    aws: { small: 10, medium: 50, large: 200, xlarge: 500 },
    azure: { small: 12, medium: 55, large: 220, xlarge: 530 },
    gcp: { small: 8, medium: 45, large: 180, xlarge: 450 },
  },
  serverless: {
    aws: { small: 5, medium: 20, large: 80, xlarge: 200 },
    azure: { small: 5, medium: 18, large: 75, xlarge: 190 },
    gcp: { small: 4, medium: 17, large: 70, xlarge: 180 },
  },
  queue: {
    aws: { small: 1, medium: 5, large: 25, xlarge: 100 },
    azure: { small: 1, medium: 5, large: 28, xlarge: 110 },
    gcp: { small: 1, medium: 4, large: 22, xlarge: 90 },
  },
};

const DEFAULT_PROVIDER = 'aws';
const DEFAULT_SIZE = 'medium';
const DEFAULT_COUNT = 1;

/**
 * Parse a config file (YAML or JSON).
 * @param {string} filePath
 * @returns {Object}
 */
function parseConfig(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
    }
  }

  // Default to YAML for .yml, .yaml, or unrecognized extensions
  try {
    return yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in ${filePath}: ${err.message}`);
  }
}

/**
 * Look up monthly cost for a service.
 * @param {Object} service
 * @returns {number}
 */
function lookupCost(service) {
  const type = (service.type || 'compute').toLowerCase();
  const provider = (service.provider || DEFAULT_PROVIDER).toLowerCase();
  const size = (service.size || DEFAULT_SIZE).toLowerCase();
  const count = service.count || DEFAULT_COUNT;

  const typePricing = PRICING[type];
  if (!typePricing) {
    // Unknown type: return a conservative estimate
    return count * 50;
  }

  const providerPricing = typePricing[provider] || typePricing[DEFAULT_PROVIDER];
  if (!providerPricing) {
    return count * 50;
  }

  const unitCost = providerPricing[size] !== undefined ? providerPricing[size] : providerPricing[DEFAULT_SIZE];
  return count * unitCost;
}

/**
 * Generate cost optimization recommendations.
 * @param {Object[]} costResults
 * @param {number} totalMonthlyCost
 * @returns {string[]}
 */
function generateRecommendations(costResults, totalMonthlyCost) {
  const recommendations = [];

  // Check for expensive compute instances
  const largeCompute = costResults.filter(
    (s) => s.type === 'compute' && (s.size === 'large' || s.size === 'xlarge')
  );
  if (largeCompute.length > 0) {
    recommendations.push(
      `Consider using reserved instances or spot instances for ${largeCompute.map((s) => s.name).join(', ')} to reduce compute costs by 30-60%.`
    );
  }

  // Check for multiple similar services that could be consolidated
  const typeGroups = {};
  for (const s of costResults) {
    if (!typeGroups[s.type]) typeGroups[s.type] = [];
    typeGroups[s.type].push(s);
  }
  for (const [type, services] of Object.entries(typeGroups)) {
    if (services.length > 3) {
      recommendations.push(
        `${services.length} ${type} services detected. Consider consolidation or using managed container orchestration to reduce overhead.`
      );
    }
  }

  // Multi-provider warning
  const providers = new Set(costResults.map((s) => s.provider));
  if (providers.size > 1) {
    recommendations.push(
      `Multi-cloud setup detected (${[...providers].join(', ')}). Evaluate data transfer costs between providers and consider committed-use discounts per provider.`
    );
  }

  // High total cost
  if (totalMonthlyCost > 5000) {
    recommendations.push(
      `Total monthly cost exceeds $5,000. Consider engaging a cloud cost management tool (e.g., AWS Cost Explorer, GCP Recommender) for detailed optimization.`
    );
  }

  if (totalMonthlyCost > 1000) {
    recommendations.push(
      'Review auto-scaling policies to ensure resources scale down during off-peak hours.'
    );
  }

  // Database sizing
  const dbServices = costResults.filter((s) => s.type === 'database');
  for (const db of dbServices) {
    if (db.size === 'xlarge') {
      recommendations.push(
        `Database "${db.name}" is xlarge. Evaluate read replicas or caching layers to reduce primary DB load and potentially downsize.`
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('Cost profile looks reasonable for the configured services.');
  }

  return recommendations;
}

runSkill('cloud-cost-estimator', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  const config = parseConfig(resolved);

  if (!config || !Array.isArray(config.services) || config.services.length === 0) {
    throw new Error(
      'Config must contain a "services" array with at least one service definition.'
    );
  }

  const services = config.services.map((svc) => {
    const type = (svc.type || 'compute').toLowerCase();
    const provider = (svc.provider || DEFAULT_PROVIDER).toLowerCase();
    const size = (svc.size || DEFAULT_SIZE).toLowerCase();
    const count = svc.count || DEFAULT_COUNT;
    const monthlyCost = lookupCost(svc);

    return {
      name: svc.name || 'unnamed-service',
      type,
      provider,
      size,
      count,
      monthlyCost,
    };
  });

  const totalMonthlyCost = services.reduce((sum, s) => sum + s.monthlyCost, 0);
  const totalYearlyCost = totalMonthlyCost * 12;
  const recommendations = generateRecommendations(services, totalMonthlyCost);

  return {
    source: path.basename(resolved),
    services,
    totalMonthlyCost,
    totalYearlyCost,
    recommendations,
  };
});
