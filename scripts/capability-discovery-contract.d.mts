export interface CapabilityDefinition {
  op?: string;
  platforms?: string[];
  requirements?: {
    bin?: string[];
    env?: string[];
    env_platforms?: string[];
  };
}

export interface CapabilityEvaluation {
  op: string;
  platforms: string[];
  platformMatch: boolean;
  missingBins: string[];
  missingEnv: string[];
  available: boolean;
}

export function evaluateCapabilityContract(
  capability: CapabilityDefinition,
  platform: string,
  binaryAvailable: (bin: string) => boolean,
  envAvailable: (name: string) => boolean
): CapabilityEvaluation;
