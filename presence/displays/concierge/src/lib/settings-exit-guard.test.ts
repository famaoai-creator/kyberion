import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import {
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';

vi.mock('./use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ t: (key: string) => key }),
}));
import {
  GuardedAnchor,
  SettingsExitGuardProvider,
  useSettingsExitGuard,
  useSettingsExitRegistration,
  type SettingsExitRegistration,
} from './settings-exit-guard';

type Options = Pick<SettingsExitRegistration, 'dirty' | 'saving' | 'valid'>;
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
let setOptions: React.Dispatch<React.SetStateAction<Options>>;
let setRegistered: React.Dispatch<React.SetStateAction<boolean>>;
let guard: ReturnType<typeof useSettingsExitGuard>;
let invalidate: () => void;
let liveSaving = false;
let discard = vi.fn(() => true);
const assign = vi.fn();

beforeAll(async () => {
  dom = installFakeDom({
    location: { href: 'https://concierge.test/settings?tenant=alpha', assign },
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  liveSaving = false;
  discard = vi.fn(() => true);
  assign.mockClear();
  dom.window.location = { href: 'https://concierge.test/settings?tenant=alpha', assign };
});
afterAll(() => dom.restore());

function SettingsRegistration({ options }: { options: Options }) {
  ({ invalidate } = useSettingsExitRegistration({
    ...options,
    isSaving: () => liveSaving,
    discard: () => discard(),
  }));
  return null;
}
function Controls({ initial }: { initial: Options }) {
  const [options, updateOptions] = React.useState(initial);
  const [registered, updateRegistered] = React.useState(true);
  setOptions = updateOptions;
  setRegistered = updateRegistered;
  guard = useSettingsExitGuard();
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { id: 'origin', type: 'button' }, 'origin'),
    React.createElement(GuardedAnchor, { id: 'native', href: '/activity' }, 'activity'),
    React.createElement(
      GuardedAnchor,
      { id: 'blank', href: '/activity', target: '_blank' },
      'new tab'
    ),
    React.createElement(
      GuardedAnchor,
      { id: 'download', href: '/download', download: true },
      'download'
    ),
    React.createElement(GuardedAnchor, { id: 'mail', href: 'mailto:help@example.test' }, 'email'),
    React.createElement(GuardedAnchor, { id: 'phone', href: 'tel:+10000000000' }, 'phone'),
    React.createElement(
      GuardedAnchor,
      {
        id: 'prevented',
        href: '/activity',
        onClick: (event) => event.preventDefault(),
      },
      'cancelled link'
    ),
    registered ? React.createElement(SettingsRegistration, { options }) : null
  );
}

async function mount(options: Partial<Options> = {}, provider = true, strict = false) {
  const initial = { dirty: true, saving: false, valid: true, ...options };
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () =>
    React.act(() => {
      root.unmount();
      dom.document.body.removeChild(container);
    });
  const controls = React.createElement(Controls, { initial });
  const content = provider
    ? React.createElement(SettingsExitGuardProvider, null, controls)
    : controls;
  await React.act(async () =>
    root.render(strict ? React.createElement(React.StrictMode, null, content) : content)
  );
  const find = (selector: string) => {
    const result = container.querySelector(selector);
    if (!result) throw new Error('Missing ' + selector);
    return result;
  };
  return {
    container,
    find,
    text: () => serializeFake(container),
    open: () => container.querySelector('[role="dialog"]') !== null,
    click: async (choice: string) => {
      await React.act(async () => {
        fireEvent(find('[data-choice-id="' + choice + '"]'), 'click');
      });
    },
    request: async (href = '/activity', proceed = vi.fn()) => {
      await React.act(async () => guard.requestLeave(href, proceed));
      return proceed;
    },
  };
}
const beforeUnload = () =>
  fireEvent(dom.windowEvents, 'beforeunload', { returnValue: 'unchanged' });
const update = async (options: Partial<Options>) => {
  await React.act(async () => setOptions((previous) => ({ ...previous, ...options })));
};

describe('settings exit guard', () => {
  it('allows clean navigation immediately and has no native unload warning', async () => {
    const view = await mount({ dirty: false });
    const proceed = await view.request();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(view.open()).toBe(false);
    expect(beforeUnload().defaultPrevented).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it('guards dirty navigation, keeps drafts on stay, and restores focus', async () => {
    const view = await mount();
    const origin = view.find('[id="origin"]');
    origin.focus();
    const proceed = await view.request();
    expect(proceed).not.toHaveBeenCalled();
    expect(view.open()).toBe(true);
    expect(view.text()).toContain('setup.leave_message');
    const dialog = view.find('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('kbdlg-settings-leave-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('kbdlg-settings-leave-message');
    expect(dom.document.activeElement).toBe(view.find('[data-choice-id="stay"]'));
    await view.click('stay');
    expect(dom.document.activeElement).toBe(origin);
    expect(view.open()).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(beforeUnload().defaultPrevented).toBe(true);
  });

  it('supports shared Dialog Escape cancellation and focus trapping', async () => {
    const view = await mount();
    const proceed = await view.request();
    const stay = view.find('[data-choice-id="stay"]');
    const discardButton = view.find('[data-choice-id="discard"]');
    await React.act(async () => {
      fireEvent(stay, 'keydown', { key: 'Tab', shiftKey: true });
    });
    expect(dom.document.activeElement).toBe(discardButton);
    await React.act(async () => {
      fireEvent(discardButton, 'keydown', { key: 'Tab' });
    });
    expect(dom.document.activeElement).toBe(stay);
    await React.act(async () => {
      fireEvent(stay, 'keydown', { key: 'Escape' });
    });
    expect(view.open()).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('discards and releases beforeunload synchronously before proceeding exactly once', async () => {
    const view = await mount();
    discard.mockImplementation(() => {
      setOptions((old) => ({ ...old, dirty: false }));
      return true;
    });
    const proceed = vi.fn(() => expect(beforeUnload().defaultPrevented).toBe(false));
    await view.request('/activity', proceed);
    const button = view.find('[data-choice-id="discard"]');
    await React.act(async () => {
      fireEvent(button, 'click');
      fireEvent(button, 'click');
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(view.open()).toBe(false);
    expect(beforeUnload().defaultPrevented).toBe(false);
    await update({ dirty: true });
    expect(beforeUnload().defaultPrevented).toBe(true);
  });

  it('re-arms a newer edit batched with discard even when dirty remains true', async () => {
    const view = await mount();
    discard.mockImplementation(() => {
      setOptions((old) => ({ ...old, dirty: false }));
      return true;
    });
    const proceed = await view.request();
    await React.act(async () => {
      fireEvent(view.find('[data-choice-id="discard"]'), 'click');
      setOptions((old) => ({ ...old, dirty: true }));
    });
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(beforeUnload().defaultPrevented).toBe(true);
    const nextProceed = await view.request('/another');
    expect(nextProceed).not.toHaveBeenCalled();
    expect(view.open()).toBe(true);
  });

  it('does not navigate if the page refuses discard', async () => {
    const view = await mount();
    discard.mockReturnValue(false);
    const proceed = await view.request();
    await view.click('discard');
    expect(proceed).not.toHaveBeenCalled();
    expect(view.open()).toBe(true);
    expect(beforeUnload().defaultPrevented).toBe(true);
  });

  it('omits discard during a save, including a clean draft, and never auto-leaves on settlement', async () => {
    const view = await mount({ dirty: false, saving: true });
    liveSaving = true;
    const proceed = await view.request();
    expect(view.text()).toContain('setup.leave_saving_message');
    expect(view.container.querySelector('[data-choice-id="discard"]')).toBeNull();
    expect(beforeUnload().defaultPrevented).toBe(true);
    liveSaving = false;
    await update({ saving: false });
    expect(proceed).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(beforeUnload().defaultPrevented).toBe(false);
    expect(view.open()).toBe(false);
    const later = await view.request('/later');
    expect(later).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('rechecks the synchronous save fence before discarding a stale rendered button', async () => {
    const view = await mount();
    const proceed = await view.request();
    liveSaving = true;
    await view.click('discard');
    expect(discard).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
    await update({ saving: true });
    expect(view.container.querySelector('[data-choice-id="discard"]')).toBeNull();
    liveSaving = false;
    await update({ saving: false, dirty: false });
    expect(proceed).not.toHaveBeenCalled();
  });

  it('keeps a dirty failed or partial save guarded and focuses stay when saving removes discard', async () => {
    const view = await mount();
    const proceed = await view.request();
    view.find('[data-choice-id="discard"]').focus();
    liveSaving = true;
    await update({ saving: true });
    expect(dom.document.activeElement).toBe(view.find('[data-choice-id="stay"]'));
    liveSaving = false;
    await update({ saving: false });
    expect(view.open()).toBe(true);
    expect(view.container.querySelector('[data-choice-id="discard"]')).not.toBeNull();
    expect(proceed).not.toHaveBeenCalled();
    expect(beforeUnload().defaultPrevented).toBe(true);
    await view.click('discard');
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('blocks clean navigation when a save started before its rendered flag committed', async () => {
    const view = await mount({ dirty: false });
    liveSaving = true;
    const proceed = await view.request();
    expect(proceed).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-choice-id="discard"]')).toBeNull();
  });

  it('replaces a queued destination and rejects an older rendered confirmation', async () => {
    const view = await mount();
    const oldProceed = await view.request('/old');
    const oldButton = view.find('[data-choice-id="discard"]');
    const newProceed = vi.fn();
    await React.act(async () => {
      guard.requestLeave('/new', newProceed);
      fireEvent(oldButton, 'click');
    });
    expect(oldProceed).not.toHaveBeenCalled();
    expect(newProceed).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    await view.click('discard');
    expect(newProceed).toHaveBeenCalledTimes(1);
    expect(oldProceed).not.toHaveBeenCalled();
  });

  it.each(['invalidate', 'invalid-render', 'unmount'])(
    'cancels queued navigation on %s and releases the native listener',
    async (method) => {
      const view = await mount();
      const proceed = await view.request();
      await React.act(async () => {
        if (method === 'invalidate') invalidate();
        else if (method === 'invalid-render') setOptions((old) => ({ ...old, valid: false }));
        else setRegistered(false);
      });
      expect(view.open()).toBe(false);
      expect(proceed).not.toHaveBeenCalled();
      expect(beforeUnload().defaultPrevented).toBe(false);
      await update({ saving: false, dirty: false });
      expect(proceed).not.toHaveBeenCalled();
    }
  );

  it('invalidation wins over a stale confirmation in the same event', async () => {
    const view = await mount();
    const proceed = await view.request();
    const button = view.find('[data-choice-id="discard"]');
    await React.act(async () => {
      invalidate();
      fireEvent(button, 'click');
    });
    expect(discard).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('does not navigate if discard itself invalidates the registration', async () => {
    const view = await mount();
    const proceed = await view.request();
    discard.mockImplementation(() => {
      invalidate();
      return true;
    });
    await view.click('discard');
    expect(proceed).not.toHaveBeenCalled();
    expect(view.open()).toBe(false);
  });

  it('removes listeners on provider unmount and ignores a retained request callback', async () => {
    const view = await mount();
    const pending = await view.request();
    const requestLeave = guard.requestLeave;
    unmount?.();
    unmount = undefined;
    expect(beforeUnload().defaultPrevented).toBe(false);
    const later = vi.fn();
    requestLeave('/later', later);
    expect(later).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
  });

  it('uses the standard native warning only while dirty or saving', async () => {
    await mount();
    const event = beforeUnload();
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe('');
    await update({ dirty: false });
    expect(beforeUnload().defaultPrevented).toBe(false);
    await update({ saving: true });
    expect(beforeUnload().defaultPrevented).toBe(true);
    await update({ saving: false });
    expect(beforeUnload().returnValue).toBe('unchanged');
  });

  it.each([
    '#profile',
    '/settings?tenant=alpha#profile',
    'https://concierge.test/settings?tenant=alpha#profile',
  ])('allows same-document hash navigation: %s', async (href) => {
    const view = await mount();
    const proceed = await view.request(href);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(view.open()).toBe(false);
    expect(beforeUnload().defaultPrevented).toBe(true);
  });

  it('allows removing an existing hash and repeating a nonempty hash', async () => {
    dom.window.location = { href: 'https://concierge.test/settings?tenant=alpha#profile', assign };
    const view = await mount();
    expect(await view.request('/settings?tenant=alpha')).toHaveBeenCalledTimes(1);
    expect(await view.request('#profile')).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/settings?tenant=beta#profile',
    '/other?tenant=alpha#profile',
    'https://other.test/settings?tenant=alpha#profile',
    '/settings?tenant=alpha',
    '/settings#profile',
  ])('guards context changes and a hashless reload: %s', async (href) => {
    const view = await mount();
    const proceed = await view.request(href);
    expect(proceed).not.toHaveBeenCalled();
    expect(view.open()).toBe(true);
  });

  it('cancels an older destination when a newer hash navigation bypasses the dialog', async () => {
    const view = await mount();
    const older = await view.request('/old');
    const samePage = await view.request('#profile');
    expect(samePage).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(view.open()).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it('keeps the hook identities stable across draft changes', async () => {
    await mount();
    const originalGuard = guard;
    const originalInvalidate = invalidate;
    await update({ dirty: false });
    expect(guard).toBe(originalGuard);
    expect(invalidate).toBe(originalInvalidate);
  });

  it('survives StrictMode effect replay', async () => {
    const view = await mount({}, true, true);
    const proceed = await view.request();
    expect(view.open()).toBe(true);
    expect(beforeUnload().defaultPrevented).toBe(true);
    await view.click('discard');
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('keeps isolated legacy page harnesses nonthrowing without the shell provider', async () => {
    const view = await mount({}, false);
    const proceed = await view.request();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(() => invalidate()).not.toThrow();
    expect(beforeUnload().defaultPrevented).toBe(false);
  });
});

describe('guarded native anchor', () => {
  it('guards an ordinary click and performs exactly the confirmed destination', async () => {
    const view = await mount();
    await React.act(async () => {
      fireEvent(view.find('[id="native"]'), 'click', { button: 0 });
    });
    expect(assign).not.toHaveBeenCalled();
    expect(view.open()).toBe(true);
    await view.click('discard');
    expect(assign).toHaveBeenCalledExactlyOnceWith('/activity');
  });

  it.each([
    ['native', { button: 1 }],
    ['native', { button: 0, ctrlKey: true }],
    ['native', { button: 0, metaKey: true }],
    ['native', { button: 0, shiftKey: true }],
    ['native', { button: 0, altKey: true }],
    ['blank', { button: 0 }],
    ['download', { button: 0 }],
    ['prevented', { button: 0 }],
    ['mail', { button: 0 }],
    ['phone', { button: 0 }],
  ])('preserves native or cancelled behavior for %s %#', async (id, event) => {
    const view = await mount();
    await React.act(async () => {
      fireEvent(view.find('[id="' + id + '"]'), 'click', event);
    });
    expect(view.open()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});
