import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture-def Alpine mock: initReauthModal registers via store('reauthModal', def);
// later store('reauthModal') reads it back. The i18n store supplies modal copy.
let reauthStore;
const i18nMessages = { reauth: { title: 'T', message: 'M' } };
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (name === 'reauthModal') {
        if (def) reauthStore = def;
        return reauthStore;
      }
      if (name === 'i18n') return { messages: i18nMessages };
      return null;
    }),
  },
}));

import { initReauthModal } from '../../src/components/reauth-modal.js';

describe('reauthModal store', () => {
  beforeEach(() => {
    reauthStore = null;
    initReauthModal();
  });

  it('request() opens the modal with the default i18n title/message', async () => {
    const p = reauthStore.request();
    expect(reauthStore.open).toBe(true);
    expect(reauthStore.title).toBe('T');
    expect(reauthStore.message).toBe('M');
    reauthStore.password = 'pw';
    reauthStore.submit();
    await expect(p).resolves.toBe('pw');
  });

  it('submit() resolves with the entered password and clears state', async () => {
    const p = reauthStore.request();
    reauthStore.password = 's3cret';
    reauthStore.submit();
    await expect(p).resolves.toBe('s3cret');
    expect(reauthStore.open).toBe(false);
    expect(reauthStore.password).toBe('');
  });

  it('cancel() resolves null and clears state', async () => {
    const p = reauthStore.request();
    reauthStore.password = 'typed';
    reauthStore.cancel();
    await expect(p).resolves.toBeNull();
    expect(reauthStore.open).toBe(false);
    expect(reauthStore.password).toBe('');
  });

  it('honors a caller-supplied title and message', () => {
    reauthStore.request({ title: 'Custom T', message: 'Custom M' });
    expect(reauthStore.title).toBe('Custom T');
    expect(reauthStore.message).toBe('Custom M');
    reauthStore.cancel();
  });

  it('refuses a second request while one is open, resolving null without disturbing the first', async () => {
    const first = reauthStore.request();
    const second = reauthStore.request();
    await expect(second).resolves.toBeNull();
    reauthStore.password = 'first-pw';
    reauthStore.submit();
    await expect(first).resolves.toBe('first-pw');
  });
});
