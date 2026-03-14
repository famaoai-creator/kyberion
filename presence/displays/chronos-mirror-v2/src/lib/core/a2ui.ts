import { logger } from './core';

/**
 * Kyberion A2UI (Agent-to-User Interface) Protocol v0.1.0
 * Inspired by OpenClaw A2UI.
 */

export interface A2UIComponent {
  id: string;
  type: string;
  props?: Record<string, any>;
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

  public setData(key: string, value: any): this {
    this.data[key] = value;
    return this;
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
 * Helper to dispatch A2UI messages via current transport (e.g. CLI, WebSocket)
 */
export function dispatchA2UI(message: A2UIMessage) {
  // In a real implementation, this would send to a transport layer.
  // For now, we log it as a structured ADF (Agentic Data Format) payload.
  logger.info(`[A2UI_DISPATCH] ${JSON.stringify(message)}`);
}
