import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import { logger } from './core.js';

export type OpInputDomain = 'browser' | 'file' | 'system';

export interface OpInputContract {
  summary: string;
  examples: Array<Record<string, unknown>>;
  schema: Record<string, unknown>;
}

type ContractCatalog = Record<OpInputDomain, Record<string, OpInputContract>>;

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const INPUT_CONTRACTS: ContractCatalog = {
  browser: {
    goto: {
      summary: 'Navigate to a page URL.',
      examples: [{ url: 'https://example.com' }],
      schema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    open_tab: {
      summary: 'Open a page in a new tab.',
      examples: [{ url: 'https://example.com' }],
      schema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    click: {
      summary: 'Click a browser element by selector or ref.',
      examples: [{ selector: 'button[type="submit"]' }, { ref: 'login-submit' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
        properties: {
          selector: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
          element_name: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    query_elements: {
      summary: 'Count visible browser elements matching a selector and optional text.',
      examples: [{ selector: 'button', text: '承認', exact: true, export_as: 'approval_count' }],
      schema: {
        type: 'object',
        required: ['selector'],
        properties: {
          selector: { type: 'string', minLength: 1 },
          text: { type: 'string' },
          text_match: { type: 'string' },
          exact: { type: 'boolean' },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    click_first_match: {
      summary: 'Click the first visible browser element matching a selector and optional text.',
      examples: [{ selector: 'button', text: '承認', export_as: 'clicked_match' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['selector'] }, { required: ['selectors'] }],
        properties: {
          selector: { type: 'string', minLength: 1 },
          selectors: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
          text: { type: 'string' },
          exact: { type: 'boolean' },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    fill: {
      summary: 'Fill a browser input by selector or ref.',
      examples: [{ selector: 'input[name="email"]', text: 'user@example.com' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
        properties: {
          selector: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
          text: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    press: {
      summary: 'Press a key on a browser element by selector or ref.',
      examples: [{ selector: 'input[name="email"]', key: 'Enter' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
        properties: {
          selector: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
          key: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    wait: {
      summary: 'Wait for a browser selector or ref to appear.',
      examples: [{ selector: '#ready-state' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
        properties: {
          selector: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    snapshot: {
      summary: 'Capture a browser snapshot for assertions.',
      examples: [{ url: 'https://example.com', title: 'Example Domain' }],
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    extract_text_ref: {
      summary: 'Extract text from a captured browser ref.',
      examples: [{ ref: '@e1' }],
      schema: {
        type: 'object',
        required: ['ref'],
        properties: { ref: { type: 'string', minLength: 1 }, export_as: { type: 'string' } },
        additionalProperties: true,
      },
    },
    session_health: {
      summary: 'Inspect browser lease and session health.',
      examples: [{}],
      schema: {
        type: 'object',
        properties: { export_as: { type: 'string' } },
        additionalProperties: true,
      },
    },
    action_trail: {
      summary: 'Capture bounded redacted browser actions.',
      examples: [{ limit: 20 }],
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          from: { type: 'string' },
          export_as: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    scroll_ref: {
      summary: 'Scroll a captured browser ref into view.',
      examples: [{ ref: '@e1' }],
      schema: {
        type: 'object',
        required: ['ref'],
        properties: { ref: { type: 'string', minLength: 1 } },
        additionalProperties: true,
      },
    },
    scroll: {
      summary: 'Scroll the active viewport by a bounded delta.',
      examples: [{ delta: { y: 600 } }],
      schema: {
        type: 'object',
        properties: { delta: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' } },
        additionalProperties: true,
      },
    },
    fill_secret_ref: {
      summary: 'Fill from SecretResolver without recording the value.',
      examples: [{ ref: '@e1', secret_ref: 'TOKEN' }],
      schema: {
        type: 'object',
        required: ['ref', 'secret_ref'],
        properties: {
          ref: { type: 'string', minLength: 1 },
          secret_ref: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    export_failure_bundle: {
      summary: 'Export redacted browser failure evidence.',
      examples: [{ path: 'active/shared/tmp/browser/failure.json' }],
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, export_as: { type: 'string' } },
        additionalProperties: true,
      },
    },
    content: {
      summary: 'Assert that content is visible at a selector.',
      examples: [{ selector: '#status', content_excerpt: 'Ready' }],
      schema: {
        type: 'object',
        required: ['selector', 'content_excerpt'],
        properties: {
          selector: { type: 'string', minLength: 1 },
          content_excerpt: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
  },
  file: {
    read: {
      summary: 'Read a file from the workspace.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    read_file: {
      summary: 'Read a file from the workspace.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    read_json: {
      summary: 'Read a JSON file from the workspace.',
      examples: [{ path: 'knowledge/product/config.json' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    list: {
      summary: 'List a directory.',
      examples: [{ path: 'knowledge/product' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    stat: {
      summary: 'Inspect a filesystem entry.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    exists: {
      summary: 'Check whether a filesystem entry exists.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    search: {
      summary: 'Search a file tree with ripgrep.',
      examples: [{ path: 'knowledge/product', pattern: 'AR-03' }],
      schema: {
        type: 'object',
        required: ['path', 'pattern'],
        properties: {
          path: { type: 'string', minLength: 1 },
          pattern: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    tail: {
      summary: 'Read the tail of a file.',
      examples: [{ path: 'logs/latest.log' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write: {
      summary: 'Write content to a file.',
      examples: [{ path: 'knowledge/product/note.txt', content: 'hello' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          content: {},
          from: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write_file: {
      summary: 'Write a file to the workspace.',
      examples: [{ path: 'knowledge/product/note.txt', content: 'hello' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          output_path: { type: 'string', minLength: 1 },
          content: {},
          data: {},
          from: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write_artifact: {
      summary: 'Write an artifact file to the workspace.',
      examples: [{ output_path: 'active/shared/tmp/report.json', content: { ok: true } }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['path'] }, { required: ['output_path'] }],
        properties: {
          path: { type: 'string', minLength: 1 },
          output_path: { type: 'string', minLength: 1 },
          content: {},
          data: {},
          from: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    append: {
      summary: 'Append content to a file.',
      examples: [{ path: 'knowledge/product/log.txt', content: 'line' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          content: {},
          from: { type: 'string', minLength: 1 },
          newline: { type: 'boolean' },
        },
        additionalProperties: true,
      },
    },
    delete: {
      summary: 'Delete a file or directory.',
      examples: [{ path: 'active/shared/tmp/stale.json' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    mkdir: {
      summary: 'Create a directory.',
      examples: [{ path: 'active/shared/tmp/new-folder' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    copy: {
      summary: 'Copy a file.',
      examples: [{ from: 'knowledge/product/a.txt', to: 'active/shared/tmp/a.txt' }],
      schema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    move: {
      summary: 'Move a file.',
      examples: [{ from: 'knowledge/product/a.txt', to: 'active/shared/tmp/a.txt' }],
      schema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
  },
  system: {
    record_screen: {
      summary:
        'Record a bounded screen stream to an MP4 artifact through the canonical system bridge.',
      examples: [{ output: 'active/shared/tmp/screen-recording.mp4', duration: 3, fps: 30 }],
      schema: {
        type: 'object',
        required: ['output'],
        properties: {
          output: { type: 'string', minLength: 1 },
          duration: { type: 'number', minimum: 0 },
          fps: { type: 'number', exclusiveMinimum: 0, maximum: 120 },
          max_frames: { type: 'integer', minimum: 1 },
          frame_interval_ms: { type: 'number', minimum: 0 },
          display_index: { type: 'integer', minimum: 0 },
          display_name: { type: 'string', minLength: 1 },
          capture_mode: { enum: ['screen', 'focused_window'] },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    exec: {
      summary: 'Execute a host command under policy.',
      examples: [{ command: 'pnpm', args: ['build'] }],
      schema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
    },
    shell: {
      summary: 'Execute a shell command under policy.',
      examples: [{ command: 'pnpm build' }],
      schema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    macos_automation_probe: {
      summary:
        'Probe macOS Automation and Accessibility availability without changing host state. Screen Recording remains unknown unless a separate safe probe is available.',
      examples: [{ export_as: 'macos_automation' }],
      schema: {
        type: 'object',
        properties: {
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    reconcile_config_fallbacks: {
      summary:
        'Sweep the config-fallback registry: recreate missing public-tier knowledge JSON from defaults, write parse-error proposals. Returns { repaired, proposals_written, skipped, pruned }.',
      examples: [{ export_as: 'reconcile_result' }],
      schema: {
        type: 'object',
        properties: {
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    reconcile_unclassified_errors: {
      summary:
        'Sweep the unclassified-error registry and write rule-proposal stubs. Returns { proposals_written, skipped, total_unreconciled }.',
      examples: [{ export_as: 'reconcile_result' }],
      schema: {
        type: 'object',
        properties: {
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    reconcile_unhandled_intents: {
      summary:
        'Sweep the unhandled-intent registry and write routing/intent proposal stubs. Returns { proposals_written, skipped, total_unreconciled, top_unreconciled, summary_line }.',
      examples: [{ export_as: 'reconcile_result' }],
      schema: {
        type: 'object',
        properties: {
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    cost_report: {
      summary:
        'Aggregate the usage ledger into per-mission/per-model/per-day cost views (OP-01). Returns the structured report object.',
      examples: [{ last_days: 7, export_as: 'weekly_cost_report' }],
      schema: {
        type: 'object',
        properties: {
          since: { type: 'string', minLength: 1 },
          until: { type: 'string', minLength: 1 },
          last_days: { type: 'number', minimum: 1 },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    audit_verify: {
      summary:
        'Verify audit-chain continuity, ledger HMAC integrity, and tenant mirrors (SA-01). Returns { ok, audit, ledgers, tenantMirrors }.',
      examples: [{ export_as: 'audit_report' }],
      schema: {
        type: 'object',
        properties: {
          since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          ledgers: { type: 'array', items: { type: 'string', minLength: 1 } },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    summarize_memory_promotion_queue: {
      summary:
        'Summarize the memory promotion queue (KM-03); optionally persist markdown to output_path. Returns { rows, markdown, output_path? }.',
      examples: [
        { status: 'queued', output_path: 'active/shared/tmp/memory-promotion-queue-summary.md' },
      ],
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', minLength: 1 },
          output_path: { type: 'string', minLength: 1 },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    summarize_task_model_routing: {
      summary:
        'Aggregate task-model routing telemetry (MO-05) from observability JSONL streams; optionally persist JSON to output_path. Returns { samples, rows, output_path? }.',
      examples: [{ output_path: 'active/shared/tmp/task-model-routing-summary.json' }],
      schema: {
        type: 'object',
        properties: {
          task_events_path: { type: 'string', minLength: 1 },
          supervisor_events_path: { type: 'string', minLength: 1 },
          output_path: { type: 'string', minLength: 1 },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    open_url: {
      summary: 'Open a URL on the host.',
      examples: [{ url: 'https://example.com' }],
      schema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    open_file: {
      summary: 'Open a file path on the host.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    read_file: {
      summary: 'Read a file on the host.',
      examples: [{ path: 'knowledge/product/README.md' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    read_json: {
      summary: 'Read a JSON file on the host.',
      examples: [{ path: 'knowledge/product/config.json' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write_file: {
      summary: 'Write a file on the host.',
      examples: [{ path: 'active/shared/tmp/system-note.txt', content: 'hello' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          content: {},
          data: {},
          from: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write_artifact: {
      summary: 'Write an artifact on the host.',
      examples: [{ output_path: 'active/shared/tmp/system-note.txt', content: 'hello' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['path'] }, { required: ['output_path'] }],
        properties: {
          path: { type: 'string', minLength: 1 },
          output_path: { type: 'string', minLength: 1 },
          content: {},
          data: {},
          from: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    write_json: {
      summary: 'Write JSON data on the host.',
      examples: [{ path: 'active/shared/tmp/data.json', data: { ok: true } }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          data: {},
        },
        additionalProperties: true,
      },
    },
    notify: {
      summary: 'Send a host notification.',
      examples: [{ title: 'Kyberion', message: 'Build finished' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['message'] }, { required: ['text'] }],
        properties: {
          title: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          subtitle: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    app_quit: {
      summary: 'Quit a host application.',
      examples: [{ application: 'Finder' }],
      schema: {
        type: 'object',
        required: ['application'],
        properties: {
          application: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    process_kill: {
      summary: 'Terminate a host process by pid or name.',
      examples: [{ pid: 1234 }, { name: 'Finder' }],
      schema: {
        type: 'object',
        anyOf: [{ required: ['pid'] }, { required: ['name'] }],
        properties: {
          pid: { type: 'number', minimum: 1 },
          name: { type: 'string', minLength: 1 },
          signal: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    mkdir: {
      summary: 'Create a directory on the host.',
      examples: [{ path: 'active/shared/tmp/new-folder' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    copy: {
      summary: 'Copy a file on the host.',
      examples: [{ from: 'knowledge/product/a.txt', to: 'active/shared/tmp/a.txt' }],
      schema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    move: {
      summary: 'Move a file on the host.',
      examples: [{ from: 'knowledge/product/a.txt', to: 'active/shared/tmp/a.txt' }],
      schema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    delete: {
      summary: 'Delete a file or directory on the host.',
      examples: [{ path: 'active/shared/tmp/stale.json' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    wait: {
      summary: 'Wait for a period of time.',
      examples: [{ ms: 1000 }],
      schema: {
        type: 'object',
        properties: {
          ms: { type: 'number', minimum: 0 },
        },
        additionalProperties: true,
      },
    },
  },
};

const validatorCache = new Map<string, ValidateFunction>();

function opKey(domain: OpInputDomain, op: string): string {
  return `${domain}:${op}`;
}

function getValidator(domain: OpInputDomain, op: string): ValidateFunction | null {
  const contract = INPUT_CONTRACTS[domain]?.[op];
  if (!contract) return null;
  const key = opKey(domain, op);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  const validate = ajv.compile(contract.schema);
  validatorCache.set(key, validate);
  return validate;
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error: ErrorObject) => {
    const location = error.instancePath || '/';
    return `${location} ${error.message || 'schema violation'}`;
  });
}

export function getOpInputContract(domain: OpInputDomain, op: string): OpInputContract | null {
  return INPUT_CONTRACTS[domain]?.[op] || null;
}

export function validateOpInput(
  domain: OpInputDomain,
  op: string,
  params: unknown
): { valid: true } | { valid: false; errors: string[] } {
  const validate = getValidator(domain, op);
  if (!validate) return { valid: true };
  if (validate(params)) return { valid: true };
  const errors = formatErrors(validate);
  logger.warn(`[op-input-contracts] ${domain}:${op} input validation failed: ${errors.join('; ')}`);
  return { valid: false, errors };
}

export function listOpInputContracts(domain: OpInputDomain): Record<string, OpInputContract> {
  return { ...INPUT_CONTRACTS[domain] };
}
