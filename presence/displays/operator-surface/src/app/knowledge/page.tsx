import * as path from 'node:path';
import { EmptyState, KbIcon, Section } from '@agent/shared-ui';
import { safeReaddir, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

interface KnowledgeNode {
  rel: string;
  name: string;
  is_dir: boolean;
}

function listKnowledge(rel: string): KnowledgeNode[] {
  const abs = pathResolver.rootResolve(rel);
  if (!safeExistsSync(abs)) return [];
  const out: KnowledgeNode[] = [];
  try {
    for (const entry of safeReaddir(abs)) {
      const sub = path.join(abs, entry);
      let stat;
      try {
        stat = safeLstat(sub);
      } catch {
        continue;
      }
      out.push({
        rel: `${rel}/${entry}`,
        name: entry,
        is_dir: stat.isDirectory(),
      });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export default async function KnowledgePage() {
  // Public tier only — confidential / personal are out of scope for the
  // browse surface (operator goes to their CLI / SIEM for those).
  const top = listKnowledge('knowledge/public');
  emitMosRead({ page: '/knowledge', resource_kind: 'knowledge', result_count: top.length });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  return (
    <>
      <OperatorPageHeader title={t('knowledge_title')} subtitle={t('knowledge_subtitle')} />
      <Section title={t('knowledge_tree_title', { count: top.length })}>
        {top.length === 0 ? (
          <EmptyState title={t('knowledge_empty')} />
        ) : (
          <div className="operator-panel">
            <ul className="operator-tree">
              {top.map((node) => (
                <li key={node.rel} className="operator-tree__item">
                  <span className="operator-tree__icon">
                    <KbIcon
                      name={node.is_dir ? 'folder' : 'book'}
                      size={16}
                      label={node.is_dir ? t('knowledge_folder') : t('knowledge_file')}
                    />
                  </span>
                  <span className="operator-cell">
                    <span className="operator-cell__title">{node.name}</span>
                    <span className="operator-cell__meta operator-mono">{node.rel}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </>
  );
}
