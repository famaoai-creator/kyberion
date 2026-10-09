export interface DistScope {
  manifest: {
    private: true;
    type: string;
    description: string;
    imports: Record<string, string>;
  };
  shims: Array<{ file: string; body: string }>;
}

export function buildDistScope(
  corePackage: { type?: string; imports?: Record<string, unknown> },
  readTarget?: (file: string) => string
): DistScope;

export function findDistScopeDrift(options?: {
  coreDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[];

export function writeDistScope(options?: { coreDir?: string; env?: NodeJS.ProcessEnv }): {
  written: boolean;
  distDir: string;
};
