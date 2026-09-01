import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { listInboxEntries } from '@agent/core/deliverable-inbox';
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../../lib/i18n';
import { resolveConciergeViewer } from '../../../../../lib/viewer-context';

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

type PreviewTier = 'personal' | 'confidential' | 'public';

function normalizePreviewTier(value: unknown): PreviewTier | undefined {
  return value === 'personal' || value === 'confidential' || value === 'public' ? value : undefined;
}

function tierFromArtifactPath(artifactPath: string): PreviewTier | undefined {
  const normalized = artifactPath.replace(/\\/g, '/');
  const match = normalized.match(
    /(?:^|\/)active\/(?:missions|projects)\/(personal|confidential|public)(?:\/|$)/
  );
  return normalizePreviewTier(match?.[1]);
}

function tierFromMissionState(missionId: string | undefined): PreviewTier | undefined {
  if (!missionId) return undefined;
  const missionPath = pathResolver.findMissionPath(missionId.toUpperCase());
  if (!missionPath) return undefined;
  const statePath = path.join(missionPath, 'mission-state.json');
  try {
    return withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() => {
        const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
        if (!safeExistsSync(safeStatePath) || !safeLstat(safeStatePath).isFile()) return undefined;
        const parsed = readJson<{ tier?: unknown }>(safeStatePath);
        return normalizePreviewTier(parsed.tier);
      })
    );
  } catch {
    return undefined;
  }
}

/** Mission state is authoritative; a path tier is only a legacy fallback. */
export function resolveOutcomePreviewTier(
  missionId: string | undefined,
  artifactPaths: readonly string[]
): PreviewTier | undefined {
  const missionTier = tierFromMissionState(missionId);
  if (missionTier) return missionTier;
  const pathTiers = [
    ...new Set(artifactPaths.map(tierFromArtifactPath).filter(Boolean)),
  ] as PreviewTier[];
  return pathTiers.length === 1 ? pathTiers[0] : undefined;
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
        const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
        if (!safeExistsSync(safeResolved)) return { name, kind: 'other', missing: true };
        if (!safeLstat(safeResolved).isFile()) return { name, kind: 'other' };
        if (IMAGE_MIME[ext]) {
          const data = safeReadFile(safeResolved) as Buffer;
          if (data.length > MAX_IMAGE_BYTES) return { name, kind: 'image', too_large: true };
          return {
            name,
            kind: 'image',
            data_uri: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`,
          };
        }
        if (MARKDOWN_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) {
          const raw = safeReadFile(safeResolved, { encoding: 'utf8' }) as string;
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
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
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
    if (
      resolved.context.tenantSlugs !== 'all' &&
      (!entry.tenant_slug || !resolved.context.tenantSlugs.includes(entry.tenant_slug))
    ) {
      return NextResponse.json(
        { ok: false, error: 'Concierge viewer tenant scope denied.' },
        { status: 403 }
      );
    }
    const tier = resolveOutcomePreviewTier(entry.mission_id, entry.artifact_paths);
    if (!tier || !resolved.context.tierAccess.includes(tier)) {
      return NextResponse.json(
        { ok: false, error: 'Concierge viewer tier scope denied.' },
        { status: 403 }
      );
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
