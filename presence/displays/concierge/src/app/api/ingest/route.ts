import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildExecutionEnv, withExecutionContext } from '@agent/core/authority';
import { listTenantProfileSlugs } from '@agent/core/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeLstat,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';
import { parseIngestForm } from '../ingest-input';
import { parseIngestCliVerdict } from '../ingest-output-parser';

export const dynamic = 'force-dynamic';

/**
 * CS-03 文書取込 — the explicit DA-05 ingest ceremony, driven from the GUI.
 * One uploaded document per request, always through scripts/ingest.ts (built
 * as dist/scripts/ingest.js): parse → PII gate → dedup → ledger commit. There
 * is deliberately NO watch/auto-ingest mode here, mirroring the CLI's design —
 * every ingest is one explicit human action, recorded with who/when in the
 * tenant's information-asset ledger via --ingested-by.
 *
 * The upload is staged under active/shared/tmp (repo temp-file invariant:
 * never an ad-hoc directory) in a unique per-request subdirectory, and removed
 * best-effort after the ceremony finishes either way.
 */

const INGEST_RELATIVE = 'dist/scripts/ingest.js';
// Parsing a large PDF/DOCX takes time but must stay bounded — the UI never hangs.
const INGEST_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// GUI subset of the CLI formats: slack_thread is not a file-upload format.
// Extensions scripts/ingest.ts can infer a format from (EXTENSION_FORMATS).
const INFERABLE_EXTENSIONS = new Set([
  '.docx',
  '.pdf',
  '.xlsx',
  '.html',
  '.htm',
  '.md',
  '.markdown',
  '.txt',
]);

interface IngestSummary {
  dry_run: boolean;
  outcome: 'committed' | 'would_commit' | 'duplicate';
  target_path?: string;
  file_name: string;
  tenant: string;
}

/** Keep the original stem/extension (format inference + landing path use them), drop everything unsafe. */
function sanitizeFileName(name: string): string {
  // ASCII word chars plus Japanese scripts survive; everything else becomes `_`.
  const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._ぁ-ヿ一-鿿-]/gu, '_');
  const trimmed = base.replace(/^[._]+/, '').slice(0, 120);
  return trimmed || `upload-${Date.now().toString(36)}`;
}

function toDisplayPath(value: unknown): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  try {
    return path.isAbsolute(raw) ? pathResolver.toRepoRelative(raw) : raw;
  } catch {
    return raw;
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  let uploadDir: string | null = null;
  try {
    const form = await req.formData();
    const parsedForm = parseIngestForm(form);
    if (!parsedForm.ok) {
      const messageKey =
        parsedForm.field === 'file'
          ? 'api.file_required'
          : parsedForm.field === 'tenant'
            ? 'api.ingest.tenant_invalid'
            : parsedForm.field === 'format'
              ? 'api.ingest.format_invalid'
              : 'api.onboarding_input';
      return NextResponse.json({ ok: false, error: t(messageKey) }, { status: 400 });
    }
    const { file, tenant, format, dryRun } = parsedForm.value;
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: t('api.ingest.file_size') }, { status: 400 });
    }

    // Only tenants registered in the tenant registry are valid landings from
    // the GUI. `common` (shared/public namespace) needs a KM-03 steward
    // approval id, which this ceremony does not collect — so it is not offered.
    const knownTenants = withExecutionContext('sovereign_concierge', () =>
      listTenantProfileSlugs()
    );
    if (!tenant || !knownTenants.includes(tenant)) {
      return NextResponse.json(
        { ok: false, error: t('api.ingest.tenant_invalid') },
        { status: 400 }
      );
    }

    const safeName = sanitizeFileName(file.name);
    if (!format && !INFERABLE_EXTENSIONS.has(path.extname(safeName).toLowerCase())) {
      return NextResponse.json(
        { ok: false, error: t('api.ingest.format_needed') },
        { status: 400 }
      );
    }

    const ingestScript = pathResolver.rootResolve(INGEST_RELATIVE);
    let ingestReady = false;
    try {
      const safeIngestScript = assertSafeRepositoryPath(ingestScript, { allowMissingLeaf: true });
      ingestReady = safeExistsSync(safeIngestScript) && safeLstat(safeIngestScript).isFile();
    } catch {
      ingestReady = false;
    }
    if (!ingestReady) {
      console.error(`[concierge/ingest] ingest build missing: ${ingestScript}`);
      return NextResponse.json({ ok: false, error: t('api.ingest.failed') }, { status: 503 });
    }

    // Stage the upload under active/shared/tmp (temp-file invariant) in a
    // unique subdirectory so concurrent uploads never collide.
    uploadDir = pathResolver.sharedTmp(
      path.join('concierge-ingest', `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
    );
    const uploadPath = path.join(uploadDir, safeName);
    const data = Buffer.from(await file.arrayBuffer());
    withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() => {
        safeMkdir(uploadDir as string, { recursive: true });
        safeWriteFile(uploadPath, data);
      })
    );

    // --source-id stays the (sanitized) original filename, not the tmp path:
    // re-uploads of the same document then supersede the prior version instead
    // of registering as unrelated fresh assets (scripts/ingest.ts keeps
    // source_system::source_id as the stable asset identity).
    const args = [
      INGEST_RELATIVE,
      '--tenant',
      tenant,
      '--file',
      uploadPath,
      '--ingested-by',
      'sovereign_concierge:web',
      '--source-system',
      'concierge-upload',
      '--source-id',
      safeName,
      ...(format ? ['--format', format] : []),
      ...(dryRun ? ['--dry-run'] : []),
    ];
    // The child ceremony runs under the same execution identity as this
    // route's own reads (withExecutionContext only sets env for THIS process;
    // buildExecutionEnv is its subprocess counterpart — the tenant profile
    // lives in the personal tier and is unreadable without it).
    const result = safeExecResult(process.execPath, args, {
      env: buildExecutionEnv(process.env, 'sovereign_concierge'),
      cwd: pathResolver.rootDir(),
      timeoutMs: INGEST_TIMEOUT_MS,
      maxOutputMB: 5,
    });

    // Full ceremony output stays server-side; the UI receives a short verdict.
    console.log(
      `[concierge/ingest] tenant=${tenant} file=${safeName} dry_run=${dryRun} exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );

    if (result.status !== 0) {
      const blocked = `${result.stdout}\n${result.stderr}`.includes(
        'blocked by the PII/secret gate'
      );
      return NextResponse.json(
        { ok: false, error: t(blocked ? 'api.ingest.blocked' : 'api.ingest.failed') },
        { status: blocked ? 422 : 502 }
      );
    }

    // Exit code 0 alone is not success: read the ceremony's own verdict lines.
    if (dryRun) {
      const plan = parseIngestCliVerdict(result.stdout, '[ingest] DRY RUN');
      if (!plan || plan.dry_run !== true) {
        return NextResponse.json({ ok: false, error: t('api.ingest.failed') }, { status: 502 });
      }
      const duplicate = plan.would_commit !== true;
      const summary: IngestSummary = {
        dry_run: true,
        outcome: duplicate ? 'duplicate' : 'would_commit',
        ...(toDisplayPath(plan.target_path)
          ? { target_path: toDisplayPath(plan.target_path) }
          : {}),
        file_name: safeName,
        tenant,
      };
      return NextResponse.json({
        ok: true,
        dry_run: true,
        summary,
        message: t(duplicate ? 'api.ingest.duplicate' : 'api.ingest.previewed', { name: safeName }),
      });
    }

    if (result.stdout.includes('[ingest] committed ')) {
      const asset = parseIngestCliVerdict(result.stdout, '[ingest] committed ');
      const summary: IngestSummary = {
        dry_run: false,
        outcome: 'committed',
        ...(toDisplayPath(asset?.target_path)
          ? { target_path: toDisplayPath(asset?.target_path) }
          : {}),
        file_name: safeName,
        tenant,
      };
      return NextResponse.json({
        ok: true,
        dry_run: false,
        summary,
        message: t('api.ingest.committed', { name: safeName }),
      });
    }
    if (result.stdout.includes('[ingest] NOT committed')) {
      // Honest non-write outcome (duplicate content) — nothing changed on disk.
      const summary: IngestSummary = {
        dry_run: false,
        outcome: 'duplicate',
        file_name: safeName,
        tenant,
      };
      return NextResponse.json({
        ok: true,
        dry_run: false,
        summary,
        message: t('api.ingest.duplicate', { name: safeName }),
      });
    }
    return NextResponse.json({ ok: false, error: t('api.ingest.failed') }, { status: 502 });
  } catch (error) {
    console.error(
      `[concierge/ingest] route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.ingest.failed') }, { status: 500 });
  } finally {
    if (uploadDir) {
      // Best-effort cleanup of the staged upload; a leftover under
      // active/shared/tmp is swept by regular temp hygiene anyway.
      try {
        withExecutionContext('sovereign_concierge', () =>
          secureIo.withSensitivePathMediation(() =>
            safeRmSync(uploadDir as string, { recursive: true, force: true })
          )
        );
      } catch (cleanupError) {
        console.warn(`[concierge/ingest] tmp cleanup failed: ${String(cleanupError)}`);
      }
    }
  }
}
