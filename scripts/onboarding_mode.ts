export function isExpressOnboarding(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--express');
}

export function shouldRefuseNonInteractiveOnboarding(input: {
  interactive: boolean;
  express: boolean;
  allowDefaults?: string;
}): boolean {
  return !input.interactive && !input.express && input.allowDefaults !== '1';
}
