import express from 'express';
import { createServer } from 'node:http';
import {
  completeOAuthCallback,
  logger,
  pathResolver,
  safeMkdir,
  safeWriteFile,
  safeExistsSync,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import * as path from 'node:path';

const app = express();
const server = createServer(app);

const HOST = process.env.KYBERION_OAUTH_CALLBACK_HOST || '127.0.0.1';
const PORT = Number(process.env.KYBERION_OAUTH_CALLBACK_PORT || 8787);
const CALLBACK_PATH = process.env.KYBERION_OAUTH_CALLBACK_PATH || '/oauth/callback';
const RUNTIME_DIR = pathResolver.shared('runtime/oauth');
const LATEST_RESULT_PATH = path.join(RUNTIME_DIR, 'latest-callback.json');

function ensureRuntimeDir() {
  if (!safeExistsSync(RUNTIME_DIR)) {
    safeMkdir(RUNTIME_DIR, { recursive: true });
  }
}

function renderHtml(title: string, body: string, tone: 'success' | 'error' = 'success') {
  const accent = tone === 'success' ? '#18603b' : '#8a1c1c';
  const border = tone === 'success' ? '#7fc59b' : '#e3a4a4';
  const background = tone === 'success' ? '#f3fbf5' : '#fff7f7';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; background: linear-gradient(160deg, #f8f2e8 0%, #f2f7fb 100%); color: #1f2933; padding: 48px 20px; }
    .card { max-width: 640px; margin: 0 auto; background: ${background}; border: 1px solid ${border}; border-radius: 18px; padding: 28px; box-shadow: 0 18px 48px rgba(31,41,51,.08); }
    h1 { margin: 0 0 12px; font-size: 28px; color: ${accent}; }
    p { line-height: 1.55; margin: 10px 0 0; }
    code { background: rgba(31,41,51,.08); padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'oauth-callback-surface', callback_path: CALLBACK_PATH });
});

app.get(CALLBACK_PATH, async (req, res) => {
  try {
    const serviceId = typeof req.query.service === 'string' ? req.query.service : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    const errorDescription = typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

    const result = await completeOAuthCallback({ serviceId, code, state, error, errorDescription });
    ensureRuntimeDir();
    safeWriteFile(LATEST_RESULT_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      callback_path: CALLBACK_PATH,
      ...result,
    }, null, 2) + '\n');

    if (!result.ok) {
      logger.warn(`[oauth-callback-surface] OAuth callback returned provider error for ${result.serviceId || 'unknown'}: ${result.error}`);
      return res.status(400).send(renderHtml(
        'Authorization Failed',
        `The provider returned <code>${result.error}</code>${result.errorDescription ? `: ${result.errorDescription}` : ''}. You can close this window and retry from Kyberion.`,
        'error',
      ));
    }

    logger.info(`[oauth-callback-surface] OAuth callback completed for ${result.serviceId}`);
    return res.send(renderHtml(
      'Authorization Complete',
      `The ${result.serviceId} connection is now stored in the Personal tier. You can close this window and return to Kyberion.`,
      'success',
    ));
  } catch (error: any) {
    logger.error(`[oauth-callback-surface] ${error.message}`);
    ensureRuntimeDir();
    safeWriteFile(LATEST_RESULT_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      callback_path: CALLBACK_PATH,
      ok: false,
      error: error.message,
    }, null, 2) + '\n');
    return res.status(500).send(renderHtml(
      'Callback Error',
      `Kyberion could not complete the OAuth callback: <code>${error.message}</code>.`,
      'error',
    ));
  }
});

withExecutionContext('surface_runtime', () => {
  server.listen(PORT, HOST, () => {
    logger.info(`[oauth-callback-surface] listening on http://${HOST}:${PORT}${CALLBACK_PATH}`);
  });
});
