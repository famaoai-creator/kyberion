import { readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';

/** Server-only loopback URL for the managed presence-studio surface. */
export function presenceStudioUrl(): string {
  return `http://127.0.0.1:${readFrontDeskSurfacePorts()['presence-studio']}`;
}
