import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { renderSeeResult, runSeeCommand, SEE_USAGE } from './cli-see.js';
import { createFakeDeps } from './lib/perception.test-support.js';

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('pnpm kyberion see', () => {
  let workDir = '';
  let imagePath = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-see-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    imagePath = path.join(workDir, 'card.png');
    safeWriteFile(imagePath, pngHeader(640, 480));
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('OCRs locally and prints Markdown with size, dimensions, provider and confidence', async () => {
    const deps = createFakeDeps();
    const output: string[] = [];
    const result = await runSeeCommand(
      [path.relative(pathResolver.rootDir(), imagePath), '--lang', 'ja'],
      (text) => output.push(text),
      deps
    );
    expect(result).toMatchObject({ width: 640, height: 480, bytes: 33 });
    const printed = output.join('\n');
    expect(printed).toContain('640×480');
    expect(printed).toContain('fake_ocr (confidence 92, egress none)');
    expect(printed).toContain('## Text\n\nHello OCR');
    expect(deps.ocrPaths).toEqual([path.relative(pathResolver.rootDir(), imagePath)]);
  });

  it('adds a description with a provider note under --describe, and writes JSON with --out', async () => {
    const out = path.join(workDir, 'card.json');
    const output: string[] = [];
    await runSeeCommand(
      [imagePath, '--describe', '--json', '--out', out],
      (t) => output.push(t),
      createFakeDeps()
    );
    const written = JSON.parse(String(safeReadFile(out, { encoding: 'utf8' })));
    expect(written.description).toEqual({ text: 'A test card.', provider: 'fake_describer' });
    expect(written.warnings).toContain('description provided by fake_describer');
    expect(output.join('\n')).toMatch(/\[see\] wrote/);
  });

  it('reports OCR failure as a warning when a description still succeeded', async () => {
    const output: string[] = [];
    await runSeeCommand(
      [imagePath, '--describe'],
      (t) => output.push(t),
      createFakeDeps({ ocrError: 'no engine' })
    );
    expect(output.join('\n')).toContain('> [see] local OCR unavailable: no engine');
    await expect(
      runSeeCommand([imagePath], () => {}, createFakeDeps({ ocrError: 'no engine' }))
    ).rejects.toThrow(/nothing could be read/);
  });

  it('refuses files outside the repository with the copy-in instruction', async () => {
    await expect(
      runSeeCommand(['/Users/someone/Downloads/shot.png'], () => {}, createFakeDeps())
    ).rejects.toThrow(/outside the repository[\s\S]*active\/shared\/tmp/);
  });

  it('refuses unsupported types, unknown options, and prints usage', async () => {
    const txt = path.join(workDir, 'notes.txt');
    safeWriteFile(txt, 'hello');
    await expect(runSeeCommand([txt], () => {}, createFakeDeps())).rejects.toThrow(
      /unsupported file type/
    );
    await expect(runSeeCommand([imagePath, '--bogus'], () => {}, createFakeDeps())).rejects.toThrow(
      /Unknown option/
    );
    await expect(runSeeCommand([imagePath, '--lang'], () => {}, createFakeDeps())).rejects.toThrow(
      /--lang requires/
    );
    await expect(runSeeCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion see/);
    const output: string[] = [];
    await runSeeCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(SEE_USAGE);
  });

  it('renders an empty OCR result explicitly', () => {
    expect(
      renderSeeResult(
        { file: 'a.png', bytes: 1, ocr: { text: ' ', provider: 'p', confidence: 0 }, warnings: [] },
        false
      )
    ).toContain('_(no text recognized)_');
  });
});
