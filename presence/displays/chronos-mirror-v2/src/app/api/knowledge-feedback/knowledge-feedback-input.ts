type KnowledgeFeedbackVerdict = 'useful' | 'not_useful';

const VERDICTS = new Set<KnowledgeFeedbackVerdict>(['useful', 'not_useful']);
const KNOWLEDGE_PATH =
  /^knowledge\/(public|confidential|personal)\/[^/]+(?:\/[^/]+)*\.(md|json)$/iu;

export interface KnowledgeFeedbackRequestInput {
  documentPath: string;
  verdict: KnowledgeFeedbackVerdict;
  tenant?: string;
  organizationId?: string;
  projectId?: string;
  operationId?: string;
  tier?: 'public' | 'confidential' | 'personal';
  reason?: string;
}

export function parseKnowledgeFeedbackInput(
  value: Record<string, unknown>
): KnowledgeFeedbackRequestInput {
  const unexpected = Object.keys(value).find(
    (key) =>
      ![
        'document_path',
        'verdict',
        'tenant',
        'organization_id',
        'project_id',
        'operation_id',
        'tier',
        'reason',
      ].includes(key)
  );
  if (unexpected) throw new Error(`unexpected knowledge feedback field: ${unexpected}`);

  const rawPath = value.document_path;
  if (typeof rawPath !== 'string' || !KNOWLEDGE_PATH.test(rawPath.trim())) {
    throw new Error('document_path must be a safe knowledge document path');
  }
  const documentPath = rawPath.trim();
  if (documentPath.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('document_path must not contain traversal segments');
  }

  const verdict = value.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict as KnowledgeFeedbackVerdict)) {
    throw new Error('verdict must be useful or not_useful');
  }

  const optionalStrings: Array<[string, string]> = [
    ['tenant', 'tenant'],
    ['organization_id', 'organizationId'],
    ['project_id', 'projectId'],
    ['operation_id', 'operationId'],
    ['tier', 'tier'],
    ['reason', 'reason'],
  ];
  const parsed: Record<string, string> = {};
  for (const [sourceKey, targetKey] of optionalStrings) {
    const raw = value[sourceKey];
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > 2_000)) {
      throw new Error(`${sourceKey} must be a string up to 2000 characters`);
    }
    if (typeof raw === 'string' && raw.trim()) parsed[targetKey] = raw.trim();
  }
  if (parsed.tier && !['public', 'confidential', 'personal'].includes(parsed.tier))
    throw new Error('tier is invalid');

  return {
    documentPath,
    verdict: verdict as KnowledgeFeedbackVerdict,
    ...(parsed.tenant ? { tenant: parsed.tenant } : {}),
    ...(parsed.organizationId ? { organizationId: parsed.organizationId } : {}),
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    ...(parsed.operationId ? { operationId: parsed.operationId } : {}),
    ...(parsed.tier ? { tier: parsed.tier as KnowledgeFeedbackRequestInput['tier'] } : {}),
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
}
