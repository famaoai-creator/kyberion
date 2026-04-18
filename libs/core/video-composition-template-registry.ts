import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import type { VideoCompositionTemplateRecord, VideoCompositionTemplateRegistry, VideoTemplateStatus } from './video-composition-contract.js';

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('public/governance/video-composition-template-registry.json');

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
  return process.env.KYBERION_VIDEO_COMPOSITION_TEMPLATE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

export function resetVideoCompositionTemplateRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getVideoCompositionTemplateRegistry(): VideoCompositionTemplateRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VideoCompositionTemplateRegistry>(raw, 'video composition template registry');
    cachedRegistryPath = registryPath;
    cachedRegistry = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VIDEO_TEMPLATE_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

export function listVideoCompositionTemplates(status: VideoTemplateStatus | 'all' = 'active'): VideoCompositionTemplateRecord[] {
  const registry = getVideoCompositionTemplateRegistry();
  if (status === 'all') return registry.templates;
  return registry.templates.filter((template) => template.status === status);
}

export function getVideoCompositionTemplateRecord(templateId?: string): VideoCompositionTemplateRecord {
  const registry = getVideoCompositionTemplateRegistry();
  const resolvedTemplateId = templateId || registry.default_template_id;
  return (
    registry.templates.find((template) => template.template_id === resolvedTemplateId)
    || registry.templates.find((template) => template.template_id === registry.default_template_id)
    || FALLBACK_REGISTRY.templates[0]
  );
}
