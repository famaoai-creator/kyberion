import { createProviderRegistry } from '../provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import type { OcrProvider } from '../contracts/ocr-types.js';
export const OCR_PROVIDER_SEAM = 'ocr-provider';
const registry = createProviderRegistry<OcrProvider>({
  seam: OCR_PROVIDER_SEAM,
  owner: 'libs/core/ocr/provider-registry.ts',
  source: 'ocr-provider-extension',
  missingIdError: 'OcrProvider.id is required',
});
export function ocrProviderRevision(): number {
  return registry.revision();
}
export function registerOcrProvider(
  provider: OcrProvider,
  metadata?: SeamProviderMetadata
): () => void {
  return registry.register(provider, metadata);
}
export function listOcrProviders(): OcrProvider[] {
  return registry.list();
}
export function getOcrProvider(id: string): OcrProvider | undefined {
  return registry.get(id);
}
export function resetOcrProviders(): void {
  registry.reset();
}
