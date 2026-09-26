export type OcrRoutingMode = 'fast' | 'accurate' | 'balanced' | 'local_only' | 'privacy_first';

/**
 * Where a provider sends the image in order to read it. This is a capability of
 * the provider, not a preference of the caller: routing modes are derived from
 * it, so a newly added provider is classified by its own declaration instead of
 * by remembering to add its id to a hand-written chain.
 *
 * - `none`     — the image never leaves this process/machine (OS OCR, in-proc).
 * - `loopback` — sent to a service on this machine over the network stack.
 * - `external` — sent to a remote host. Never eligible under `local_only`.
 */
export type OcrDataEgress = 'none' | 'loopback' | 'external';

export type OcrBoundingBoxUnits = 'pixel' | 'normalized';

export interface OcrRequest {
  path: string;
  language?: string;
  mode?: OcrRoutingMode;
  providerPreference?: string[];
  extractStructure?: boolean;
  /**
   * Governed seam-provider-selection purpose (e.g. 'accuracy', 'speed',
   * 'privacy', 'cost'). Ignored when providerPreference is set — an explicit
   * choice always wins. `mode` still decides what is eligible; purpose only
   * orders the eligible providers.
   */
  purpose?: string;
}

export interface OcrTextLine {
  text: string;
  confidence: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface OcrResult {
  status: 'succeeded' | 'failed';
  provider: string;
  text: string;
  confidence: number;
  lines?: OcrTextLine[];
  structuredData?: any;
  /**
   * Units of `lines[].boundingBox`: image pixels, or 0..1 fractions of the
   * image size (top-left origin). Undeclared means pixels.
   */
  boundingBoxUnits?: OcrBoundingBoxUnits;
  error?: string;
  elapsedMs: number;
  /** Egress of the provider that served this result, so callers can assert it. */
  providerDataEgress?: OcrDataEgress;
}

export interface OcrProvider {
  readonly id: string;
  /**
   * Declared egress. Required: a provider that does not classify itself cannot
   * be routed safely, and the compiler should say so when one is added.
   * Providers whose destination is configurable (a host from an env var) must
   * compute this from the resolved endpoint rather than hard-coding it.
   */
  readonly dataEgress: OcrDataEgress;
  isAvailable(): Promise<boolean>;
  recognize(request: OcrRequest): Promise<OcrResult>;
}
