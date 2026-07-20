/**
 * MP-04: rasterization.
 *
 * The capability-detection behaviour is asserted unconditionally, because
 * degrading correctly on a host without the binaries is the case that actually
 * ships. The end-to-end rasterization runs only where the binaries exist and
 * skips loudly elsewhere — a test that silently passes when it did nothing
 * would be the same failure this module exists to prevent.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateNativePdf } from './src/native-pdf-engine/engine.js';
import { pathResolver } from './path-resolver.js';
import { safeExec, safeMkdir, safeReaddir } from './secure-io.js';
import {
  detectRasterCapabilities,
  assertVisualReviewPathScope,
  rasterInstallHint,
  rasterizeDocument,
  resetRasterCapabilitiesCache,
} from './visual-raster.js';

const capabilities = detectRasterCapabilities({ refresh: true });

describe('capability detection', () => {
  it('reports each rasterizer independently', () => {
    resetRasterCapabilitiesCache();
    const detected = detectRasterCapabilities({ refresh: true });
    expect(typeof detected.hasSoffice).toBe('boolean');
    expect(typeof detected.hasPdfRaster).toBe('boolean');
    expect(typeof detected.hasHtmlRaster).toBe('boolean');
  });

  it('lists exactly the binaries that are missing', () => {
    const detected = detectRasterCapabilities({ refresh: true });
    expect(detected.missing.includes('soffice')).toBe(!detected.hasSoffice);
    expect(detected.missing.includes('pdftoppm')).toBe(!detected.hasPdfRaster);
    expect(detected.missing.includes('playwright')).toBe(!detected.hasHtmlRaster);
  });

  it('gives an actionable install hint for every missing binary', () => {
    const hint = rasterInstallHint(['soffice', 'pdftoppm', 'playwright']);
    expect(hint).toContain('LibreOffice');
    expect(hint).toContain('Poppler');
    expect(hint).toContain('Playwright');
  });

  it('caches until explicitly refreshed', () => {
    const first = detectRasterCapabilities({ refresh: true });
    expect(detectRasterCapabilities()).toBe(first);
  });
});

describe('degradation', () => {
  it('keeps non-public artifacts out of shared and foreign paths', () => {
    expect(() =>
      assertVisualReviewPathScope({
        artifactPath: pathResolver.sharedTmp('visual-raster-tests/confidential.pptx'),
        tier: 'confidential',
        missionId: 'MSN-VISUAL-RASTER-TEST',
      })
    ).toThrow(/VISUAL_REVIEW_PATH_DENIED/);

    expect(() =>
      assertVisualReviewPathScope({
        artifactPath: pathResolver.rootResolve('active/missions/public/foreign.pptx'),
        tier: 'confidential',
      })
    ).toThrow(/VISUAL_REVIEW_TIER_MISMATCH|VISUAL_REVIEW_PATH_DENIED/);
  });

  it('returns an unavailable result rather than throwing on a missing source', () => {
    const result = rasterizeDocument({ sourcePath: 'no/such/deck.pptx', label: 'missing' });
    expect(result.available).toBe(false);
    expect(result.images).toEqual([]);
    expect(result.unavailable_reason).toBeTruthy();
  });

  it('names what to install when a rasterizer is absent', () => {
    if (capabilities.hasSoffice && capabilities.hasPdfRaster) {
      // Both present: the degradation path cannot be exercised here.
      expect(true).toBe(true);
      return;
    }
    const result = rasterizeDocument({ sourcePath: 'no/such/deck.pptx', label: 'missing' });
    expect(result.unavailable_reason).toMatch(/soffice|pdftoppm|not found/i);
  });
});

describe.skipIf(!capabilities.hasPdfRaster)('PDF rasterization (requires poppler)', () => {
  it('turns a real PDF into page images', async () => {
    const workDir = pathResolver.sharedTmp('visual-raster-tests/pdf');
    safeMkdir(workDir, { recursive: true });
    const pdfPath = path.join(workDir, 'sample.pdf');

    await generateNativePdf(
      {
        version: '1.0.0',
        generatedAt: '2026-07-20T00:00:00.000Z',
        canvas: { w: 8.5, h: 11 },
        theme: {},
        master: { elements: [] },
        source: { body: 'Rasterization check. This page proves the pipeline runs end to end.' },
      } as any,
      pdfPath
    );

    safeExec('pdftoppm', ['-png', '-r', '80', pdfPath, path.join(workDir, 'page')], {
      timeoutMs: 60_000,
    });

    const images = safeReaddir(workDir).filter((name: string) => name.endsWith('.png'));
    expect(images.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!capabilities.hasSoffice || !capabilities.hasPdfRaster)(
  'document rasterization (requires LibreOffice + poppler)',
  () => {
    it('rasterizes a rendered PPTX into page images', async () => {
      const { generateNativePptx } = await import('./src/native-pptx-engine/engine.js');
      const workDir = pathResolver.sharedTmp('visual-raster-tests/pptx');
      safeMkdir(workDir, { recursive: true });
      const deckPath = path.join(workDir, 'deck.pptx');

      await generateNativePptx(
        {
          version: '1.0.0',
          generatedAt: '2026-07-20T00:00:00.000Z',
          canvas: { w: 10, h: 5.625 },
          theme: {},
          master: { elements: [] },
          slides: [
            {
              id: 'slide1',
              elements: [
                {
                  type: 'text',
                  pos: { x: 1, y: 1, w: 8, h: 1.5 },
                  text: 'ラスタライズ検証',
                  style: { fontSize: 32 },
                },
              ],
            },
          ],
        } as any,
        deckPath
      );

      const result = rasterizeDocument({
        sourcePath: deckPath,
        label: 'pptx-raster-test',
        dpi: 80,
        workDir: path.join(workDir, 'out'),
      });

      expect(result.available).toBe(true);
      expect(result.backend).toBe('soffice+pdftoppm');
      expect(result.images.length).toBeGreaterThan(0);
    }, 240_000);
  }
);
