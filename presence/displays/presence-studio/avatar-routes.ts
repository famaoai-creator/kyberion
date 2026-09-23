// PA-10: the user's own generated avatar set (personal tier), split into its
// own module like training-routes.ts and registered from `server.ts` with one
// line behind the same `/api` guard + rate limiter as every other API route.
//
// The frames live under `<profileRoot>/avatar/` and are never exposed through
// `express.static`: these read-only routes resolve the viewer server-side,
// require personal-tier access (the loopback localadmin session — token
// viewers never reach the personal tier, and `/api/me/avatar*` is not on the
// remote-safe allowlist), allow only the fixed expression names, and send
// `Cache-Control: no-store` with the sniffed image content type.
import type express from 'express';
import { withExecutionContext } from '@agent/core/authority';
import { withSensitivePathMediation } from '@agent/core/secure-io';
import {
  describePersonalAvatar,
  isAvatarExpression,
  readPersonalAvatarAsset,
} from '@agent/core/presence-avatar';
import {
  PresenceStudioViewerError,
  presenceStudioHeadlessScope,
  resolvePresenceStudioViewerContext,
} from './security.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

export const PRESENCE_STUDIO_AVATAR_URL_BASE = '/api/me/avatar';

function requirePersonalTier(req: express.Request): void {
  const viewer = resolvePresenceStudioViewerContext(req);
  if (!presenceStudioHeadlessScope(viewer).tier_access.includes('personal')) {
    throw new PresenceStudioViewerError(403, 'The personal avatar requires a local owner session.');
  }
}

function readPersonal<T>(fn: () => T): T {
  return withExecutionContext('ecosystem_architect', () => withSensitivePathMediation(fn));
}

function fail(res: express.Response, error: unknown): void {
  const status = error instanceof PresenceStudioViewerError ? error.status : 500;
  res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
}

export function registerAvatarRoutes(app: express.Express): void {
  // `ui:talking-avatar`-shaped description: frame URLs + mouth anchor.
  app.get(PRESENCE_STUDIO_AVATAR_URL_BASE, (req, res) => {
    try {
      requirePersonalTier(req);
      const avatar = readPersonal(() => describePersonalAvatar(PRESENCE_STUDIO_AVATAR_URL_BASE));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, avatar });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${PRESENCE_STUDIO_AVATAR_URL_BASE}/:expression`, (req, res) => {
    try {
      requirePersonalTier(req);
      const expression = String(req.params.expression ?? '');
      if (!isAvatarExpression(expression)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ ok: false, error: 'Unknown avatar expression.' });
      }
      const asset = readPersonal(() => readPersonalAvatarAsset(expression));
      res.setHeader('Cache-Control', 'no-store');
      if (!asset) return res.status(404).json({ ok: false, error: 'Avatar frame not found.' });
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(asset.bytes);
    } catch (error) {
      return fail(res, error);
    }
  });
}
