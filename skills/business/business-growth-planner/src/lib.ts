import { ProjectIdentity, FinancialMetrics } from '@agent/core/shared-business-types';

export interface BusinessInput extends ProjectIdentity, FinancialMetrics {
  objectives?: string[];
  target_market?: {
    size?: string;
    tam?: number;
  };
  competitive_landscape?: string;
  product_readiness?: string;
  model?: 'saas' | 'platform' | string;
  has_api?: boolean;
  has_data?: boolean;
}

export interface OKR {
  objective: string;
  keyResults: string[];
}

export interface MarketStrategy {
  strategy: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
}

export interface RevenueStream {
  stream: string;
  description: string;
  potential: 'low' | 'medium' | 'high';
}

export interface GrowthPillar {
  pillar: string;
  initiatives: string[];
}

export interface BusinessPlanResult {
  company: string;
  vision: string;
  okrs: OKR[];
  marketEntryStrategies: MarketStrategy[];
  revenueStreams: RevenueStream[];
  growthPillars: GrowthPillar[];
  recommendations: string[];
}

export function generateOKRs(goals: BusinessInput): OKR[] {
  return (goals.objectives || []).map((obj, i) => ({
    objective: obj,
    keyResults: [
      `KR${i + 1}.1: Define measurable target for "${obj}"`,
      `KR${i + 1}.2: Achieve 70% progress in Q1`,
      `KR${i + 1}.3: Complete full rollout by Q2`,
    ],
  }));
}

export function analyzeMarketEntry(input: BusinessInput): MarketStrategy[] {
  const strategies: MarketStrategy[] = [];
  const market = input.target_market || {};
  if (market.size === 'large' || (market.tam && market.tam > 1000000000)) {
    strategies.push({
      strategy: 'Land & Expand',
      description: 'Start with SMB segment, expand to enterprise',
      risk: 'medium',
    });
  } else {
    strategies.push({
      strategy: 'Niche Focus',
      description: 'Dominate a specific vertical before expanding',
      risk: 'low',
    });
  }

  if (input.competitive_landscape === 'fragmented') {
    strategies.push({
      strategy: 'Consolidation Play',
      description: 'Acquire smaller competitors to gain market share',
      risk: 'high',
    });
  }

  if (input.product_readiness === 'mvp') {
    strategies.push({
      strategy: 'Product-Led Growth',
      description: 'Offer freemium tier to drive adoption',
      risk: 'low',
    });
  }
  return strategies;
}

export function defineRevenueStreams(input: BusinessInput): RevenueStream[] {
  const streams: RevenueStream[] = [];
  if (input.model === 'saas' || !input.model) {
    streams.push({
      stream: 'SaaS Subscriptions',
      description: 'Recurring monthly/annual subscriptions',
      potential: 'high',
    });
    streams.push({
      stream: 'Enterprise Licensing',
      description: 'Custom pricing for large accounts',
      potential: 'high',
    });
  }

  if (input.has_api || input.model === 'platform') {
    streams.push({
      stream: 'API Usage Fees',
      description: 'Pay-per-use API access',
      potential: 'medium',
    });
  }

  if (input.has_data) {
    streams.push({
      stream: 'Data Insights',
      description: 'Anonymized analytics and benchmarking',
      potential: 'medium',
    });
  }

  streams.push({
    stream: 'Professional Services',
    description: 'Implementation, training, and consulting',
    potential: 'medium',
  });
  return streams;
}

export function createGrowthPillars(): GrowthPillar[] {
  return [
    {
      pillar: 'Product Excellence',
      initiatives: [
        'Feature parity with top competitor',
        'UX/accessibility improvements',
        'Performance optimization',
      ],
    },
    {
      pillar: 'Market Expansion',
      initiatives: [
        'Enter new geographic market',
        'Launch partner program',
        'Industry-specific solutions',
      ],
    },
    {
      pillar: 'Operational Efficiency',
      initiatives: [
        'Automate customer onboarding',
        'Reduce support ticket volume by 30%',
        'Implement self-service portal',
      ],
    },
    {
      pillar: 'Team & Culture',
      initiatives: [
        'Hire key roles per roadmap',
        'Knowledge sharing program',
        'Quarterly innovation sprints',
      ],
    },
  ];
}

export function processBusinessPlan(input: BusinessInput): BusinessPlanResult {
  const okrs = generateOKRs(input);
  const marketStrategies = analyzeMarketEntry(input);
  const revenueStreams = defineRevenueStreams(input);
  const pillars = createGrowthPillars();

  const recommendations = [
    okrs.length === 0
      ? 'Define clear objectives in your input to generate OKRs'
      : `${okrs.length} OKRs generated`,
    marketStrategies.length === 0
      ? 'Provide target market data for entry strategy analysis'
      : `${marketStrategies.length} market entry strategies identified`,
    revenueStreams.length === 0
      ? 'Specify a business model to map revenue streams'
      : `${revenueStreams.length} revenue streams mapped`,
  ];

  if (!input.name) recommendations.push('Provide company name for a more personalized plan');
  if (!input.vision)
    recommendations.push('Define a vision to align growth pillars with long-term goals');

  return {
    company: input.name || 'Unknown Entity',
    vision: input.vision || 'Strategic growth alignment',
    okrs,
    marketEntryStrategies: marketStrategies,
    revenueStreams,
    growthPillars: pillars,
    recommendations,
  };
}
