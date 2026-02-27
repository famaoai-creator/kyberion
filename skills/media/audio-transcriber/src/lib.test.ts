import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import axios from 'axios';
import { transcribeAudio } from './lib.js';

vi.mock('axios');

describe('audio-transcriber lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error if file does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    await expect(transcribeAudio('/missing.mp3', { apiKey: 'test' })).rejects.toThrow(
      'Audio file not found'
    );
  });

  it('should throw error if file is too large', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 30 * 1024 * 1024 } as any);
    await expect(transcribeAudio('/large.mp3', { apiKey: 'test' })).rejects.toThrow(
      'File too large'
    );
  });

  it('should call Whisper API and return text', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 1024 } as any);

    // Mock Stream-like object for form-data compatibility
    const mockStream = {
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
      pause: vi.fn().mockReturnThis(),
      resume: vi.fn().mockReturnThis(),
    };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream as any);

    vi.mocked(axios.post).mockResolvedValue({ data: { text: 'Transcribed text' } });

    const result = await transcribeAudio('/test.mp3', { apiKey: 'test' });
    expect(result.text).toBe('Transcribed text');
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('transcriptions'),
      expect.anything(),
      expect.any(Object)
    );
  });

  it('should handle API errors correctly', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 1024 } as any);

    const mockStream = {
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
      pause: vi.fn().mockReturnThis(),
      resume: vi.fn().mockReturnThis(),
    };
    vi.spyOn(fs, 'createReadStream').mockReturnValue(mockStream as any);

    vi.mocked(axios.post).mockRejectedValue({
      response: { status: 401, data: { error: 'Invalid API Key' } },
    });

    await expect(transcribeAudio('/test.mp3', { apiKey: 'bad-key' })).rejects.toThrow(
      'Whisper API error (401)'
    );
  });

  it('should retry on 500 error and succeed eventually', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 1024 } as any);
    vi.spyOn(fs, 'createReadStream').mockReturnValue({
      on: vi.fn().mockReturnThis(),
      pause: vi.fn().mockReturnThis(),
      resume: vi.fn().mockReturnThis(),
    } as any);

    vi.mocked(axios.post)
      .mockRejectedValueOnce({ response: { status: 500, statusText: 'Server Error' } })
      .mockResolvedValueOnce({ data: { text: 'Retry success' } });

    const result = await transcribeAudio('/test.mp3', { apiKey: 'test' });
    expect(result.text).toBe('Retry success');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
