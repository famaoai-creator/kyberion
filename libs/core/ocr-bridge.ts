/** Stable OCR facade; registry, routing and concrete providers have separate boundaries. */
import type { OcrRequest, OcrResult } from './contracts/ocr-types.js';
import { AdaptivePolicyRouter, ocrImageWithRouter } from './ocr/router.js';
import { listOcrProviders, ocrProviderRevision } from './ocr/provider-registry.js';
import { ensureBuiltinOcrProviders } from './ocr/builtin-providers.js';
let cachedRouter: { revision: number; router: AdaptivePolicyRouter } | undefined;
function getRouter(): AdaptivePolicyRouter {
  ensureBuiltinOcrProviders();
  const revision = ocrProviderRevision();
  if (!cachedRouter || cachedRouter.revision !== revision)
    cachedRouter = { revision, router: new AdaptivePolicyRouter(listOcrProviders()) };
  return cachedRouter.router;
}
export async function ocrImage(request: OcrRequest): Promise<OcrResult> {
  return ocrImageWithRouter(
    { ...request, training_use: request.training_use || 'local_only' },
    getRouter()
  );
}
export { registerOcrProvider } from './ocr/provider-registry.js';
export { listOcrProviders } from './ocr/provider-registry.js';
export { resetOcrProviders } from './ocr/provider-registry.js';
export { WindowsNativeOcrProvider } from './ocr/providers/native.js';
export { parseGeminiOcrResponse } from './ocr/provider-support.js';
export { parseClaudeOcrResponse } from './ocr/provider-support.js';
export { parseOpenAiOcrResponse } from './ocr/provider-support.js';
export { parseLocalVlmOcrResponse } from './ocr/provider-support.js';
export { toTesseractLanguage } from './ocr/provider-support.js';
export { TesseractOcrProvider } from './ocr/providers/tesseract.js';
export { AppleVisionOcrProvider } from './ocr/providers/native.js';
export { LlmApiOcrProvider } from './ocr/providers/cloud.js';
export { LocalVlmOcrProvider } from './ocr/providers/local-vlm.js';
export { AdaptivePolicyRouter } from './ocr/router.js';
export { ensureBuiltinOcrProviders } from './ocr/builtin-providers.js';
export { ocrImageWithRouter } from './ocr/router.js';
