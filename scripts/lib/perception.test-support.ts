/**
 * Hermetic PerceptionDeps for the see / listen / watch tests: no OCR engine,
 * STT backend, or ffmpeg is touched — every provider call is recorded.
 */
import * as path from 'node:path';
import { safeWriteFile } from '@agent/core/secure-io';
import type { SpeechToTextBridge } from '@agent/core/speech-to-text-bridge';
import type { MediaTool, PerceptionDeps } from './perception.js';

export interface FakeDepsOptions {
  ocrText?: (imagePath: string) => string;
  ocrError?: string;
  bridges?: SpeechToTextBridge[];
  ffprobe?: string;
  frameCount?: number;
  missingFfmpeg?: boolean;
}

export interface FakeDeps extends PerceptionDeps {
  calls: { tool: MediaTool; args: string[] }[];
  ocrPaths: string[];
}

export function createFakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const calls: { tool: MediaTool; args: string[] }[] = [];
  const ocrPaths: string[] = [];
  return {
    calls,
    ocrPaths,
    async ocr(request) {
      ocrPaths.push(request.path);
      if (options.ocrError) throw new Error(options.ocrError);
      return {
        status: 'succeeded',
        provider: 'fake_ocr',
        text: options.ocrText ? options.ocrText(request.path) : 'Hello OCR',
        confidence: 91.6,
        elapsedMs: 1,
        providerDataEgress: request.mode === 'local_only' ? 'none' : 'external',
      };
    },
    async describe() {
      return {
        status: 'succeeded',
        provider: 'fake_describer',
        description: 'A test card.',
        elapsedMs: 1,
      };
    },
    async sttBridges() {
      return options.bridges ?? [];
    },
    async runMedia(tool, args) {
      calls.push({ tool, args });
      if (options.missingFfmpeg)
        throw new Error(`${tool} not found. Please install via 'brew install ffmpeg'`);
      if (tool === 'ffprobe') return options.ffprobe ?? '{}';
      const output = args[args.length - 1]!;
      if (output.includes('%04d')) {
        for (let i = 1; i <= (options.frameCount ?? 3); i += 1) {
          safeWriteFile(
            output.replace('%04d', String(i).padStart(4, '0')),
            Buffer.from([0x89, 0x50])
          );
        }
      } else {
        safeWriteFile(output, Buffer.from('RIFF'));
      }
      return '';
    },
  };
}

export function fakeBridge(
  name: string,
  result: {
    text: string;
    segments?: { start_sec: number; end_sec: number; text: string }[];
    synthetic?: boolean;
  },
  seen: string[] = []
): SpeechToTextBridge {
  return {
    name,
    priority: 10,
    capabilities: result.segments
      ? { timestamps: true, granularity: 'segment', local_only: true }
      : { timestamps: false, granularity: 'none', local_only: true },
    async transcribe(input) {
      seen.push(input.audioPath, input.outputPath ?? '');
      return {
        text: result.text,
        backend: name,
        language: input.language ?? 'en',
        ...(result.segments ? { segments: result.segments } : {}),
        ...(result.synthetic ? { synthetic: true } : {}),
        written_to: input.outputPath ?? path.join(path.dirname(input.audioPath), 'x.txt'),
      };
    },
  };
}
