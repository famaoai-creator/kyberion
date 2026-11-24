/**
 * `pnpm kyberion read <file|url> [--ocr] [--json] [--out <file>]`
 *
 * The one-line way for any agent (Claude, Codex, Gemini, …) to read a
 * pdf / pptx / docx / xlsx / html / markdown / text / csv / tsv / json / yaml
 * file through the actuator stack instead of writing its own unzip /
 * pdftotext / python script. Delegates to the shared document reader
 * (@agent/core/document-reader) — the same path media:document_digest and the
 * ingest ceremony use — and prints Markdown (or JSON) to stdout.
 *
 * Inputs must live inside the repository (the sandbox boundary is not
 * widened): a file elsewhere is refused with the copy-in instruction.
 * http(s) URLs are fetched with GET through the same governed boundary as
 * `network:fetch` (egress policy + audit chain, no approval for reads) and
 * read from memory — no temp file is written.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  inferDocumentFormat,
  READABLE_DOCUMENT_EXTENSIONS,
  readDocument,
  type ReadableDocumentFormat,
  type ReadDocumentResult,
} from '@agent/core/media/document-reader';
import { safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import { assertNetworkEgress, secureFetch, SecureFetchError } from '@agent/core/network';
import {
  ExternalOperationApprovalRequired,
  runExternalOperation,
  withOperationArgumentOrigins,
} from '@agent/core/governance/external-operation';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-presentation';
import { ScriptExitError, type ScriptErrorDetails } from '../lib/harness.js';

export const READ_USAGE = `Usage: pnpm kyberion read <file|url> [--ocr] [--tier <tier>] [--training-use <policy>] [--tenant <slug>] [--json] [--out <file>] [--images <dir>]

Reads a ${Object.keys(READABLE_DOCUMENT_EXTENSIONS).join(' / ')} file or an http(s) URL with the native engines and prints Markdown.
HTML → Markdown (<title> as heading; scripts/styles dropped). Markdown / text / yaml as-is.
JSON is pretty-printed when valid. Small csv/tsv become Markdown tables (large ones stay as-is).
  --ocr         Also OCR embedded images (slides/pages/pictures; pdf/pptx/docx); local_only is the default
  --tier <tier> Classify OCR input as public, confidential, or personal (PII may remain in that tier)
  --tenant <slug> Tenant owning classified input; required for approved external egress
  --training-use <policy> local_only (default), zero_retention, or training_eligible
  --json        Print {format, title, tables, warnings, markdown} as JSON
  --out <file>  Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose     Keep runtime logs (they go to stdout; off by default so stdout is the document)
  --images <dir>  Also write every embedded image (slide/page/picture; EMF/WMF as PNG) into <dir>

The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
http(s) URLs are fetched with GET through the egress-governed network:fetch_read path
(egress policy deny/warn/allow + audit chain, like network:fetch GET). Format is taken
from the URL extension when present, else from the content (PDF/OOXML magic, '<' → html).`;

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

interface ReadArgs {
  file?: string;
  ocr: boolean;
  json: boolean;
  out?: string;
  images?: string;
  tier?: 'public' | 'confidential' | 'personal';
  tenant?: string;
  trainingUse?: 'local_only' | 'zero_retention' | 'training_eligible';
  help: boolean;
}

// §3.2 error contract: every refusal the operator can hit is classified so
// the JSON error envelope carries code/category/next_action.
const INVALID_USAGE_DETAILS: ScriptErrorDetails = {
  code: 'INVALID_USAGE',
  category: 'invalid_input',
  retryable: false,
};
const INVALID_INPUT_DETAILS: ScriptErrorDetails = {
  code: 'INVALID_INPUT',
  category: 'invalid_input',
  retryable: false,
};
const OUTSIDE_SCOPE_DETAILS: ScriptErrorDetails = {
  code: 'OUTSIDE_ALLOWED_SCOPE',
  category: 'permission_denied',
  retryable: false,
};
const NOT_FOUND_DETAILS: ScriptErrorDetails = {
  code: 'NOT_FOUND',
  category: 'not_found',
  retryable: false,
};
const FETCH_FAILED_DETAILS: ScriptErrorDetails = {
  code: 'FETCH_FAILED',
  category: 'network',
  retryable: true,
};

function parseReadArgs(argv: string[]): ReadArgs {
  const args: ReadArgs = { ocr: false, json: false, help: false };
  const invalid = (message: string): ScriptExitError =>
    new ScriptExitError(1, message, false, undefined, INVALID_USAGE_DETAILS);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--ocr') args.ocr = true;
    else if (value === '--json') args.json = true;
    else if (value === '--verbose')
      continue; // handled by the CLI dispatcher (keeps runtime logs)
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--out') {
      args.out = argv[index + 1];
      index += 1;
      if (!args.out) throw invalid('--out requires a file path');
    } else if (value === '--images') {
      args.images = argv[index + 1];
      index += 1;
      if (!args.images) throw invalid('--images requires a directory');
    } else if (value === '--tier') {
      const tier = argv[index + 1];
      index += 1;
      if (tier !== 'public' && tier !== 'confidential' && tier !== 'personal') {
        throw invalid('--tier must be public, confidential, or personal');
      }
      args.tier = tier;
    } else if (value === '--tenant') {
      args.tenant = argv[index + 1];
      index += 1;
      if (!args.tenant) throw invalid('--tenant requires a slug');
    } else if (value === '--training-use') {
      const policy = argv[index + 1];
      index += 1;
      if (
        policy !== 'local_only' &&
        policy !== 'zero_retention' &&
        policy !== 'training_eligible'
      ) {
        throw invalid('--training-use must be local_only, zero_retention, or training_eligible');
      }
      args.trainingUse = policy;
    } else if (value.startsWith('--')) throw invalid(`Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw invalid(`Unexpected argument: ${value}`);
  }
  return args;
}

function isInsideRepository(absolute: string): boolean {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function renderReadResult(result: ReadDocumentResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  if (result.warnings.length === 0) return result.markdown;
  return [result.markdown, '', ...result.warnings.map((warning) => `> [read] ${warning}`)].join(
    '\n'
  );
}

/** Injectable fetch boundary so URL reads stay hermetic in tests. */
export interface ReadCommandDeps {
  fetchUrl?: (url: string) => Promise<Buffer>;
}

/** Fetch a remote page through the same governed boundary as `network:fetch` GET. */
async function fetchUrlBytes(url: string): Promise<Buffer> {
  const request = {
    url,
    method: 'GET',
    responseType: 'arraybuffer' as const,
    timeout: 20000,
    // secureFetch validates only the entry URL — each redirect hop goes back
    // through the same egress gate, or a 3xx to a denied/private host would
    // bypass it. options.href holds the resolved target at this point.
    beforeRedirect: (options: Record<string, unknown>) => {
      assertNetworkEgress(typeof options.href === 'string' ? options.href : '');
    },
  };
  // The URL came from the operator's own argv — attest it as user-origin
  // evidence so the protected `params.url` argument keeps honest lineage.
  const body = await withOperationArgumentOrigins(
    [
      {
        path: ['params', 'url'],
        value_hash: computeApprovalPayloadHash({ value: url }),
        authority: 'user',
      },
    ],
    () =>
      runExternalOperation(
        {
          operationId: 'network:fetch_read',
          effect: { params: { url, method: 'GET' } },
          requiresApproval: false,
          delegable: false,
          observationOnly: true,
        },
        () => secureFetch<ArrayBuffer>(request),
        () => 'succeeded'
      )
  );
  return Buffer.from(body);
}

/** Classify fetch-path failures into the §3.2 error contract. */
function toUrlReadError(error: unknown, url: string): ScriptExitError {
  if (error instanceof ScriptExitError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SecureFetchError) {
    if (error.httpStatus === 404) {
      return new ScriptExitError(1, `[read] ${url} returned HTTP 404`, false, undefined, {
        ...NOT_FOUND_DETAILS,
      });
    }
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return new ScriptExitError(
        1,
        `[read] ${url} was denied by the remote server (HTTP ${error.httpStatus})`,
        false,
        undefined,
        { ...OUTSIDE_SCOPE_DETAILS }
      );
    }
    return new ScriptExitError(1, `[read] fetch failed: ${message}`, false, undefined, {
      ...FETCH_FAILED_DETAILS,
      // Timeouts and 5xx are worth a retry; a 4xx other than the ones above is not.
      retryable: error.httpStatus === undefined || error.httpStatus >= 500,
    });
  }
  if (/Unsupported protocol|Invalid URL/.test(message)) {
    return new ScriptExitError(1, `[read] ${url}: ${message}`, false, undefined, {
      ...INVALID_INPUT_DETAILS,
      next_action: 'pass an http:// or https:// URL',
    });
  }
  // Governance denials (egress policy, sandbox, policy gate, approval stops)
  // throw bracketed ALL_CAPS tags like [NETWORK_POLICY_VIOLATION]; class them
  // as permission_denied, never as a retryable network failure.
  if (
    error instanceof ExternalOperationApprovalRequired ||
    /\[[A-Z][A-Z0-9_]{3,}\]|Blocked URL|sandbox|policy|egress|rate.?limit|scope.?mismatch/i.test(
      message
    )
  ) {
    return new ScriptExitError(1, `[read] ${url}: ${message}`, false, undefined, {
      ...OUTSIDE_SCOPE_DETAILS,
      next_action: 'check the egress policy / sandbox network allowance for this host',
    });
  }
  return new ScriptExitError(1, `[read] fetch failed: ${message}`, false, undefined, {
    ...FETCH_FAILED_DETAILS,
  });
}

/** Extension first (it also names OOXML), content sniffing as fallback. */
function inferUrlDocumentFormat(url: string, body: Buffer): ReadableDocumentFormat {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    throw new ScriptExitError(1, `[read] ${url}: Invalid URL`, false, undefined, {
      ...INVALID_INPUT_DETAILS,
      next_action: 'pass an http:// or https:// URL',
    });
  }
  const byExtension = READABLE_DOCUMENT_EXTENSIONS[path.extname(pathname)];
  if (byExtension) return byExtension;
  if (body.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  if (
    body.length >= 4 &&
    body[0] === 0x50 &&
    body[1] === 0x4b &&
    body[2] === 0x03 &&
    body[3] === 0x04
  ) {
    throw new ScriptExitError(
      1,
      `[read] ${url} looks like an Office document (zip) but the URL has no extension ` +
        'to name it (.docx/.pptx/.xlsx). Save it under active/shared/tmp/<job>/ with the right ' +
        'extension and read that file.',
      false,
      undefined,
      {
        ...INVALID_INPUT_DETAILS,
        code: 'UNSUPPORTED_TYPE',
        next_action:
          'save the response under active/shared/tmp/<job>/ with a .docx/.pptx/.xlsx extension, then read that file',
      }
    );
  }
  const head = body.subarray(0, 1024).toString('utf8').trimStart();
  if (head.startsWith('<')) return 'html';
  return 'text';
}

export async function runReadCommand(
  argv: string[],
  print: (text: string) => void,
  deps: ReadCommandDeps = {}
): Promise<ReadDocumentResult | undefined> {
  const args = parseReadArgs(argv);
  if (args.help || !args.file) {
    if (!args.file && !args.help) throw new ScriptExitError(1, READ_USAGE);
    print(READ_USAGE);
    return undefined;
  }
  // Output flags are validated before any egress so a refused flag never
  // performs a real fetch.
  if (args.images && !isInsideRepository(pathResolver.rootResolve(args.images))) {
    throw new ScriptExitError(
      1,
      `[read] --images ${args.images} must be a directory inside the repository`,
      false,
      undefined,
      OUTSIDE_SCOPE_DETAILS
    );
  }
  if (args.out && !isInsideRepository(pathResolver.rootResolve(args.out))) {
    throw new ScriptExitError(
      1,
      `[read] --out ${args.out} must be a file inside the repository`,
      false,
      undefined,
      OUTSIDE_SCOPE_DETAILS
    );
  }
  let remote: { buffer: Buffer; format: ReadableDocumentFormat } | undefined;
  if (URL_PATTERN.test(args.file)) {
    let body: Buffer;
    try {
      body = await (deps.fetchUrl ?? fetchUrlBytes)(args.file);
    } catch (error) {
      throw toUrlReadError(error, args.file);
    }
    remote = { buffer: body, format: inferUrlDocumentFormat(args.file, body) };
  }
  let format: ReadableDocumentFormat | undefined;
  if (remote) {
    format = remote.format;
  } else {
    const absolute = pathResolver.rootResolve(args.file);
    if (!isInsideRepository(absolute)) {
      // The scope guard runs on path arithmetic alone: an outside path is never
      // stat'ed, so `read` cannot serve as an existence oracle and the refusal
      // is identical whether the file exists or not.
      throw new ScriptExitError(
        1,
        `[read] ${args.file} is outside the repository. Copy it in first:\n` +
          `  mkdir -p active/shared/tmp/<job> && cp "${args.file}" active/shared/tmp/<job>/`,
        false,
        undefined,
        {
          ...OUTSIDE_SCOPE_DETAILS,
          next_action:
            'copy the file into active/shared/tmp/<job>/ inside the repository, then read it',
        }
      );
    }
    // Only an authorized in-repository path is probed: a missing leaf inside the
    // allowed scope is NOT_FOUND, which outside paths never reach.
    if (!safeExistsSync(absolute)) {
      throw new ScriptExitError(
        1,
        `[read] ${args.file} does not exist inside the repository — check the path, then retry.`,
        false,
        undefined,
        NOT_FOUND_DETAILS
      );
    }
    format = inferDocumentFormat(absolute);
  }
  if (!format) {
    throw new ScriptExitError(
      1,
      `[read] unsupported file type "${path.extname(args.file) || '(none)'}". ` +
        `Readable: ${Object.keys(READABLE_DOCUMENT_EXTENSIONS).join(', ')}. ` +
        'Source code and other text can be opened with the editor; binary formats need a dedicated verb (see / listen / watch).',
      false,
      undefined,
      {
        ...INVALID_INPUT_DETAILS,
        code: 'UNSUPPORTED_TYPE',
      }
    );
  }
  const result = await readDocument(
    remote ? remote.buffer : pathResolver.rootResolve(args.file),
    format,
    {
      ocr: args.ocr,
      ...(args.tier ? { tier: args.tier } : {}),
      ...(args.tenant ? { tenantSlug: args.tenant } : {}),
      ...(args.trainingUse ? { trainingUse: args.trainingUse } : {}),
      ...(args.images ? { imagesDir: args.images } : {}),
    }
  );
  const rendered = renderReadResult(result, args.json);
  const notices: string[] = [];
  if (args.images) {
    notices.push(`[read] ${result.images.length} image(s) written to ${args.images}`);
    for (const image of result.images) {
      notices.push(
        `[read]   ${image.location}: ${path.relative(pathResolver.rootDir(), image.path)}`
      );
    }
  }
  if (args.out) {
    safeWriteFile(pathResolver.rootResolve(args.out), `${rendered}\n`);
    notices.push(`[read] wrote ${args.out} (${result.format}, ${result.markdown.length} chars)`);
  }
  if (args.json) {
    // JSON mode carries exactly one document on stdout: status notices move
    // inside the payload instead of polluting the machine-readable stream.
    print(
      JSON.stringify(
        {
          ...result,
          ...(notices.length > 0 ? { notices } : {}),
          ...(args.out ? { written_to: args.out } : {}),
        },
        null,
        2
      )
    );
  } else {
    for (const notice of notices) print(notice);
    if (!args.out) print(rendered);
  }
  return result;
}
