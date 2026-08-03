import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import {
  listInboxEntries,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  secureIo,
  withExecutionContext,
} from '@agent/core';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * CS-03 受領プレビュー (SU-03 leftover) — inline preview data for one inbox
 * entry's artifacts. Read-only, and path-safe by construction: the only paths
 * ever opened are the ones recorded in that entry's own `artifact_paths`
 * (client input selects the entry id, never a path), resolved against the
 * repo root and rejected when they escape it. All reads go through secure-io
 * under the sovereign_concierge execution context — never node:fs.
 */

const MAX_FILES = 5;
const MAX_TEXT_CHARS = 20_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TEXT_EXTENSIONS = new Set(['.txt', '.json', '.jsonl', '.log', '.csv', '.yaml', '.yml']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

interface ArtifactPreview {
  /** Basename only — full paths are execution detail the UI does not show. */
  name: string;
  kind: 'markdown' | 'text' | 'image' | 'other';
  content?: string;
  truncated?: boolean;
  data_uri?: string;
  missing?: boolean;
  too_large?: boolean;
}

function buildPreview(rootDir: string, artifactPath: string): ArtifactPreview {
  const name = path.basename(artifactPath) || artifactPath;
  const resolved = path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : pathResolver.rootResolve(artifactPath);
  // Outside the repo root nothing is rendered — the entry keeps its listing,
  // but the file itself only shows as a name.
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
    return { name, kind: 'other' };
  }
  const ext = path.extname(resolved).toLowerCase();
  try {
    return withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation((): ArtifactPreview => {
        if (!safeExistsSync(resolved)) return { name, kind: 'other', missing: true };
        if (IMAGE_MIME[ext]) {
          const data = safeReadFile(resolved) as Buffer;
          if (data.length > MAX_IMAGE_BYTES) return { name, kind: 'image', too_large: true };
          return {
            name,
            kind: 'image',
            data_uri: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`,
          };
        }
        if (MARKDOWN_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) {
          const raw = safeReadFile(resolved, { encoding: 'utf8' }) as string;
          const truncated = raw.length > MAX_TEXT_CHARS;
          return {
            name,
            kind: MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text',
            content: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
            ...(truncated ? { truncated } : {}),
          };
        }
        return { name, kind: 'other' };
      })
    );
  } catch {
    // Tier-guard or read errors degrade to a name-only card, never a 500 for
    // the whole entry.
    return { name, kind: 'other' };
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);
  try {
    const { id } = await context.params;
    const entry = withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() =>
        listInboxEntries({ limit: Number.MAX_SAFE_INTEGER }).find((item) => item.entry_id === id)
      )
    );
    if (!entry) {
      return NextResponse.json({ ok: false, error: t('api.outcome_not_found') }, { status: 404 });
    }
    const rootDir = pathResolver.rootDir();
    const files = entry.artifact_paths
      .slice(0, MAX_FILES)
      .map((artifactPath) => buildPreview(rootDir, artifactPath));
    return NextResponse.json({
      ok: true,
      preview: {
        entry_id: entry.entry_id,
        total: entry.artifact_paths.length,
        shown: files.length,
        files,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
