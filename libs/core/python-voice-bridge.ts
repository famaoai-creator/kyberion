export interface PythonVoiceBridgeOptions {
  enabled?: boolean;
}

export function installPythonVoiceBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
  _options: PythonVoiceBridgeOptions = {}
): boolean {
  return env.KYBERION_PYTHON_VOICE_BRIDGE === '1';
}
