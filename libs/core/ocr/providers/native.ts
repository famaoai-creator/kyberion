import { recognizeImageLocallyWithAppleVision } from '../../provider/apple-intelligence-bridge.js';
import { isMacOS } from '../../platform-facts.js';
import { pathResolver } from '../../path-resolver.js';
import { assertSafeRepositoryPath, validateFileSize } from '../../secure-io.js';
import { spawnManagedProcess } from '../../tool/managed-process.js';
import { parseSafeJsonObjectInput } from '../../foundation/safe-json.js';
import { OcrRequest, OcrResult, OcrProvider } from '../../contracts/ocr-types.js';
import {
  probeWindowsNativeImageRecognition,
  recognizeTextWithWindowsNativeApi,
} from '../windows-native-image-recognition-bridge.js';
import { resolveOcrImagePath, parseAppleVisionLines } from '../provider-support.js';

export class WindowsNativeOcrProvider implements OcrProvider {
  readonly id = 'windows_native';
  readonly dataEgress = 'none' as const; // Windows OCR API, in-process

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageRecognition().ocr;
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const result = recognizeTextWithWindowsNativeApi(resolveOcrImagePath(request.path));
    if (!result || result.status !== 'succeeded') {
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: 'windows_native_ocr_failed',
        elapsedMs: Date.now() - startedAt,
      };
    }
    return {
      status: 'succeeded',
      provider: this.id,
      text: result.text || '',
      confidence: Number(result.confidence || 0),
      lines: result.lines,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export class AppleVisionOcrProvider implements OcrProvider {
  readonly id = 'apple_vision';
  readonly dataEgress = 'none' as const; // macOS Vision framework, on-device

  async isAvailable(): Promise<boolean> {
    return isMacOS();
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(request.timeout_ms ?? 15000, 15000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('OCR timeout_ms must be positive');
    const deadlineAtMs = startedAt + timeoutMs;
    const resolvedImagePath = resolveOcrImagePath(request.path);
    // Content authorization precedes both native paths; a policy denial must
    // never be interpreted as an unavailable compiled helper.
    validateFileSize(resolvedImagePath, 512);
    request.signal?.throwIfAborted();
    const compiled = await recognizeImageLocallyWithAppleVision(resolvedImagePath, {
      ...(request.language ? { language: request.language } : {}),
      timeoutMs: Math.max(0, deadlineAtMs - Date.now()),
    });
    request.signal?.throwIfAborted();
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: 'apple_vision_ocr_timeout: Native OCR execution exhausted its shared deadline',
        elapsedMs: Date.now() - startedAt,
      };
    }
    // Older helper binaries may return only text/labels. Do not manufacture
    // confidence or discard geometry: screen privacy masking needs real boxes.
    if (
      compiled &&
      typeof compiled.confidence === 'number' &&
      Number.isFinite(compiled.confidence) &&
      compiled.confidence >= 0 &&
      compiled.confidence <= 100 &&
      Array.isArray(compiled.lines) &&
      compiled.lines.every((line) => line.boundingBox !== undefined)
    ) {
      return {
        status: 'succeeded',
        provider: this.id,
        text: compiled.text,
        confidence: compiled.confidence,
        lines: compiled.lines,
        boundingBoxUnits: 'normalized',
        elapsedMs: Date.now() - startedAt,
      };
    }
    // The legacy script only understands Japanese/US English. Never silently
    // turn an explicit French/German/etc. request into its English default.
    const legacyLanguageSupported =
      !request.language ||
      request.language
        .split(/[+,]/u)
        .every((language) =>
          /^(?:ja(?:-jp)?|jpn|jp|en(?:-us)?|eng)$/iu.test(language.trim().replaceAll('_', '-'))
        );
    if (!legacyLanguageSupported) {
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: 'apple_vision_requested_language_unavailable',
        elapsedMs: Date.now() - startedAt,
      };
    }
    // The legacy Swift parser is case-sensitive and recognizes jpn/eng.
    // Canonicalize the already-validated hints rather than changing their meaning.
    const legacyLanguage = request.language
      ?.split(/[+,]/u)
      .map((language) => (language.trim().toLowerCase().startsWith('j') ? 'jpn' : 'eng'))
      .join('+');
    // Retain the legacy Vision implementation for older hosts/toolchains and
    // helpers without the extended OCR contract; it remains on-device.
    validateFileSize(resolvedImagePath, 512);
    const scriptPath = assertSafeRepositoryPath(
      pathResolver.resolve('libs/core/ocr/native-ocr.swift')
    );

    return new Promise((resolve, reject) => {
      const args = [scriptPath, resolvedImagePath];
      if (legacyLanguage) {
        args.push(legacyLanguage);
      }

      const child = spawnManagedProcess({
        resourceId: `ocr-apple-vision:${Date.now()}`,
        kind: 'service',
        ownerId: 'ocr-bridge',
        ownerType: 'core-bridge',
        command: 'swift',
        args,
        spawnOptions: {
          cwd: pathResolver.rootDir(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        shutdownPolicy: 'manual',
      });

      let stdout = '';
      let stderr = '';
      let completed = false;

      const timer = setTimeout(
        () => {
          if (completed) return;
          completed = true;
          try {
            child.child.kill('SIGKILL');
          } catch {
            // ignore
          }
          reject(
            new Error(`apple_vision_ocr_timeout: Native OCR execution exceeded ${timeoutMs}ms`)
          );
        },
        Math.max(0, deadlineAtMs - Date.now())
      );

      const cleanup = () => {
        completed = true;
        clearTimeout(timer);
      };

      child.child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.child.on('error', (err) => {
        if (completed) return;
        cleanup();
        try {
          child.child.kill();
        } catch {
          // ignore
        }
        reject(err);
      });

      child.child.on('close', (code) => {
        if (completed) return;
        cleanup();

        const raw = stdout.trim();
        if (!raw) {
          return reject(new Error(stderr.trim() || `apple_vision_failed_${code}`));
        }

        try {
          const parsed = parseSafeJsonObjectInput(raw, 'apple vision OCR response');
          if (!parsed) throw new Error('apple vision OCR response must not be empty');
          if (parsed.error) {
            return reject(new Error(String(parsed.error)));
          }
          resolve({
            status: parsed.status === 'succeeded' ? 'succeeded' : 'failed',
            provider: this.id,
            text: typeof parsed.text === 'string' ? parsed.text : '',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
            lines: parseAppleVisionLines(parsed.lines),
            // Vision reports 0..1 fractions of the image (native-ocr.swift flips to top-left).
            boundingBoxUnits: 'normalized',
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error: any) {
          reject(new Error(`apple_vision_invalid_json: ${error?.message || error}: ${raw}`));
        }
      });
    });
  }
}
