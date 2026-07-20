import * as path from 'node:path';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeStat,
} from './secure-io.js';

/**
 * MP-04: turn a rendered artifact into images a model can actually look at.
 *
 * Visual review is the step the media path never had: decks and scenes were
 * emitted and shipped without anyone — human or model — seeing the result. A
 * critique that never sees a render is guesswork, so this module exists to
 * produce the pixels first.
 *
 * Both backends are optional. Rasterizing a PPTX needs LibreOffice and Poppler,
 * which are not present on every operator machine, so absence is reported as an
 * explicit unavailable result rather than an exception or a silent pass: a
 * review that could not look at anything must never read as a review that found
 * nothing wrong (AR-06).
 */

const logger = createLogger('visual-raster');

export interface RasterCapabilities {
  /** LibreOffice, for PPTX/DOCX → PDF. */
  hasSoffice: boolean;
  /** Poppler's pdftoppm, for PDF → PNG. */
  hasPdfRaster: boolean;
  /** Playwright, for HTML → PNG (video scenes, web artifacts). */
  hasHtmlRaster: boolean;
  /** Binary names that were looked for and not found. */
  missing: string[];
}

export interface RasterResult {
  available: boolean;
  /** Absolute paths to the rendered page images, in page order. */
  images: string[];
  /** Why rasterization could not run, when `available` is false. */
  unavailable_reason?: string;
  backend?: 'soffice+pdftoppm' | 'playwright';
}

function commandExists(command: string): boolean {
  try {
    // `command -v` is the portable probe; a non-zero exit throws.
    safeExec('command', ['-v', command], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function moduleResolvable(moduleName: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- capability probe only
    const { createRequire } = require('node:module');
    createRequire(import.meta.url).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

let cachedCapabilities: RasterCapabilities | null = null;

export function detectRasterCapabilities(options: { refresh?: boolean } = {}): RasterCapabilities {
  if (cachedCapabilities && !options.refresh) return cachedCapabilities;
  const hasSoffice = commandExists('soffice') || commandExists('libreoffice');
  const hasPdfRaster = commandExists('pdftoppm');
  const hasHtmlRaster = moduleResolvable('playwright');
  const missing: string[] = [];
  if (!hasSoffice) missing.push('soffice');
  if (!hasPdfRaster) missing.push('pdftoppm');
  if (!hasHtmlRaster) missing.push('playwright');
  cachedCapabilities = { hasSoffice, hasPdfRaster, hasHtmlRaster, missing };
  return cachedCapabilities;
}

export function resetRasterCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/** Human-readable install hint, surfaced to the operator on degradation. */
export function rasterInstallHint(missing: string[]): string {
  const hints: Record<string, string> = {
    soffice: 'LibreOffice (brew install --cask libreoffice)',
    pdftoppm: 'Poppler (brew install poppler)',
    playwright: 'Playwright (pnpm add -D playwright && npx playwright install chromium)',
  };
  return missing.map((name) => hints[name] || name).join(', ');
}

/**
 * Where rasterized pages land.
 *
 * Page images of a confidential deck are still confidential, and `detectTier`
 * is path-derived: anything under `active/shared/` reads back as public tier.
 * Writing them to the shared tmp root would therefore launder a confidential
 * artifact into a public-tier location. Callers that hold tenant material must
 * pass a mission-local directory; the shared root is only for public work.
 */
function resolveWorkDir(label: string, workDirOverride?: string): string {
  const base = workDirOverride
    ? pathResolver.rootResolve(workDirOverride)
    : pathResolver.sharedTmp(path.join('visual-review', label));
  safeMkdir(base, { recursive: true });
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of safeReaddir(base)) {
    if (!entry.startsWith('run-')) continue;
    const candidate = path.join(base, entry);
    try {
      if (safeStat(candidate).mtimeMs < staleBefore) {
        safeRmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Best-effort maintenance must not block a review.
    }
  }
  const dir = path.join(base, `run-${Date.now()}-${process.pid}`);
  safeMkdir(dir, { recursive: true });
  return dir;
}

export type VisualReviewTier = 'public' | 'confidential' | 'personal';

function tierFromPath(relativePath: string): VisualReviewTier | undefined {
  const normalized = relativePath.replace(/\\/g, '/');
  const match = normalized.match(
    /(?:^|\/)(?:knowledge|active\/(?:missions|projects))\/(personal|confidential|public)(?:\/|$)/u
  );
  return match?.[1] as VisualReviewTier | undefined;
}

export function assertVisualReviewPathScope(input: {
  artifactPath: string;
  workDir?: string;
  tier: VisualReviewTier;
  tenantSlug?: string;
  missionId?: string;
}): { artifactPath: string; workDir?: string } {
  const root = pathResolver.rootDir();
  const artifactPath = path.resolve(input.artifactPath);
  const artifactRelative = path.relative(root, artifactPath).replace(/\\/g, '/');
  if (
    !artifactRelative ||
    artifactRelative.startsWith('../') ||
    path.isAbsolute(artifactRelative)
  ) {
    throw new Error(
      `[VISUAL_REVIEW_PATH_DENIED] artifact must stay under the project root: ${artifactPath}`
    );
  }
  const encodedTier = tierFromPath(artifactRelative);
  if (encodedTier && encodedTier !== input.tier) {
    throw new Error(
      `[VISUAL_REVIEW_TIER_MISMATCH] artifact path is ${encodedTier} but caller declared ${input.tier}`
    );
  }
  if (input.tier !== 'public') {
    const tierRoot = artifactRelative.startsWith('active/missions/')
      ? `active/missions/${input.tier}/`
      : `active/projects/${input.tier}/`;
    if (!encodedTier || !artifactRelative.startsWith(tierRoot)) {
      throw new Error(
        `[VISUAL_REVIEW_PATH_DENIED] ${input.tier} material must live under a tiered mission or project path`
      );
    }
    if (input.missionId && !artifactRelative.includes('/' + input.missionId + '/')) {
      throw new Error(
        '[VISUAL_REVIEW_MISSION_MISMATCH] artifact is not inside mission ' + input.missionId
      );
    }
    if (input.tenantSlug && !/^[a-z][a-z0-9-]{1,30}$/u.test(input.tenantSlug)) {
      throw new Error('[VISUAL_REVIEW_TENANT_INVALID] tenant slug is not valid');
    }
    if (input.missionId) {
      const missionPath = pathResolver.findMissionPath(input.missionId);
      if (!missionPath || !artifactPath.startsWith(missionPath + path.sep)) {
        throw new Error(
          '[VISUAL_REVIEW_MISSION_MISMATCH] artifact is not owned by mission ' + input.missionId
        );
      }
      if (input.tenantSlug) {
        const statePath = path.join(missionPath, 'mission-state.json');
        if (safeExistsSync(statePath)) {
          try {
            const state = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }))) as any;
            const recordedTenant = String(
              state?.context?.tenant_slug || state?.tenant_slug || state?.tenant_id || ''
            ).trim();
            if (recordedTenant && recordedTenant !== input.tenantSlug) {
              throw new Error(
                '[VISUAL_REVIEW_TENANT_MISMATCH] mission ' +
                  input.missionId +
                  ' belongs to ' +
                  recordedTenant
              );
            }
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('[VISUAL_REVIEW_')) throw error;
          }
        }
      }
    }
  }
  if (!input.workDir) {
    if (input.tier !== 'public') {
      throw new Error(
        `[VISUAL_REVIEW_WORKDIR_REQUIRED] ${input.tier} material requires a mission/project-local work directory`
      );
    }
    return { artifactPath };
  }
  const workDir = path.resolve(pathResolver.rootResolve(input.workDir));
  const workRelative = path.relative(root, workDir).replace(/\\/g, '/');
  if (!workRelative || workRelative.startsWith('../') || path.isAbsolute(workRelative)) {
    throw new Error(
      `[VISUAL_REVIEW_PATH_DENIED] work directory must stay under the project root: ${workDir}`
    );
  }
  const workTier = tierFromPath(workRelative);
  if (input.tier !== 'public' && workTier !== input.tier) {
    throw new Error(
      `[VISUAL_REVIEW_WORKDIR_TIER_MISMATCH] work directory must remain in ${input.tier} tier`
    );
  }
  return { artifactPath, workDir };
}

export interface RasterizeDocumentInput {
  /** Absolute path to the .pptx/.docx/.pdf to rasterize. */
  sourcePath: string;
  /** Label used for the working directory; keep it slug-like. */
  label: string;
  /** Raster resolution. 150dpi is enough to judge overflow and alignment. */
  dpi?: number;
  /** Cap on rendered pages, so a 200-page deck cannot flood the loop. */
  maxPages?: number;
  /**
   * Mission-local output directory. Required for confidential material: the
   * shared tmp root is public-tier by path, so rasterizing tenant content
   * there would downgrade its tier.
   */
  workDir?: string;
  tier?: VisualReviewTier;
  tenantSlug?: string;
  missionId?: string;
}

/**
 * Rasterize a document via LibreOffice → PDF → PNG.
 *
 * Runs headless and offline: `soffice` is invoked with an isolated user
 * profile so a review never touches the operator's real LibreOffice state.
 */
export function rasterizeDocument(input: RasterizeDocumentInput): RasterResult {
  const capabilities = detectRasterCapabilities();
  if (!capabilities.hasSoffice || !capabilities.hasPdfRaster) {
    const missing = capabilities.missing.filter((name) => name !== 'playwright');
    return {
      available: false,
      images: [],
      unavailable_reason: `visual review cannot rasterize documents on this host: missing ${missing.join(', ')}. Install ${rasterInstallHint(missing)} to enable it.`,
    };
  }

  const scoped = assertVisualReviewPathScope({
    artifactPath: input.sourcePath,
    workDir: input.workDir,
    tier: input.tier ?? 'public',
    tenantSlug: input.tenantSlug,
    missionId: input.missionId,
  });
  const sourcePath = scoped.artifactPath;
  if (!safeExistsSync(sourcePath)) {
    return {
      available: false,
      images: [],
      unavailable_reason: `source artifact not found: ${sourcePath}`,
    };
  }

  const workDir = resolveWorkDir(input.label, scoped.workDir);
  const profileDir = path.join(workDir, 'lo-profile');
  safeMkdir(profileDir, { recursive: true });

  const sofficeBin = commandExists('soffice') ? 'soffice' : 'libreoffice';
  // A conversion failure is a degradation, not a crash: the caller asked for a
  // review and must get back "could not look at it", not an exception that
  // takes down the surrounding pipeline.
  try {
    safeExec(
      sofficeBin,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        sourcePath,
      ],
      { timeoutMs: 180_000, cwd: pathResolver.rootDir() }
    );
  } catch (error: any) {
    return {
      available: false,
      images: [],
      unavailable_reason: `LibreOffice could not convert ${path.basename(sourcePath)}: ${error?.message || error}`,
    };
  }

  const pdfName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
  const pdfPath = path.join(workDir, pdfName);
  if (!safeExistsSync(pdfPath)) {
    return {
      available: false,
      images: [],
      unavailable_reason: `LibreOffice produced no PDF for ${path.basename(sourcePath)}`,
    };
  }

  const pagePrefix = path.join(workDir, 'page');
  const args = ['-png', '-r', String(input.dpi ?? 150)];
  if (input.maxPages) args.push('-f', '1', '-l', String(input.maxPages));
  args.push(pdfPath, pagePrefix);
  try {
    safeExec('pdftoppm', args, { timeoutMs: 180_000, cwd: pathResolver.rootDir() });
  } catch (error: any) {
    return {
      available: false,
      images: [],
      unavailable_reason: `pdftoppm could not rasterize ${pdfName}: ${error?.message || error}`,
    };
  }

  const images = safeReaddir(workDir)
    .filter((name: string) => name.startsWith('page') && name.endsWith('.png'))
    .sort((a: string, b: string) => {
      const pageNumber = (name: string) => Number(name.match(/page-(\d+)\.png$/u)?.[1] || 0);
      return pageNumber(a) - pageNumber(b);
    })
    .map((name: string) => path.join(workDir, name));

  if (images.length === 0) {
    return {
      available: false,
      images: [],
      unavailable_reason: `pdftoppm produced no page images for ${pdfName}`,
    };
  }

  return { available: true, images, backend: 'soffice+pdftoppm' };
}

export interface RasterizeHtmlInput {
  /** Absolute paths to standalone HTML files (one image each). */
  htmlPaths: string[];
  label: string;
  width?: number;
  height?: number;
  /** Mission-local output directory; see RasterizeDocumentInput.workDir. */
  workDir?: string;
  tier?: VisualReviewTier;
  tenantSlug?: string;
  missionId?: string;
}

/**
 * Rasterize standalone HTML via Playwright — the path used for video scenes.
 *
 * Kept separate from the document path because it has different availability:
 * Playwright is already a workspace dependency, so scene review works on hosts
 * where LibreOffice is absent.
 */
export async function rasterizeHtml(input: RasterizeHtmlInput): Promise<RasterResult> {
  const capabilities = detectRasterCapabilities();
  if (!capabilities.hasHtmlRaster) {
    return {
      available: false,
      images: [],
      unavailable_reason: `visual review cannot rasterize HTML on this host: missing playwright. Install ${rasterInstallHint(['playwright'])} to enable it.`,
    };
  }

  const firstPath = input.htmlPaths[0];
  if (!firstPath) {
    return { available: false, images: [], unavailable_reason: 'no HTML sources supplied' };
  }
  const resolvedHtmlPaths = input.htmlPaths.map(
    (htmlPath) =>
      assertVisualReviewPathScope({
        artifactPath: htmlPath,
        workDir: input.workDir,
        tier: input.tier ?? 'public',
        tenantSlug: input.tenantSlug,
        missionId: input.missionId,
      }).artifactPath
  );
  const scoped = assertVisualReviewPathScope({
    artifactPath: firstPath,
    workDir: input.workDir,
    tier: input.tier ?? 'public',
    tenantSlug: input.tenantSlug,
    missionId: input.missionId,
  });
  const workDir = resolveWorkDir(input.label, scoped.workDir);
  const images: string[] = [];
  let browser: any;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: input.width ?? 1920, height: input.height ?? 1080 },
    });
    await page.route('**/*', async (route: any) => {
      const requestUrl = String(route.request().url());
      if (requestUrl.startsWith('data:') || requestUrl.startsWith('about:')) {
        return route.continue();
      }
      if (requestUrl.startsWith('file://')) {
        try {
          const requestedPath = decodeURIComponent(new URL(requestUrl).pathname);
          const allowedRoots = [
            ...resolvedHtmlPaths.map((htmlPath) => path.dirname(htmlPath)),
            workDir,
          ];
          const allowed = allowedRoots.some((allowedRoot) => {
            const relative = path.relative(allowedRoot, requestedPath);
            return !relative.startsWith('../') && !path.isAbsolute(relative);
          });
          if (allowed) {
            return route.continue();
          }
        } catch {
          // Fall through to abort malformed or foreign file URLs.
        }
      }
      return route.abort();
    });
    await page.setJavaScriptEnabled(false);
    for (const [index, resolved] of resolvedHtmlPaths.entries()) {
      if (!safeExistsSync(resolved)) continue;
      await page.goto(`file://${resolved}`, { waitUntil: 'load', timeout: 30_000 });
      const outPath = path.join(workDir, `scene-${String(index + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: outPath });
      images.push(outPath);
    }
  } catch (error: any) {
    return {
      available: false,
      images: [],
      unavailable_reason: `HTML rasterization failed: ${error?.message || error}`,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        logger.warn('failed to close the rasterization browser');
      }
    }
  }

  if (images.length === 0) {
    return { available: false, images: [], unavailable_reason: 'no HTML sources produced images' };
  }
  return { available: true, images, backend: 'playwright' };
}
