import type express from 'express';
import {
  getOperatorEngineRuntimePreferences,
  updateOperatorEngineRuntimePreferences,
  EngineRuntimeOperatorError,
  type EngineRuntimeOperatorUpdate,
} from '@agent/core/voice/engine-runtime-preferences-operator';
import { PresenceStudioViewerError } from './security.js';
import { requireLocalOperatorRequest } from './local-operator-request.js';

const PATH = '/api/voice/engine-config';
/** Private profile contents never enter cached responses or raw exception messages. */
export function registerEngineConfigRoute(app: express.Express): void {
  for (const method of ['get', 'post'] as const)
    app[method](PATH, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const principal = requireLocalOperatorRequest(req, method === 'post');
        if (method === 'get')
          return res.json({ ok: true, ...getOperatorEngineRuntimePreferences(principal) });
        const body: unknown = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return res.status(400).json({ ok: false, error: 'invalid_patch' });
        return res.json({
          ok: true,
          ...updateOperatorEngineRuntimePreferences(principal, body as EngineRuntimeOperatorUpdate),
        });
      } catch (error) {
        if (error instanceof PresenceStudioViewerError)
          return res.status(error.status).json({
            ok: false,
            error:
              error.status === 401
                ? 'engine_config_authentication_required'
                : 'engine_config_local_session_required',
          });
        if (error instanceof EngineRuntimeOperatorError)
          return res
            .status(error.code === 'engine_config_conflict' ? 409 : 400)
            .json({ ok: false, error: error.code });
        return res.status(500).json({ ok: false, error: 'engine_config_unavailable' });
      }
    });
  // Global JSON parsing runs before routes; close its failures here as well.
  const parserFailure: express.ErrorRequestHandler = (error: unknown, req, res, _next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      requireLocalOperatorRequest(
        req,
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      );
    } catch (authorizationError) {
      const status =
        authorizationError instanceof PresenceStudioViewerError ? authorizationError.status : 500;
      return res.status(status).json({
        ok: false,
        error:
          status === 401
            ? 'engine_config_authentication_required'
            : status === 403
              ? 'engine_config_local_session_required'
              : 'engine_config_unavailable',
      });
    }
    const failure =
      error && typeof error === 'object' ? (error as { type?: unknown; status?: unknown }) : {};
    if (failure.type === 'entity.parse.failed' && failure.status === 400)
      return res.status(400).json({ ok: false, error: 'invalid_patch' });
    if (failure.type === 'entity.too.large' && failure.status === 413)
      return res.status(413).json({ ok: false, error: 'request_too_large' });
    return res.status(500).json({ ok: false, error: 'engine_config_unavailable' });
  };
  app.use(PATH, parserFailure);
}
