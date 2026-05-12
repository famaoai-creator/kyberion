export type PipelineStepType = 'capture' | 'transform' | 'apply' | 'control';

interface DomainOpRegistry {
  capture?: string[];
  transform?: string[];
  apply?: string[];
}

const SHARED_CAPTURE_OPS = [
  'read',
  'read_file',
  'read_json',
  'fetch',
  'shell',
  'list',
  'glob_files',
  'search',
  'goto',
  'content',
  'evaluate',
  'vision_consult',
  'pulse_status',
  'discover_capabilities',
  'discover_skills',
  'screenshot',
  'pptx_extract',
];

const SHARED_TRANSFORM_OPS = [
  'regex_extract',
  'regex_replace',
  'json_query',
  'run_js',
  'yaml_update',
  'json_parse',
  'path_join',
  'array_count',
  'array_filter',
  'variable_hydrate',
  'json_update',
  'markdown_to_pdf',
  'apply_theme',
  'apply_pattern',
  'merge_content',
  'set',
  'document_diagram_asset_from_brief',
  'document_diagram_render_from_brief',
  'document_spreadsheet_design_from_brief',
  'document_report_design_from_brief',
  'theme_from_pptx_design',
];

const SHARED_APPLY_OPS = [
  'write',
  'write_file',
  'log',
  'click',
  'fill',
  'press',
  'wait',
  'delete',
  'mkdir',
  'symlink',
  'git_checkpoint',
  'voice',
  'notify',
  'keyboard',
  'mouse_click',
  'deploy',
  'append',
  'copy',
  'move',
  'pptx_render',
  'xlsx_render',
  'docx_render',
  'pdf_render',
  'drawio_write',
  'mermaid_render',
  'd2_render',
];

const DOMAIN_REGISTRY: Record<string, DomainOpRegistry> = {
  media: {
    transform: SHARED_TRANSFORM_OPS,
    apply: SHARED_APPLY_OPS,
    capture: ['pptx_extract'],
  },
  browser: {
    capture: ['goto', 'content', 'evaluate', 'screenshot'],
    apply: ['click', 'fill', 'press', 'wait', 'log'],
  },
  system: {
    capture: ['shell', 'list', 'pulse_status'],
    apply: ['log', 'notify', 'voice', 'voice_input_toggle'],
  },
  service: {
    capture: ['read', 'list'],
    apply: ['deploy', 'log', 'notify'],
  },
  file: {
    capture: ['read', 'read_file', 'read_json', 'list', 'glob_files'],
    transform: ['json_parse', 'json_query', 'path_join'],
    apply: ['write', 'write_file', 'append', 'copy', 'move', 'delete', 'mkdir', 'symlink'],
  },
  code: {
    capture: ['read', 'read_file', 'list', 'glob_files'],
    transform: ['apply_pattern', 'merge_content', 'set'],
    apply: ['write', 'write_file', 'append', 'copy', 'move', 'log'],
  },
  wisdom: {
    capture: ['search', 'read', 'read_file'],
    transform: ['regex_extract', 'regex_replace', 'json_query', 'yaml_update', 'json_parse'],
    apply: ['log'],
  },
  network: {
    capture: ['fetch', 'read'],
    apply: ['log'],
  },
  orchestrator: {
    capture: ['discover_capabilities', 'discover_skills'],
    apply: ['deploy', 'log'],
  },
  gemini: {
    capture: ['extensions', 'skills', 'hooks', 'mcp'],
    apply: ['prompt', 'log'],
  },
  gh: {
    capture: [],
    apply: ['pr', 'issue', 'repo', 'api', 'run-workflow', 'skill', 'agent-task'],
  },
  codex: {
    capture: ['review', 'app-server', 'cloud', 'mcp', 'features'],
    apply: ['exec', 'plugin'],
  },
};

export function determineActuatorStepType(domain: string, action: string): PipelineStepType {
  const registry = DOMAIN_REGISTRY[domain];
  if (registry?.apply?.includes(action)) return 'apply';
  if (registry?.capture?.includes(action)) return 'capture';
  if (registry?.transform?.includes(action)) return 'transform';

  if (SHARED_CAPTURE_OPS.includes(action)) return 'capture';
  if (SHARED_TRANSFORM_OPS.includes(action)) return 'transform';
  if (SHARED_APPLY_OPS.includes(action)) return 'apply';

  return 'apply';
}

export function listRegisteredDomainOps(domain: string): DomainOpRegistry {
  return DOMAIN_REGISTRY[domain] || {};
}
