/**
 * Customer-room routes — exactly these, everything else is a plain 404:
 *
 *   GET  /health        liveness
 *   GET  /r             the page (the invite token is in the URL fragment, never sent here)
 *   GET  /assets/<f>    the page's stylesheets
 *   GET  /js/app/*.js   the page's compiled modules
 *   POST /api/view      Authorization: Bearer <token>            -> facade `view`
 *   POST /api/respond   Authorization: Bearer <token>, {content_hash, answers, general_question?} -> facade `respond`
 *   POST /api/attachment Authorization: Bearer <token>, {attachment_id}       -> facade `attachment`
 *                        (the image bytes; png / jpeg / webp only, nosniff, no-store)
 *
 * One process serves one tenant, fixed at start; nothing in a request can
 * change it. The token is read from the Authorization header only, handed to
 * the facade on STDIN, and never logged or echoed.
 */
import type express from 'express';
import expressModule from 'express';
import { rateLimit } from 'express-rate-limit';
import * as path from 'node:path';
import type { FacadeSpawner, FacadeVerb } from './facade.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: carries the agenda images the page fetched with the token header.
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const TOKEN_PATTERN = /^inv-[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/u;
export const MAX_BODY_BYTES = 64 * 1024;
export const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{64}$/u;
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
/** The only image types the room serves, and the leading bytes each must start with. */
const ATTACHMENT_TYPES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) =>
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) =>
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const MAX_ATTACHMENT_BASE64 = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/**
 * The image in a facade `attachment` answer, or null when it is not one the
 * room may serve (type outside the allowlist, not base64, empty, too large,
 * or bytes that do not start like the declared type).
 */
export function decodeAttachment(
  body: Record<string, unknown>
): { mediaType: string; bytes: Buffer } | null {
  const mediaType = body.media_type;
  const encoded = body.bytes_base64;
  if (typeof mediaType !== 'string' || !Object.hasOwn(ATTACHMENT_TYPES, mediaType)) return null;
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  if (encoded.length > MAX_ATTACHMENT_BASE64 || encoded.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  return ATTACHMENT_TYPES[mediaType](bytes) ? { mediaType, bytes } : null;
}

export const ASSET_FILES: readonly string[] = [
  'app.css',
  'kyberion-ui.css',
  'kyberion-ui-tokens.css',
];

/** Customer-safe failure reasons the facade may return, and their HTTP status. */
const REASON_STATUS: Record<string, number> = {
  invalid_request: 400,
  invalid_link: 404,
  expired: 410,
  revoked: 410,
  closed: 410,
  updating: 409,
  stale_version: 409,
  invalid_answers: 422,
  not_entitled: 403,
  unavailable: 503,
};

export interface CustomerRoomRouteOptions {
  spawner: FacadeSpawner;
  staticDir: string;
  /** Directory holding the compiled browser modules (served under `/js/app`). */
  jsDir: string;
  /** The page, already filled with its language data. */
  renderPage: (acceptLanguage: string | undefined) => string;
  log?: (message: string) => void;
  apiLimitPerMinute?: number;
  pageLimitPerMinute?: number;
}

interface Failure {
  ok: false;
  reason: string;
  errors?: Array<{ entry_id: string; error: string }>;
}

function failure(reason: string): Failure {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function securityHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

function bearerToken(req: express.Request): string | null {
  const header = req.header('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/u.exec(header);
  return match && TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

const DIAGNOSTIC_CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/u;

/**
 * Map one facade answer to `{status, body}`. Unknown or malformed output is
 * `unavailable`. `diagnostic` is the facade's reason code for an unexpected
 * failure: logged by the room, never part of the body the customer gets.
 */
export function interpretFacadeOutput(stdout: string): {
  status: number;
  body: Record<string, unknown>;
  diagnostic?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: 503, body: failure('unavailable') as unknown as Record<string, unknown> };
  }
  if (!isRecord(parsed)) {
    return { status: 503, body: failure('unavailable') as unknown as Record<string, unknown> };
  }
  if (parsed.ok === true) return { status: 200, body: parsed };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unavailable';
  const diagnostic =
    typeof parsed.diagnostic_code === 'string' &&
    DIAGNOSTIC_CODE_PATTERN.test(parsed.diagnostic_code)
      ? parsed.diagnostic_code
      : undefined;
  const status = REASON_STATUS[reason];
  if (status === undefined) {
    return {
      status: 503,
      body: failure('unavailable') as unknown as Record<string, unknown>,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  const body: Failure = failure(reason);
  if (reason === 'invalid_answers' && Array.isArray(parsed.errors)) {
    body.errors = parsed.errors
      .filter(isRecord)
      .filter((item) => typeof item.entry_id === 'string' && typeof item.error === 'string')
      .slice(0, 100)
      .map((item) => ({ entry_id: String(item.entry_id), error: String(item.error) }));
  }
  return {
    status,
    body: body as unknown as Record<string, unknown>,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Why a facade run produced no usable answer (for the room's log; no request data). */
function outcomeDiagnostic(outcome: { status: number | null; aborted: boolean } | null): string {
  if (!outcome) return 'spawn_failed';
  if (outcome.aborted) return 'child_aborted';
  return outcome.status === null ? 'child_not_run' : `child_exit_${outcome.status}_no_output`;
}

function limiter(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The client address is taken from the socket; forwarded headers are not trusted here.
    validate: { xForwardedForHeader: false, trustProxy: false },
    handler: (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '60');
      res.status(429).json(failure('unavailable'));
    },
  });
}

export function registerCustomerRoomRoutes(
  app: express.Express,
  options: CustomerRoomRouteOptions
): void {
  const log = options.log ?? (() => {});
  const apiLimiter = limiter(options.apiLimitPerMinute ?? 60);
  const pageLimiter = limiter(options.pageLimitPerMinute ?? 120);

  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, surface: 'customer-room' });
  });

  app.get('/r', pageLimiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(options.renderPage(req.header('accept-language')));
  });

  app.get('/assets/:file', pageLimiter, (req, res, next) => {
    const file = String(req.params.file);
    if (!ASSET_FILES.includes(file)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(options.staticDir, file));
  });
  const moduleFile = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (/\.js$/u.test(req.path) && !/\.test\.js$/u.test(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ ok: false, reason: 'not_found' });
  };
  app.use(
    '/js/app',
    pageLimiter,
    moduleFile,
    expressModule.static(options.jsDir, {
      index: false,
      fallthrough: true,
      dotfiles: 'ignore',
      etag: false,
    })
  );

  const handleApi =
    (verb: FacadeVerb) =>
    async (req: express.Request, res: express.Response): Promise<void> => {
      res.setHeader('Cache-Control', 'no-store');
      const token = bearerToken(req);
      if (!token) {
        res.status(404).json(failure('invalid_link'));
        return;
      }
      const body: unknown = req.body;
      if (!isRecord(body)) {
        res.status(400).json(failure('invalid_request'));
        return;
      }
      let input: Record<string, unknown>;
      if (verb === 'view') {
        input = { token };
      } else if (verb === 'attachment') {
        // Only the id is forwarded, and only in the shape of a stored image's content hash.
        if (
          typeof body.attachment_id !== 'string' ||
          !ATTACHMENT_ID_PATTERN.test(body.attachment_id)
        ) {
          res.status(400).json(failure('invalid_request'));
          return;
        }
        input = { token, attachment_id: body.attachment_id };
      } else {
        // Only these fields are forwarded; a `tenant` (or anything else) in the body is dropped.
        // `general_question` goes through untouched: the facade owns its validation.
        if (typeof body.content_hash !== 'string' || !Array.isArray(body.answers)) {
          res.status(400).json(failure('invalid_request'));
          return;
        }
        input = { token, content_hash: body.content_hash, answers: body.answers };
        if (body.general_question !== undefined) input.general_question = body.general_question;
      }
      const outcome = await options.spawner(verb, input).catch(() => null);
      let result: { status: number; body: Record<string, unknown>; diagnostic?: string } =
        outcome && !outcome.aborted && outcome.stdout.trim()
          ? interpretFacadeOutput(outcome.stdout)
          : {
              status: 503,
              body: failure('unavailable') as unknown as Record<string, unknown>,
              diagnostic: outcomeDiagnostic(outcome),
            };
      if (verb === 'attachment' && result.body.ok === true) {
        const image = decodeAttachment(result.body);
        if (image) {
          log(`[customer-room] ${verb} -> 200`);
          res.setHeader('Content-Type', image.mediaType);
          res.setHeader('Content-Length', String(image.bytes.length));
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.status(200).end(image.bytes);
          return;
        }
        result = {
          status: 503,
          body: failure('unavailable') as unknown as Record<string, unknown>,
          diagnostic: 'attachment_not_servable',
        };
      }
      log(
        `[customer-room] ${verb} -> ${result.status}${result.body.ok === true ? '' : ` ${String(result.body.reason)}`}${result.diagnostic ? ` (diagnostic: ${result.diagnostic})` : ''}`
      );
      res.status(result.status).json(result.body);
    };

  // An empty body is fine for `view`; the parser must still be tolerant of any content type.
  const jsonBody = expressModule.json({ limit: MAX_BODY_BYTES, type: () => true });
  app.post('/api/view', apiLimiter, jsonBody, (req, res, next) => {
    if (req.body === undefined || req.body === null || Object.keys(req.body).length === 0) {
      req.body = {};
    }
    void handleApi('view')(req, res).catch(next);
  });
  app.post('/api/respond', apiLimiter, jsonBody, (req, res, next) => {
    void handleApi('respond')(req, res).catch(next);
  });
  app.post('/api/attachment', apiLimiter, jsonBody, (req, res, next) => {
    void handleApi('attachment')(req, res).catch(next);
  });

  // Body-parser failures (too large, malformed) and anything unexpected: a plain reason code.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ): void => {
      res.setHeader('Cache-Control', 'no-store');
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : 500;
      if (status === 413) {
        res.status(413).json(failure('invalid_request'));
      } else if (status >= 400 && status < 500) {
        res.status(400).json(failure('invalid_request'));
      } else {
        res.status(503).json(failure('unavailable'));
      }
    }
  );
  app.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ ok: false, reason: 'not_found' });
  });
}
