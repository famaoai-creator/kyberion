import { registerOcrProvider, listOcrProviders } from './provider-registry.js';
import { WindowsNativeOcrProvider, AppleVisionOcrProvider } from './providers/native.js';
import { TesseractOcrProvider } from './providers/tesseract.js';
import { LlmApiOcrProvider } from './providers/cloud.js';
import { LocalVlmOcrProvider } from './providers/local-vlm.js';
import type { OcrProvider } from '../contracts/ocr-types.js';

const builtinFactories: Readonly<Record<string, () => OcrProvider>> = {
  windows_native: () => new WindowsNativeOcrProvider(),
  apple_vision: () => new AppleVisionOcrProvider(),
  llm_api: () => new LlmApiOcrProvider(),
  local_vlm: () => new LocalVlmOcrProvider(),
  tesseract: () => new TesseractOcrProvider(),
};

/** Composition registers only missing builtins, preserving explicit plugin bindings. */
export function ensureBuiltinOcrProviders(): void {
  const existing = new Set(listOcrProviders().map((p) => p.id));
  for (const [id, factory] of Object.entries(builtinFactories)) {
    if (!existing.has(id)) {
      registerOcrProvider(factory(), { provenance: 'builtin', source: 'ocr-bridge' });
    }
  }
}
