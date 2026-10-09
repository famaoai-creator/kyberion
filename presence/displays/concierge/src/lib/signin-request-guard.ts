import { getFrontDeskAuthRevision } from './front-desk-auth-token';

/** One explicit sign-in attempt at a time. Navigation or newer authentication wins. */
export function createSigninRequestGuard() {
  let pending: AbortController | null = null;
  let generation = 0;
  return {
    begin() {
      if (pending) return null;
      const controller = new AbortController();
      pending = controller;
      const selected = ++generation;
      const revision = getFrontDeskAuthRevision();
      const navigation = window.location.pathname + window.location.search;
      return {
        signal: controller.signal,
        current: () =>
          !controller.signal.aborted &&
          selected === generation &&
          revision === getFrontDeskAuthRevision() &&
          navigation === window.location.pathname + window.location.search,
        finish: () => {
          if (pending === controller) pending = null;
        },
      };
    },
    cancel() {
      generation++;
      pending?.abort();
      pending = null;
    },
  };
}
