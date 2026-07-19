import { describe, expect, it } from 'vitest';
import {
  getGenerationHistoryAdapter,
  getGenerationHistoryAdapterForAction,
} from './generation-artifact-adapters.js';

describe('modality-specific generation history adapters', () => {
  it('keeps video history from selecting image artifacts', () => {
    const adapter = getGenerationHistoryAdapterForAction('generate_video');
    const artifacts = adapter.extract_artifacts(
      {
        outputs: {
          '10': {
            images: [{ filename: 'preview.png', type: 'output' }],
            gifs: [{ filename: 'final.mp4', type: 'output' }],
          },
        },
      },
      (item) => `/output/${String(item.filename)}`
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filename).toBe('final.mp4');
    expect(adapter.select_primary(artifacts)?.filename).toBe('final.mp4');
  });

  it('keeps music history scoped to audio formats and detects provider failure', () => {
    const adapter = getGenerationHistoryAdapter('music');
    const artifacts = adapter.extract_artifacts(
      {
        status: { completed: true },
        outputs: {
          '11': {
            audio: [
              { filename: 'preview.png', type: 'preview' },
              { filename: 'song.wav', type: 'output' },
            ],
          },
        },
      },
      (item) => `/output/${String(item.filename)}`
    );

    expect(artifacts.map((artifact) => artifact.filename)).toEqual(['song.wav']);
    expect(adapter.select_primary(artifacts, 'wav')?.filename).toBe('song.wav');
    expect(adapter.is_complete({ status: { status_str: 'execution_error' } })).toBe(true);
    expect(adapter.is_failed({ status: { status_str: 'execution_error' } })).toBe(true);
  });

  it('supports generic workflow histories without coercing them to image modality', () => {
    const adapter = getGenerationHistoryAdapter('workflow');
    expect(adapter.modality).toBe('workflow');
    expect(adapter.accepted_formats).toContain('mp3');
    expect(adapter.is_complete({ status: { completed: true } })).toBe(true);
  });
});
