import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';
import { convertToPPTX } from './lib.js';

vi.mock('child_process');

describe('ppt-artisan lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockMD = { title: 'Test Presentation', body: '# Slide 1', format: 'markdown' as const };

  it('should call execSync with correct Marp arguments using DocumentArtifact', async () => {
    // existsSync will be called multiple times:
    // 1. local marp check (false)
    // 2. temp dir check (false)
    // 3. cleanup checks (true)
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockReturnValueOnce(false) // marp bin
      .mockReturnValueOnce(false) // temp dir
      .mockReturnValue(true); // cleanup

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    await convertToPPTX({ markdown: mockMD, outputPath: 'out.pptx' });

    expect(writeSpy).toHaveBeenCalled();
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('--pptx --pptx-editable -o "out.pptx"'),
      expect.any(Object)
    );
    expect(unlinkSpy).toHaveBeenCalled();

    existsSpy.mockRestore();
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('should include theme artifact in command if provided', async () => {
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockReturnValueOnce(true) // marp bin
      .mockReturnValueOnce(true) // temp dir
      .mockReturnValue(true); // cleanup

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    const mockTheme = { title: 'Brand', body: 'section { color: red; }', format: 'text' as const };

    await convertToPPTX({ markdown: mockMD, outputPath: 'out.pptx', theme: mockTheme });

    expect(writeSpy).toHaveBeenCalledTimes(2); // MD and CSS
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('--theme'), expect.any(Object));

    existsSpy.mockRestore();
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('should provide detailed diagnostic on Marp CLI failure', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('Command failed') as any;
      err.stderr = Buffer.from('Error: theme file not found');
      throw err;
    });

    await expect(
      convertToPPTX({
        markdown: mockMD,
        outputPath: 'o.pptx',
        theme: { title: 'Bad', body: '', format: 'text' as const },
      })
    ).rejects.toThrow('Theme invalid or missing: Bad');
  });
});
