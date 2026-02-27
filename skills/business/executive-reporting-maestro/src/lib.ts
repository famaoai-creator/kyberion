import { RiskEntry, StrategicAction, DocumentArtifact } from '@agent/core/shared-business-types';

export interface SkillResult {
  skill: string;
  status: 'success' | 'error';
  data?: any; // Can be AnalysisResult, CompetitiveResult, etc.
  error?: { message: string };
  [key: string]: any;
}

export interface Highlight extends Partial<RiskEntry>, Partial<StrategicAction> {
  type: 'positive' | 'concern' | 'recommendation' | 'error';
  skill: string;
  message: string;
  score?: number;
  grade?: string;
}

export interface DomainSummary {
  domain: string;
  skills: string[];
  successCount: number;
  total: number;
}

export interface ExecutiveReport {
  title: string;
  generatedAt: string;
  totalResults: number;
  successCount: number;
  errorCount: number;
  highlights: Highlight[];
  risks: Highlight[];
  domainSummary: DomainSummary[];
}

export function categorizeResult(result: SkillResult): {
  domain: string;
  skill: string;
  status: string;
} {
  const skill = result.skill || 'unknown';
  const status = result.status || 'unknown';

  if (skill.match(/security|scanner|vulnerability/i)) return { domain: 'Security', skill, status };
  if (skill.match(/quality|score|completeness/i)) return { domain: 'Quality', skill, status };
  if (skill.match(/health|audit|governance/i)) return { domain: 'Project Health', skill, status };
  if (skill.match(/cost|financial|budget|economics/i))
    return { domain: 'Financial', skill, status };
  if (skill.match(/performance|monitor/i)) return { domain: 'Performance', skill, status };
  if (skill.match(/ux|accessibility/i)) return { domain: 'UX & Accessibility', skill, status };
  if (skill.match(/dependency|license/i)) return { domain: 'Dependencies', skill, status };
  return { domain: 'Other', skill, status };
}

export function extractHighlights(results: SkillResult[]): {
  highlights: Highlight[];
  risks: Highlight[];
} {
  const highlights: Highlight[] = [];
  const risks: Highlight[] = [];

  for (const result of results) {
    const data = result.data || {};

    // Standard Score/Grade processing
    if (data.score !== undefined) {
      const item = { skill: result.skill, score: data.score, grade: data.grade };
      if (data.score >= 80) {
        highlights.push({
          type: 'positive',
          ...item,
          message: `${result.skill}: Score ${data.score}${data.grade ? ' (' + data.grade + ')' : ''}`,
        });
      } else {
        risks.push({
          type: 'concern',
          ...item,
          message: `${result.skill}: Score ${data.score}${data.grade ? ' (' + data.grade + ')' : ''} - below threshold`,
          severity: data.score < 50 ? 'high' : 'medium',
        });
      }
    }

    // Process StrategicAction[] (from shared-types refactor)
    if (Array.isArray(data.recommendations) || Array.isArray(data.strategies)) {
      const items: any[] = data.recommendations || data.strategies;
      // Filter high priority items
      const highPriority = items.filter((i) => i.priority === 'high' || i.priority === 'critical');

      for (const item of highPriority.slice(0, 3)) {
        // Top 3 high priority only
        const action = item.action || item.recommendation; // fallback for legacy
        if (action) {
          risks.push({
            type: 'recommendation',
            skill: result.skill,
            message: action,
            priority: item.priority,
            action: action,
            severity:
              item.priority === 'critical'
                ? 'critical'
                : item.priority === 'high'
                  ? 'high'
                  : 'medium',
          });
        }
      }
    }

    // Process RiskEntry[] (from shared-types refactor)
    if (Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        if (risk.severity === 'high' || risk.severity === 'critical') {
          risks.push({
            type: 'concern',
            skill: result.skill,
            message: risk.risk,
            severity: risk.severity,
            category: risk.category,
          });
        }
      }
    }

    if (result.status === 'error' && result.error) {
      risks.push({
        type: 'error',
        skill: result.skill,
        message: result.error.message,
        severity: 'critical',
      });
    }
  }

  return { highlights, risks };
}

export function processReport(title: string, results: SkillResult[]): ExecutiveReport {
  // Filter out invalid or empty results to prevent downstream errors
  const validResults = results.filter((r) => r && typeof r === 'object' && r.skill);

  const categorized = validResults.map(categorizeResult);
  const { highlights, risks } = extractHighlights(validResults);

  const domainMap: Record<string, DomainSummary> = {};
  for (let i = 0; i < validResults.length; i++) {
    const cat = categorized[i];
    const res = validResults[i];
    if (!domainMap[cat.domain]) {
      domainMap[cat.domain] = { domain: cat.domain, skills: [], successCount: 0, total: 0 };
    }
    if (!domainMap[cat.domain].skills.includes(cat.skill)) {
      domainMap[cat.domain].skills.push(cat.skill);
    }
    domainMap[cat.domain].total++;
    if (res.status === 'success') {
      domainMap[cat.domain].successCount++;
    }
  }

  return {
    title,
    generatedAt: new Date().toISOString(),
    totalResults: validResults.length,
    successCount: validResults.filter((r) => r.status === 'success').length,
    errorCount: validResults.filter((r) => r.status === 'error').length,
    highlights,
    risks,
    domainSummary: Object.values(domainMap),
  };
}

export function generateMarkdown(report: ExecutiveReport): string {
  const lines = [`# ${report.title}`, '', `**Generated:** ${report.generatedAt}`, ''];

  lines.push('## Executive Summary', '');
  lines.push(`- **Reports Analyzed:** ${report.totalResults}`);
  lines.push(`- **Successful:** ${report.successCount} | **Failed:** ${report.errorCount}`);
  lines.push('');

  if (report.highlights.length > 0) {
    lines.push('## Highlights', '');
    for (const h of report.highlights) {
      lines.push(`- ${h.message}`);
    }
    lines.push('');
  }

  if (report.risks.length > 0) {
    lines.push('## Risks & Recommendations', '');
    for (const r of report.risks) {
      let icon = '[REC]';
      if (r.type === 'error') icon = '🚨';
      else if (r.severity === 'critical') icon = '🔥';
      else if (r.severity === 'high') icon = '⚠️';

      const prefix = r.skill ? `**${r.skill}**: ` : '';
      lines.push(`- ${icon} ${prefix}${r.message}`);
    }
    lines.push('');
  }

  if (report.domainSummary.length > 0) {
    lines.push('## Domain Breakdown', '');
    for (const d of report.domainSummary) {
      lines.push(`### ${d.domain}`);
      lines.push(`Skills: ${d.skills.join(', ')} | Success: ${d.successCount}/${d.total}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
