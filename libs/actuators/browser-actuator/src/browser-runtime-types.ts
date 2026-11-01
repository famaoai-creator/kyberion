import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';

export interface BrowserWatchdog {
  /** How page-attached JS dialogs are settled when no step handles them. */
  dialog_policy: 'accept' | 'dismiss';
  dialog_events: Array<{
    tab_id: string;
    type: string;
    message: string;
    disposition: string;
    ts: string;
    error?: string;
  }>;
  download_events: Array<{
    tab_id: string;
    suggested_filename: string;
    url: string;
    ts: string;
    path?: string;
  }>;
  crash_events: Array<{ tab_id: string; ts: string }>;
  popup_events: Array<{
    tab_id: string;
    popup_tab_id: string;
    opener_url: string;
    ts: string;
  }>;
  /** Main-frame navigations, including redirects between steps. */
  navigation_events: Array<{ tab_id: string; url: string; ts: string }>;
  close_events: Array<{ tab_id: string; url: string; ts: string }>;
  /** Tab ids whose renderer crashed and has not been closed since. */
  crashed_tab_ids: string[];
}

export interface BrowserRuntime {
  context: BrowserContext;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  watchdog: BrowserWatchdog;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{
    tab_id: string;
    method: string;
    url: string;
    resourceType: string;
    ts: string;
  }>;
  navigationPolicy?: {
    allowed_origins?: string[];
    allow_private_network?: boolean;
    allow_data_url?: boolean;
  };
  webAuthn?: {
    authenticatorId?: string;
    enabled: boolean;
    options?: Record<string, any>;
    credentials: Array<Record<string, any>>;
    events: Array<{
      type: string;
      credential?: Record<string, any>;
      credentialId?: string;
      ts: string;
    }>;
  };
}

export interface BrowserRuntimeLease {
  runtime: BrowserRuntime;
  userDataDir: string;
  sessionMetadataPath: string;
  videoDir?: string;
  leaseExpiresAt?: number;
  cdpUrl?: string;
  cdpPort?: number;
  browser?: Browser;
  externalConnection?: boolean;
  scopeFingerprint: string;
}
