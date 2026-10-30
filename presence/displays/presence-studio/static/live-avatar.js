/** An OBS projection of the existing authenticated surface stream. It never
 * starts a microphone, synthesizes speech, or copies transcripts into the view. */
export function connectLiveAvatar({ avatar, EventSourceImpl, onConnection = () => {} }) {
  const source = new EventSourceImpl('/api/stream');
  let disposed = false;
  const reset = () => {
    avatar.followHost({ speaking: false });
    avatar.setState('idle');
    avatar.setExpression('neutral');
  };
  const listen = (name, apply) =>
    source.addEventListener(name, (event) => {
      if (disposed) return;
      try {
        apply(JSON.parse(event.data));
      } catch {
        /* A malformed event cannot start speech. */
      }
    });
  listen('state', (state) => {
    const data = state?.surfaces?.['presence-studio']?.data;
    if (!data || typeof data !== 'object') return;
    const status = String(data.status || '');
    // Host speech events own mouth motion; status alone must not create an
    // unbounded synthetic speaking loop after a dropped speech-end event.
    avatar.setState(
      status.startsWith('listening')
        ? 'listening'
        : status.startsWith('thinking')
          ? 'thinking'
          : 'idle'
    );
    avatar.setExpression(data.expression || 'neutral');
  });
  listen('speech_state', (payload) => {
    const speech = payload?.speech || payload;
    const duration = Number(speech?.estimated_ms);
    avatar.followHost({
      speaking: speech?.status === 'speaking',
      estimatedMs: Number.isFinite(duration) && duration > 0 ? Math.min(duration, 120000) : 15000,
    });
  });
  source.addEventListener('open', () => {
    if (!disposed) onConnection('live');
  });
  source.addEventListener('error', () => {
    if (disposed) return;
    reset();
    onConnection('offline');
  });
  return () => {
    if (disposed) return;
    disposed = true;
    source.close();
    reset();
    avatar.dispose();
  };
}
