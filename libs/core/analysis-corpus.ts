import { pathResolver } from './path-resolver.js';
import { readTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export interface AnalysisCorpusSnippet {
  ref: string;
  title: string;
  excerpt: string;
}

export interface AnalysisRefRankingInput {
  refs: string[];
  projectId?: string;
  trackId?: string;
  reviewTarget?: string;
  targetScope?: string;
  utterance?: string;
}

function isAllowedAnalysisRef(ref: string): boolean {
  const normalized = ref.replaceAll('\\', '/');
  return normalized.startsWith('knowledge/') || normalized.startsWith('active/projects/');
}

/**
 * Analysis refs become model-visible excerpts, so lexical allowlisting is not
 * enough: an in-repository symlink must not redirect the read to another
 * scope. Keep the existing two logical roots, then apply the shared physical
 * repository/component boundary immediately before reading.
 */
function resolveSafeAnalysisRef(ref: string): string | null {
  const normalized = ref.replaceAll('\\', '/');
  if (!isAllowedAnalysisRef(normalized)) return null;
  try {
    return assertSafeRepositoryPath(pathResolver.rootResolve(normalized));
  } catch {
    return null;
  }
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

function summarizeContent(raw: string): { title: string; excerpt: string } {
  const content = stripFrontmatter(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = content.find((line) => line.startsWith('# '));
  const title = heading ? heading.replace(/^#\s+/, '') : content[0] || 'Reference';
  const excerpt = content
    .filter((line) => !line.startsWith('#'))
    .slice(0, 4)
    .join(' ')
    .slice(0, 400);
  return {
    title,
    excerpt: excerpt || title,
  };
}

function tokenizeFreeText(input?: string): string[] {
  return String(input || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function scoreRef(ref: string, input: Omit<AnalysisRefRankingInput, 'refs'>): number {
  const lowerRef = ref.toLowerCase();
  const projectId = String(input.projectId || '')
    .trim()
    .toLowerCase();
  const trackId = String(input.trackId || '')
    .trim()
    .toLowerCase();
  const reviewTarget = String(input.reviewTarget || '')
    .trim()
    .toLowerCase();
  const targetScope = String(input.targetScope || '')
    .trim()
    .toLowerCase();
  const reviewTargetValue = reviewTarget.includes(':')
    ? reviewTarget.split(':').slice(1).join(':')
    : reviewTarget;
  let score = 0;

  if (reviewTargetValue && lowerRef.includes(reviewTargetValue)) score += 120;
  if (trackId && lowerRef.includes(trackId)) score += 80;
  if (projectId && lowerRef.includes(projectId)) score += 60;
  if (targetScope && lowerRef.includes(targetScope.toLowerCase())) score += 50;
  if (lowerRef.startsWith('active/projects/')) score += 25;
  if (lowerRef.startsWith('knowledge/product/incidents/')) score += 20;
  if (lowerRef.startsWith('knowledge/')) score += 10;

  const tokens = tokenizeFreeText(input.utterance);
  for (const token of tokens) {
    if (lowerRef.includes(token)) score += 4;
  }

  return score;
}

export function rankAnalysisRefs(input: AnalysisRefRankingInput): string[] {
  return [...input.refs].sort((left, right) => {
    const scoreDiff = scoreRef(right, input) - scoreRef(left, input);
    if (scoreDiff !== 0) return scoreDiff;
    return left.localeCompare(right);
  });
}

export function buildAnalysisCorpusSnippets(refs: string[], limit = 5): AnalysisCorpusSnippet[] {
  const snippets: AnalysisCorpusSnippet[] = [];
  for (const ref of refs) {
    const resolved = resolveSafeAnalysisRef(ref);
    if (!resolved) continue;
    try {
      if (!safeLstat(resolved).isFile()) continue;
      const raw = readTextFile(resolved);
      const summary = summarizeContent(raw);
      snippets.push({
        ref,
        title: summary.title,
        excerpt: summary.excerpt,
      });
    } catch {
      continue;
    }
    if (snippets.length >= limit) break;
  }
  return snippets;
}
