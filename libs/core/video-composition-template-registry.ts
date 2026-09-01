import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import type {
  VideoCompositionTemplateRecord,
  VideoCompositionTemplateRegistry,
  VideoTemplateStatus,
} from './video-composition-contract.js';

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/video-composition-template-registry.json'
);
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/video-composition-template-registry.schema.json'
);

const FALLBACK_REGISTRY: VideoCompositionTemplateRegistry = {
  version: 'fallback',
  default_template_id: 'basic-title-card',
  templates: [
    {
      template_id: 'basic-title-card',
      display_name: 'Basic Title Card',
      status: 'active',
      renderer: 'builtin_html',
      supported_roles: ['hook', 'generic', 'cta'],
      required_content_fields: ['headline'],
      supported_output_formats: ['mp4', 'mov', 'webm'],
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: VideoCompositionTemplateRegistry | null = null;

function getRegistryPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_VIDEO_COMPOSITION_TEMPLATE_REGISTRY_PATH')?.trim() ||
      DEFAULT_REGISTRY_PATH,
    { allowMissingLeaf: true }
  );
}

const registryCatalog = defineCatalog<VideoCompositionTemplateRegistry>({
  id: 'video-composition-template-registry',
  path: getRegistryPath,
  schema: REGISTRY_SCHEMA_PATH,
  fallback: FALLBACK_REGISTRY,
  fallbackOnInvalid: true,
  onFallback: (error) => {
    if (!/missing:/u.test(String(error))) {
      logger.warn(
        `[VIDEO_TEMPLATE_REGISTRY] Failed to load registry at ${getRegistryPath()}: ${String(error)}`
      );
    }
  },
});

export function _resetVideoCompositionTemplateRegistryCacheForTests(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
  registryCatalog.reset();
}

export function getVideoCompositionTemplateRegistry(): VideoCompositionTemplateRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;
  cachedRegistryPath = registryPath;
  cachedRegistry = registryCatalog.load();
  return cachedRegistry;
}

export function listVideoCompositionTemplates(
  status: VideoTemplateStatus | 'all' = 'active'
): VideoCompositionTemplateRecord[] {
  const registry = getVideoCompositionTemplateRegistry();
  if (status === 'all') return registry.templates;
  return registry.templates.filter((template) => template.status === status);
}

export function getVideoCompositionTemplateRecord(
  templateId?: string
): VideoCompositionTemplateRecord {
  const registry = getVideoCompositionTemplateRegistry();
  const resolvedTemplateId = templateId || registry.default_template_id;
  return (
    registry.templates.find((template) => template.template_id === resolvedTemplateId) ||
    registry.templates.find((template) => template.template_id === registry.default_template_id) ||
    FALLBACK_REGISTRY.templates[0]
  );
}
