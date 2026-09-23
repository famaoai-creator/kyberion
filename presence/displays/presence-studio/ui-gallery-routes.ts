// UI-04 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §5): the kyberion-base
// component gallery and the shared vanilla renderer it runs on.
//
//   GET /ui-gallery               -> static/ui-gallery.html
//   GET /shared-ui/kyberion-ui.js -> libs/shared-ui/vanilla/kyberion-ui.js
//
// Both are fixed files (no path parameter reaches the filesystem), served
// like the other static front-desk pages: no API data, no auth, bound to the
// surface's loopback HOST. The renderer is a single explicit route rather
// than a directory mount so nothing else under libs/ becomes reachable.
import * as path from 'node:path';
import type express from 'express';
import { pathResolver } from '@agent/core';

export const UI_GALLERY_ROUTE = '/ui-gallery';
export const SHARED_UI_VANILLA_ROUTE = '/shared-ui/kyberion-ui.js';
export const SHARED_UI_VANILLA_SOURCE = 'libs/shared-ui/vanilla/kyberion-ui.js';

export function registerUiGalleryRoutes(app: express.Express, staticDir: string): void {
  app.get(UI_GALLERY_ROUTE, (_req, res) => {
    res.sendFile(path.join(staticDir, 'ui-gallery.html'));
  });
  app.get(SHARED_UI_VANILLA_ROUTE, (_req, res) => {
    res.type('text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
  });
}
