import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

export interface TranscribeOptions {
  apiKey: string;
  timeout?: number;
}

export interface TranscribeResult {
  text: string;
}

export async function transcribeAudio(
  filePath: string,
  options: TranscribeOptions
): Promise<TranscribeResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const maxSize = 25 * 1024 * 1024; // 25MB Whisper API limit
  if (stat.size > maxSize) {
    throw new Error(
      `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Whisper API limit is 25MB.`
    );
  }
  if (stat.size === 0) {
    throw new Error('Audio file is empty');
  }

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('model', 'whisper-1');

  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${options.apiKey}`,
          },
          timeout: options.timeout || 120000,
          maxContentLength: 50 * 1024 * 1024,
        }
      );
      if (!response.data || !response.data.text) {
        throw new Error('API returned an empty transcription');
      }
      return response.data;
    } catch (err: any) {
      const isRetryable =
        err.code === 'ECONNABORTED' ||
        (err.response && (err.response.status === 429 || err.response.status >= 500));
      if (isRetryable && attempt < maxRetries) {
        attempt++;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      if (err.code === 'ECONNABORTED') {
        throw new Error('Transcription request timed out after 120s');
      }
      if (err.response) {
        const msg = err.response.data ? JSON.stringify(err.response.data) : err.response.statusText;
        throw new Error(`Whisper API error (${err.response.status}): ${msg}`);
      }
      throw new Error(`Network error: ${err.message}`);
    }
  }
  throw new Error('Transcription failed after multiple attempts');
}
