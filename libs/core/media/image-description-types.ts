export interface ImageDescriptionRequest {
  path: string;
  kind?: 'brief' | 'detailed' | 'diagram' | 'accessible';
}

export interface ImageDescriptionResult {
  status: 'succeeded' | 'failed';
  provider: string;
  description: string;
  error?: string;
  elapsedMs: number;
}

export interface ImageDescriptionProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult>;
}
