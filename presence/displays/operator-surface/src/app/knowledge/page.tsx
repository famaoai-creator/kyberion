import * as path from 'node:path';
import {
  safeReaddir,
  safeExistsSync,
  safeLstat,
  pathResolver,
} from '@agent/core';
import { emitMosRead } from '@/lib/audit-mos';

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
  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Knowledge (public tier)</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0, fontSize: 13 }}>
        Browse the reusable public knowledge tree. Confidential / personal
        content is intentionally out of scope of the MOS — use the CLI to
        view those.
      </p>
      <ul style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
        {top.map((node) => (
          <li key={node.rel}>
            {node.is_dir ? '📁' : '📄'} {node.name}
            <span style={{ color: '#9aa0aa', marginLeft: 8 }}>
              <code>{node.rel}</code>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
