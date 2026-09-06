import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface LlmSelectionPreferences {
  version: '1.0.0';
  provider: string;
  model_id?: string;
  updated_at?: string;
}

const LLM_SELECTION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/llm-selection-preferences.schema.json'
);

function llmSelectionCatalogAtPath(filePath: string) {
  return defineCatalog<LlmSelectionPreferences>({
    id: 'llm-selection-preferences',
    path: filePath,
    schema: LLM_SELECTION_SCHEMA_PATH,
  });
}

export function getLlmSelectionPreferencesPath(): string {
  return assertSafeRepositoryPath(
    path.join(resolveActiveProfileRoot(), 'onboarding', 'llm-selection.json'),
    { allowMissingLeaf: true }
  );
}

export function loadLlmSelectionPreferences(): LlmSelectionPreferences | null {
  try {
    const filePath = getLlmSelectionPreferencesPath();
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return null;
    const parsed = llmSelectionCatalogAtPath(filePath).load();
    return {
      version: '1.0.0',
      provider: parsed.provider.trim(),
      model_id:
        typeof parsed.model_id === 'string' && parsed.model_id.trim()
          ? parsed.model_id.trim()
          : undefined,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
    };
  } catch {
    return null;
  }
}

export function validateLlmSelectionPreferencesAtPath(
  value: unknown,
  filePath: string
): LlmSelectionPreferences {
  return llmSelectionCatalogAtPath(filePath).validate(value, filePath);
}
