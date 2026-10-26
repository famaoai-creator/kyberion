/** A service's storage root follows its executable checkout, never inherited environment. */
export function daemonBoundEnvironment(context: {
  repoRoot: string;
  env?: Record<string, string>;
}): Record<string, string> {
  return { ...context.env, KYBERION_ROOT: context.repoRoot };
}
