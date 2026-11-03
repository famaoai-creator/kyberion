/** Tracks domain payload changes before transport metadata is added. */
export function createIntelligenceSseChangeGate(): { hasChanged(payload: unknown): boolean } {
  let previousSerialized: string | undefined;

  return {
    hasChanged(payload): boolean {
      const serialized = JSON.stringify(payload);
      if (serialized === previousSerialized) return false;
      previousSerialized = serialized;
      return true;
    },
  };
}
