import { logger } from './core.js';
import { redactSensitiveObject } from './network.js';

/**
 * Kyberion A2UI (Agent-to-User Interface) Protocol v0.2.0
 * Inspired by OpenClaw A2UI.
 */

export type A2UIComponentType = 
  | 'text' 
  | 'button' 
  | 'card' 
  | 'container'
  // Chronos Specific Components
  | 'kb-layout-grid'
  | 'kb-status-orbit'
  | 'kb-mission-card'
  | 'kb-artifact-tile'
  | 'kb-intervention-panel'
  // Presence Specific Components
  | 'presence.status'
  | 'presence.subtitle'
  | 'presence.transcript'
  | 'presence.avatar';

export interface A2UIComponent {
  id: string;
  type: A2UIComponentType;
  props: Record<string, any>;
  children?: string[];
}


export interface A2UIMessage {
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    title?: string;
  };
  updateComponents?: {
    surfaceId: string;
    components: A2UIComponent[];
  };
  updateDataModel?: {
    surfaceId: string;
    data: Record<string, any>;
  };
  deleteSurface?: {
    surfaceId: string;
  };
}

export type A2UITransport = (message: A2UIMessage) => void;

export class A2UISurface {
  private components: Map<string, A2UIComponent> = new Map();
  private data: Record<string, any> = {};

  constructor(
    public readonly surfaceId: string,
    public readonly catalogId: string,
    public title?: string
  ) {}

  public setComponent(component: A2UIComponent): this {
    this.components.set(component.id, component);
    return this;
  }

  public removeComponent(id: string): this {
    this.components.delete(id);
    return this;
  }

  public getComponent(id: string): A2UIComponent | undefined {
    return this.components.get(id);
  }

  public setData(key: string, value: any): this {
    this.data[key] = value;
    return this;
  }

  public getData(): Record<string, any> {
    return { ...this.data };
  }

  public buildCreateMessage(): A2UIMessage {
    return {
      createSurface: {
        surfaceId: this.surfaceId,
        catalogId: this.catalogId,
        title: this.title
      }
    };
  }

  public buildUpdateMessage(): A2UIMessage {
    return {
      updateComponents: {
        surfaceId: this.surfaceId,
        components: Array.from(this.components.values())
      }
    };
  }

  public buildDataMessage(): A2UIMessage {
    return {
      updateDataModel: {
        surfaceId: this.surfaceId,
        data: { ...this.data }
      }
    };
  }

  public buildDeleteMessage(): A2UIMessage {
    return {
      deleteSurface: {
        surfaceId: this.surfaceId
      }
    };
  }
}

/**
 * A2UI Dispatcher with pluggable transports.
 * Register transports (WebSocket, HTTP, etc.) and broadcast messages to all.
 */
class A2UIDispatcher {
  private transports: A2UITransport[] = [];
  private surfaces: Map<string, A2UISurface> = new Map();

  public registerTransport(transport: A2UITransport): void {
    this.transports.push(transport);
  }

  public removeTransport(transport: A2UITransport): void {
    this.transports = this.transports.filter(t => t !== transport);
  }

  public trackSurface(surface: A2UISurface): void {
    this.surfaces.set(surface.surfaceId, surface);
  }

  public getSurface(surfaceId: string): A2UISurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  public dispatch(message: A2UIMessage): void {
    logger.info(`[A2UI_DISPATCH] ${JSON.stringify(message)}`);
    for (const transport of this.transports) {
      try {
        transport(message);
      } catch (err: any) {
        logger.error(`[A2UI_TRANSPORT_ERROR] ${err.message}`);
      }
    }
  }
}

export const a2uiDispatcher = new A2UIDispatcher();

/**
 * Bridge HTTP transport: forwards A2UI messages to the Bridge SSE relay.
 */
function createBridgeTransport(bridgeUrl = process.env.KYBERION_A2UI_BRIDGE_URL || 'http://127.0.0.1:3031,http://127.0.0.1:3040'): A2UITransport {
  const targets = bridgeUrl
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return (message: A2UIMessage) => {
    for (const target of targets) {
      const payload = redactSensitiveObject(message);
      fetch(`${target}/a2ui/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((err) => {
        logger.warn(`[A2UI_BRIDGE] Failed to relay to bridge ${target}: ${err.message}`);
      });
    }
  };
}

// Auto-register bridge transport when running server-side
if (typeof globalThis.fetch === 'function') {
  a2uiDispatcher.registerTransport(createBridgeTransport());
}

/**
 * Dispatch an A2UI message via all registered transports.
 */
export function dispatchA2UI(message: A2UIMessage): void {
  a2uiDispatcher.dispatch(message);
}
