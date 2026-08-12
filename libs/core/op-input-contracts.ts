import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import { logger } from './core.js';
import type { ResourceClaim } from './tool-call-scheduler.js';

export type OpInputDomain = 'browser' | 'file' | 'system' | 'ingest';

/**
 * KD-07: one entry in an op's declared resource footprint. Resolved into a
 * concrete {@link ResourceClaim} per call via `resolveOpAccessClaims`, using
 * either a literal path/flag (fixed-location ops like `list_knowledge`) or a
 * param name to read from the actual call params (path-taking ops like
 * `read_file`).
 */
export interface OpAccessDeclaration {
  kind: 'file';
  operation: 'read' | 'write';
  /** Literal path, for ops that always touch a fixed location. */
  path?: string;
  /** Param name to read the path from at call time. */
  pathParam?: string;
  /** Literal recursive flag. */
  recursive?: boolean;
  /** Param name supplying a boolean recursive flag at call time. */
  recursiveParam?: string;
}

export interface OpInputContract {
  summary: string;
  examples: Array<Record<string, unknown>>;
  schema: Record<string, unknown>;
  /**
   * KD-07: declared resource claims for the tool-call scheduler
   * (tool-call-scheduler.ts). Absent (`undefined`) means the op has not been
   * audited yet — callers must treat it conservatively as `{kind:'all'}`
   * (today's fully-serial behavior). An explicit empty array means the op is
   * known to touch no shared resource (e.g. it only transforms in-memory
   * context) and may always run in parallel.
   */
  accesses?: OpAccessDeclaration[];
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      // Single-level directory listing (safeReaddir) — not recursive.
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path', recursive: false }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      // rg recurses through the target subtree by default.
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path', recursive: true }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
    probe_active_profile: {
      summary: 'Check whether a file exists under the active customer or personal profile root.',
      examples: [{ path: 'my-identity.json', export_as: 'identity_probe' }],
      schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
      accesses: [{ kind: 'file', operation: 'read', pathParam: 'path' }],
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
  // DA-04: ingest-actuator capture/transform ops (parse → normalize → dedup).
  // These ops never write into knowledge/ — the knowledge/ landing is DA-05's
  // ingest:commit ceremony.
  ingest: {
    // DA-03: incremental change-listing. Reads the tenant × source watermark,
    // pages the source's read preset, and returns the differential work list;
    // the watermark advances only after a fully successful listing
    // (at-least-once — mid-fetch failure records consecutive_failures and
    // leaves the cursor untouched). Never downloads bodies, never commits.
    sync_source: {
      summary:
        'Incremental sync change-listing for one tenant × source system (box/slack/confluence): watermark read → preset pagination → work-list items + new cursor. Advances the watermark only on full success; truncation by max_items and thrown transport errors never move it (at-least-once). Transport retry/backoff lives in the service-engine recovery_policy layer, not here.',
      examples: [
        {
          tenant_slug: 'acme-corp',
          source_system: 'box',
          source_params: { folder_id: '0' },
          max_items: 200,
          dry_run: true,
        },
        {
          tenant_slug: 'acme-corp',
          source_system: 'slack',
          source_params: { channel: 'C0123456789' },
        },
      ],
      schema: {
        type: 'object',
        required: ['tenant_slug', 'source_system', 'source_params'],
        properties: {
          tenant_slug: {
            type: 'string',
            minLength: 1,
            not: { enum: ['public', 'confidential', 'personal', 'shared'] },
          },
          source_system: { type: 'string', enum: ['box', 'slack', 'confluence'] },
          source_params: { type: 'object' },
          auth: { type: 'string', enum: ['none', 'secret-guard'] },
          max_items: { type: 'number', minimum: 1 },
          page_limit: { type: 'number', minimum: 1 },
          dry_run: { type: 'boolean' },
          now: { type: 'string' },
          cursor_path_seam: { type: 'string', minLength: 1 },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    parse_document: {
      summary:
        'Parse an unstructured document (docx/pdf/xlsx/html/slack_thread/markdown/text) into the unified ingest intermediate representation.',
      examples: [
        {
          source_path: 'active/shared/tmp/report.docx',
          format: 'docx',
          source_meta: { source_system: 'confluence', source_id: 'PAGE-123' },
        },
        { content_text: '# Notes\n\nBody', format: 'markdown' },
      ],
      schema: {
        type: 'object',
        required: ['format'],
        anyOf: [
          { required: ['source_path'] },
          { required: ['content_base64'] },
          { required: ['content_text'] },
        ],
        properties: {
          format: {
            type: 'string',
            enum: ['docx', 'pdf', 'xlsx', 'html', 'slack_thread', 'markdown', 'text'],
          },
          source_path: { type: 'string', minLength: 1 },
          content_base64: { type: 'string', minLength: 1 },
          content_text: { type: 'string' },
          source_meta: {
            type: 'object',
            properties: {
              source_system: { type: 'string' },
              source_id: { type: 'string' },
              source_url: { type: 'string' },
              source_version: { type: 'string' },
              retrieved_at: { type: 'string' },
            },
            additionalProperties: true,
          },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    normalize_card: {
      summary:
        'Normalize a parsed ingest IR into a knowledge-card (target_path + schema-validated frontmatter + markdown body). Fails closed when required card keys cannot be derived.',
      examples: [
        {
          ir: { text_markdown: '# Title\n\nBody', meta: { format: 'markdown' } },
          target: { tenant_slug: 'acme-corp', relative_path: 'reports/q1.md' },
          card: { kind: 'reference' },
          now: '2026-07-28T00:00:00.000Z',
        },
      ],
      schema: {
        type: 'object',
        required: ['ir', 'target'],
        properties: {
          ir: { type: 'object' },
          target: {
            type: 'object',
            required: ['relative_path'],
            properties: {
              tenant_slug: {
                type: 'string',
                minLength: 1,
                not: { enum: ['public', 'confidential', 'personal', 'shared'] },
              },
              relative_path: { type: 'string', minLength: 1 },
            },
            additionalProperties: true,
          },
          card: { type: 'object' },
          now: { type: 'string' },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    dedup: {
      summary:
        'Check (and register in) the ingest content-hash registry: exact-hash duplicates are reported, same-source different-hash re-ingests surface a supersedes_candidate.',
      examples: [
        {
          content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          source_system: 'confluence',
          source_id: 'PAGE-123',
        },
      ],
      schema: {
        type: 'object',
        required: ['content_sha256'],
        properties: {
          content_sha256: { type: 'string', minLength: 1 },
          source_system: { type: 'string' },
          source_id: { type: 'string' },
          registry_path: { type: 'string', minLength: 1 },
          target_path: { type: 'string' },
          register: { type: 'boolean' },
          now: { type: 'string' },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    // DA-05: the explicit ingest ceremony (Hybrid Sovereign Ledger) — the
    // only ingest op that writes into knowledge/confidential/ (fail-closed
    // path guard + narrowly-scoped ingest_commit authority role).
    commit: {
      summary:
        'Explicit ingest ceremony: land a normalize_card result inside the tenant knowledge root and append the information-asset ledger record (duplicate → no write; same-source re-ingest → supersede version). DA-06: the card is PII/secret-scrubbed before landing (block-action findings refuse the commit unless an audited override lists them); landings in knowledge/confidential/common/ or knowledge/public/ingest/ require steward_approval_id (KM-03 queue).',
      examples: [
        {
          tenant_slug: 'acme-corp',
          normalized: {
            target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
            frontmatter: { title: 'Q1 Report' },
            body_markdown: '# Q1 Report',
            card_markdown: '---\ntitle: Q1 Report\n---\n\n# Q1 Report\n',
          },
          source_meta: {
            source_system: 'confluence',
            source_id: 'PAGE-123',
            content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
          ingested_by: 'ecosystem_architect',
          transform_chain: ['parse_document:docx', 'normalize_card'],
        },
      ],
      schema: {
        type: 'object',
        required: ['tenant_slug', 'normalized'],
        properties: {
          tenant_slug: {
            type: 'string',
            minLength: 1,
            not: { enum: ['public', 'confidential', 'personal', 'shared'] },
          },
          normalized: {
            type: 'object',
            required: ['target_path', 'frontmatter', 'card_markdown'],
            properties: {
              target_path: { type: 'string', minLength: 1 },
              frontmatter: { type: 'object' },
              body_markdown: { type: 'string' },
              card_markdown: { type: 'string', minLength: 1 },
            },
            additionalProperties: true,
          },
          dedup_result: { type: 'object' },
          source_meta: {
            type: 'object',
            properties: {
              source_system: { type: 'string' },
              source_id: { type: 'string' },
              source_url: { type: 'string' },
              source_version: { type: 'string' },
              retrieved_at: { type: 'string' },
              content_sha256: { type: 'string' },
            },
            additionalProperties: true,
          },
          approval_id: { type: 'string' },
          steward_approval_id: { type: 'string' },
          override: {
            type: 'object',
            required: ['rule_ids', 'reason', 'approved_by'],
            properties: {
              rule_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
              reason: { type: 'string', minLength: 1 },
              approved_by: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
          ingested_by: { type: 'string' },
          transform_chain: { type: 'array', items: { type: 'string' } },
          visible_to: { type: 'array', items: { type: 'string' } },
          now: { type: 'string' },
          export_as: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    staleness_report: {
      summary:
        'Deterministic, side-effect-free asset-ledger comparison: list active assets and flag those whose supplied current source (content_sha256/source_version) differs from the ledger.',
      examples: [
        {
          tenant_slug: 'acme-corp',
          current_sources: [
            {
              source_system: 'confluence',
              source_id: 'PAGE-123',
              content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        },
        { tenant_slug: 'acme-corp' },
      ],
      schema: {
        type: 'object',
        required: ['tenant_slug'],
        properties: {
          tenant_slug: {
            type: 'string',
            minLength: 1,
            not: { enum: ['public', 'confidential', 'personal', 'shared'] },
          },
          current_sources: {
            type: 'array',
            items: {
              type: 'object',
              required: ['source_system', 'source_id'],
              properties: {
                source_system: { type: 'string', minLength: 1 },
                source_id: { type: 'string', minLength: 1 },
                source_version: { type: 'string' },
                content_sha256: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          export_as: { type: 'string', minLength: 1 },
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

/**
 * KD-07: resolve the resource claims a specific op invocation makes, from
 * its manifest `accesses` declaration and the actual call params — for the
 * tool-call-scheduler.ts batch scheduler. An op with no declaration, or
 * whose declared path cannot be resolved from `params` (missing/non-string),
 * is conservative: `[{ kind: 'all' }]`, matching today's fully-serial
 * behavior. An explicit empty `accesses: []` declaration resolves to `[]`
 * (touches nothing shared, always safe to parallelize).
 */
export function resolveOpAccessClaims(
  domain: OpInputDomain,
  op: string,
  params: Record<string, unknown> | undefined
): ResourceClaim[] {
  const declarations = INPUT_CONTRACTS[domain]?.[op]?.accesses;
  if (!declarations) return [{ kind: 'all' }];

  const claims: ResourceClaim[] = [];
  for (const declaration of declarations) {
    const path =
      declaration.path ?? (declaration.pathParam ? params?.[declaration.pathParam] : undefined);
    if (typeof path !== 'string' || path.length === 0) return [{ kind: 'all' }];
    const recursive =
      declaration.recursive ??
      (declaration.recursiveParam ? Boolean(params?.[declaration.recursiveParam]) : undefined);
    claims.push({ kind: 'file', operation: declaration.operation, path, recursive });
  }
  return claims;
}
