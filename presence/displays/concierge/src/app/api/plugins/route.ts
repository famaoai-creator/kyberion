import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { authorizeSkillPlugin, readSkillPluginsConfig } from '@agent/core/skill-plugin-loader';
import { listManagedPlugins } from '@agent/core/plugin-managed-install';
import { loadApprovalRequest } from '@agent/core/approval-store';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * CS-03 プラグイン承認の1画面化 — read-only plugin inventory. Two sources:
 *
 *  1. `.kyberion-plugins.json` entries, classified through the same KD-06
 *     provenance gate the loader itself uses (`authorizeSkillPlugin`) — the
 *     screen can never claim more than the loader would actually execute.
 *  2. Managed-copy installs (`listManagedPlugins`), which carry the bound
 *     approval request for anything non-official.
 *
 * Approving/denying is a separate guarded POST (api/plugins/[id]); this route
 * never mutates and never executes plugin code (listing is JSON.parse only —
 * see libs/core/plugin-managed-install.ts).
 */

export interface PluginListEntry {
  /** Plugin id (managed slot name or configured file stem) — never a filesystem path. */
  id: string;
  trust: string;
  status: 'activatable' | 'pending_approval' | 'blocked_broken_manifest' | 'not_loadable';
  source: 'configured' | 'managed';
  requested_by?: string;
  /** Present only while a human decision is still possible/relevant. */
  approval?: { id: string; channel: string };
  approval_status?: string;
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const entries = withExecutionContext('sovereign_concierge', () => {
      const rootDir = pathResolver.rootDir();
      const result: PluginListEntry[] = [];

      // Configured entries (.kyberion-plugins.json), through the loader's own
      // authorization. Managed copies are skipped here — the managed listing
      // below is their richer source of truth (approval binding included).
      for (const configuredPath of readSkillPluginsConfig(rootDir)) {
        const authorization = authorizeSkillPlugin(configuredPath, rootDir);
        if (authorization.managedPluginId) continue;
        result.push({
          id: path.basename(configuredPath, path.extname(configuredPath)),
          trust: authorization.trust,
          // Honest status: a configured path the loader would skip has no
          // approval path of its own — it is simply not loadable as-is.
          status: authorization.allowed ? 'activatable' : 'not_loadable',
          source: 'configured',
        });
      }

      for (const record of listManagedPlugins()) {
        const approval =
          record.approvalRequestId && record.approvalChannel
            ? loadApprovalRequest(record.approvalChannel, record.approvalRequestId)
            : null;
        result.push({
          id: record.pluginId,
          trust: record.trust,
          status: record.activationStatus,
          source: 'managed',
          ...(approval?.requestedBy ? { requested_by: approval.requestedBy } : {}),
          ...(approval && record.activationStatus === 'pending_approval'
            ? { approval: { id: approval.id, channel: record.approvalChannel as string } }
            : {}),
          ...(approval ? { approval_status: approval.status } : {}),
        });
      }
      return result;
    });

    return NextResponse.json({ ok: true, plugins: entries });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
