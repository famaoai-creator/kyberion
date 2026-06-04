export type OcrRoutingMode = 'fast' | 'accurate' | 'balanced' | 'local_only' | 'privacy_first';

export interface OcrRequest {
  path: string;
  language?: string;
  mode?: OcrRoutingMode;
  providerPreference?: string[];
  extractStructure?: boolean;
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
  error?: string;
  elapsedMs: number;
}

export interface OcrProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  recognize(request: OcrRequest): Promise<OcrResult>;
}

