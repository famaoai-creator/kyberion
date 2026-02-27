import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';
import { loadVoiceConfig, cleanTextForSpeech, speakText, speakArtifact } from './lib.js';

vi.mock('fs');
vi.mock('child_process');

describe('voice-interface-maestro lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load config from file or return defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ engine: 'api', voice: 'Pro' }));

    const config = loadVoiceConfig('/test/config.json');
    expect(config.engine).toBe('api');
    expect(config.voice).toBe('Pro');

    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadVoiceConfig('/none.json').engine).toBe('macos');
  });

  it('should clean text by skipping code blocks', () => {
    const text = 'Here is code: ```const x = 1;``` and more.';
    expect(cleanTextForSpeech(text)).toContain('[コードをスキップ]');
    expect(cleanTextForSpeech(text)).not.toContain('const x = 1');
  });

  it('should clean Markdown formatting for natural speech', () => {
    const mdText = '# Title\nCheck [this link](http://ex.com) and **bold** text.';
    const cleaned = cleanTextForSpeech(mdText);
    expect(cleaned).toBe('Title Check this link and bold text.');
  });

  it('should call say command for macos engine', () => {
    const config = { engine: 'macos', voice: 'Alex' };
    speakText('Hello world', config as any);

    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('say -v Alex "Hello world"'));
  });

  it('should use fallback for non-macos engines', () => {
    const config = { engine: 'elevenlabs', voice: 'Bella' };
    const result = speakText('Hi', config as any);

    expect(result.method).toBe('api-elevenlabs');
    expect(result.success).toBe(true);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('should speak DocumentArtifact content', () => {
    const artifact = { title: 'Note', body: 'Hello artifact', format: 'text' as const };
    const config = { engine: 'macos', voice: 'Alex' };
    const result = speakArtifact(artifact, config as any);

    expect(result.success).toBe(true);
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('say -v Alex "Hello artifact"'));
  });
});
