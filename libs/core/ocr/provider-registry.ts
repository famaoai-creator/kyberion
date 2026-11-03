import {
  coreSeamCatalog,
  createSeam,
  createSeamLifecycle,
  type SeamProviderMetadata,
} from '../seam.js';
import type { OcrProvider } from '../ocr-types.js';
export const OCR_PROVIDER_SEAM = 'ocr-provider';
const ocrProviderSeam = createSeam<OcrProvider>({
  key: 'ocr-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/ocr/provider-registry.ts',
});
let revision = 0;
const lifecycle = createSeamLifecycle(ocrProviderSeam, {
  onChange: () => {
    revision++;
  },
});
export function ocrProviderRevision(): number {
  return revision;
}
export function registerOcrProvider(
  provider: OcrProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'ocr-provider-extension' }
): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('OcrProvider.id is required');
  return lifecycle.register(id, provider, metadata);
}
export function listOcrProviders(): OcrProvider[] {
  return ocrProviderSeam.list().map((record) => record.implementation);
}
export function resetOcrProviders(): void {
  lifecycle.reset();
}
