import type { Express, Request } from 'express';
import type { ServiceBindingRecord } from '@agent/core/service/service-binding-registry';
import { isBindingVisibleTo } from '@agent/core/service/service-binding-owner';
import type { PresenceStudioViewerContext } from './security.js';

export function registerServiceBindingsRoute(input: {
  app: Express;
  listBindings: () => ServiceBindingRecord[];
  resolveViewer: (request: Request) => PresenceStudioViewerContext;
  wireError: (error: unknown, status: number) => unknown;
}): void {
  input.app.get('/api/service-bindings', (request, response) => {
    try {
      const viewer = input.resolveViewer(request);
      response.json({
        ok: true,
        items: input.listBindings().filter((record) =>
          isBindingVisibleTo(record, {
            memberId: viewer.principal?.memberId,
            tenantSlugs: viewer.tenantSlugs,
          })
        ),
      });
    } catch (error) {
      const status = (error as { status?: number } | null)?.status ?? 401;
      response.status(status).json(input.wireError(error, status));
    }
  });
}
