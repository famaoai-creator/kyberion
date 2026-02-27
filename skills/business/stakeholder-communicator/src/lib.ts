import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface AudienceProfile {
  label: string;
  focus: string[];
  avoid: string[];
}

export interface TranslationRule {
  tech: RegExp;
  biz: string;
}

export interface KeyPoint {
  type: 'metric' | 'impact';
  value: string;
}

/**
 * Communication artifact extending shared DocumentArtifact.
 */
export interface CommunicationOutput extends DocumentArtifact {
  headline: string;
  keyPoints: string[];
  focusAreas: string[];
  translationsApplied: number;
  structure?: any;
}

export interface CommunicationResult {
  source?: string;
  audience: string;
  format: string;
  audienceProfile: AudienceProfile;
  translationsApplied: { from: string; to: string }[];
  keyPoints: KeyPoint[];
  output: CommunicationOutput;
}

export const AUDIENCE_PROFILES: Record<string, AudienceProfile> = {
  executive: {
    label: 'Executive Team',
    focus: ['ROI', 'risk', 'timeline', 'strategic impact'],
    avoid: ['implementation details', 'code specifics', 'technical jargon'],
  },
  board: {
    label: 'Board of Directors',
    focus: ['financial impact', 'market position', 'risk mitigation', 'growth trajectory'],
    avoid: ['technical details', 'operational minutiae'],
  },
  marketing: {
    label: 'Marketing Team',
    focus: [
      'user benefits',
      'competitive advantage',
      'messaging opportunities',
      'timeline for announcements',
    ],
    avoid: ['backend architecture', 'database changes'],
  },
  sales: {
    label: 'Sales Team',
    focus: [
      'customer value',
      'feature differentiation',
      'talking points',
      'competitive positioning',
    ],
    avoid: ['internal refactoring', 'tech debt'],
  },
  'all-hands': {
    label: 'All Hands',
    focus: ['team achievement', 'product improvement', 'upcoming plans', 'how it helps users'],
    avoid: ['sensitive financial data', 'individual performance'],
  },
};

export const TECH_TO_BIZ: TranslationRule[] = [
  { tech: /refactor/gi, biz: 'system modernization' },
  { tech: /technical debt/gi, biz: 'maintenance backlog' },
  { tech: /CI\/CD|pipeline/gi, biz: 'automated delivery process' },
  { tech: /API/gi, biz: 'integration capability' },
  { tech: /microservice/gi, biz: 'modular architecture' },
  { tech: /database migration/gi, biz: 'data infrastructure upgrade' },
  { tech: /unit test|test coverage/gi, biz: 'quality assurance' },
  { tech: /deployment/gi, biz: 'release' },
  { tech: /latency|response time/gi, biz: 'speed and responsiveness' },
  { tech: /scalab/gi, biz: 'growth capacity' },
  { tech: /security patch|vulnerability/gi, biz: 'security enhancement' },
  { tech: /containeriz/gi, biz: 'cloud-ready packaging' },
  { tech: /dependency/gi, biz: 'component' },
  { tech: /codebase/gi, biz: 'product foundation' },
  { tech: /bug fix/gi, biz: 'issue resolution' },
  { tech: /performance optimization/gi, biz: 'speed improvement' },
  { tech: /fine-tuning|training/gi, biz: 'AI capability refinement' },
  { tech: /embedding|vector/gi, biz: 'intelligent data mapping' },
  { tech: /load balancer|auto-scaling/gi, biz: 'high-availability infrastructure' },
  { tech: /Kubernetes|K8s/gi, biz: 'cloud orchestration platform' },
  { tech: /encryption|TLS/gi, biz: 'data protection protocols' },
];

export function translateContent(content: string): {
  translated: string;
  translations: { from: string; to: string }[];
} {
  let translated = content;
  const translations: { from: string; to: string }[] = [];
  for (const rule of TECH_TO_BIZ) {
    const matches = content.match(rule.tech);
    if (matches) {
      translated = translated.replace(rule.tech, rule.biz);
      translations.push({ from: matches[0], to: rule.biz });
    }
  }
  return { translated, translations };
}

export function extractKeyPoints(content: string): KeyPoint[] {
  const points: KeyPoint[] = [];

  // Metrics
  const metrics = content.match(/\d+\.?\d*\s*(%|percent|users|customers|hours|days|ms|seconds)/gi);
  if (metrics) {
    points.push(...metrics.slice(0, 5).map((m) => ({ type: 'metric' as const, value: m.trim() })));
  }

  // Impact
  const impactPatterns =
    /(?:improve|reduce|increase|decrease|save|eliminate|enable|prevent)[\w\s]{5,60}/gi;
  const impacts = content.match(impactPatterns);
  if (impacts) {
    points.push(...impacts.slice(0, 3).map((i) => ({ type: 'impact' as const, value: i.trim() })));
  }

  return points;
}

export function generateOutput(
  content: string,
  audience: string,
  format: string,
  keyPoints: KeyPoint[],
  translations: { from: string; to: string }[]
): CommunicationOutput {
  const profile = AUDIENCE_PROFILES[audience] || AUDIENCE_PROFILES['executive'];
  const { translated } = translateContent(content);

  const sections: CommunicationOutput = {
    title: `Update for ${profile.label}`,
    headline: `Update for ${profile.label}`,
    body: translated, // Full translated content
    format: 'markdown',
    keyPoints: keyPoints.map((p) => p.value),
    focusAreas: profile.focus,
    translationsApplied: translations.length,
  };

  if (format === 'email') {
    sections.structure = {
      subject: `[Update] ${sections.headline}`,
      opening: `Here is a brief update on recent progress relevant to the ${profile.label}.`,
      body: translated.substring(0, 500),
      closing: 'Please reach out if you have any questions or need further details.',
    };
  } else if (format === 'presentation') {
    sections.structure = {
      slide1: { title: sections.headline, bullets: keyPoints.slice(0, 3).map((p) => p.value) },
      slide2: { title: 'Impact & Benefits', bullets: profile.focus },
      slide3: {
        title: 'Next Steps',
        bullets: ['Review timeline', 'Align resources', 'Schedule follow-up'],
      },
    };
  } else if (format === 'memo') {
    sections.structure = {
      to: profile.label,
      from: 'Engineering',
      subject: sections.headline,
      body: translated.substring(0, 1000),
      action_required: 'Review and provide feedback by next meeting.',
    };
  }

  return sections;
}
