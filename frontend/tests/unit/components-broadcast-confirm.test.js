import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthStore = { custody: 'light' };
const mockI18nStore = { messages: { common: { confirm: 'Confirm' } } };

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, value) => {
      if (value !== undefined) return; // registration call
      if (name === 'auth') return mockAuthStore;
      if (name === 'i18n') return mockI18nStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initBroadcastConfirm } from '../../src/components/broadcast-confirm.js';

function getStore() {
  initBroadcastConfirm();
  // The store is registered via Alpine.store('broadcastConfirm', {...})
  const call = Alpine.store.mock.calls.find((c) => c[0] === 'broadcastConfirm' && c[1]);
  return call[1];
}

describe('broadcastConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.custody = 'light';
  });

  it('auto-confirms for non-light accounts', async () => {
    mockAuthStore.custody = 'keychain';
    const store = getStore();
    const result = await store.request({ title: 'T', message: 'M' });
    expect(result).toBe(true);
    expect(store.open).toBe(false);
  });

  it('opens modal for light accounts and resolves true on confirm', async () => {
    const store = getStore();
    const promise = store.request({ title: 'Vote', message: 'Confirm vote?', confirmLabel: 'Do it' });
    expect(store.open).toBe(true);
    expect(store.title).toBe('Vote');
    expect(store.message).toBe('Confirm vote?');
    expect(store.confirmLabel).toBe('Do it');

    store.confirm();
    const result = await promise;
    expect(result).toBe(true);
    expect(store.open).toBe(false);
  });

  it('resolves false on cancel', async () => {
    const store = getStore();
    const promise = store.request({ title: 'T', message: 'M' });
    store.cancel();
    const result = await promise;
    expect(result).toBe(false);
    expect(store.open).toBe(false);
  });

  it('uses fallback confirmLabel from i18n store', () => {
    const store = getStore();
    store.request({ title: 'T', message: 'M' });
    expect(store.confirmLabel).toBe('Confirm');
  });

  // Regression for the refuse-while-open race-protection: a second synchronous
  // request() while a first is still awaiting must not silently overwrite the
  // modal's title/message/confirmLabel. Without this defense, a user who
  // clicks confirm shortly after a title-swap confirms the second request's
  // action (e.g. "mild concerns") while reading the first action's copy
  // (e.g. "strong endorsement"). The contract: the FIRST waiter keeps the
  // modal; the SECOND request resolves to false immediately and the caller
  // retries after the dialog closes.
  it('refuses overwrite while modal is open: second request resolves false, first stays pending', async () => {
    const store = getStore();
    const first = store.request({ title: 'First', message: 'First message', confirmLabel: 'First' });
    expect(store.open).toBe(true);
    expect(store.title).toBe('First');

    const second = store.request({ title: 'Second', message: 'Second message', confirmLabel: 'Second' });
    // Second resolves to false synchronously.
    expect(await second).toBe(false);
    // Modal still shows the first request's content; first promise remains
    // pending until user interaction.
    expect(store.title).toBe('First');
    expect(store.message).toBe('First message');
    expect(store.confirmLabel).toBe('First');
    expect(store.open).toBe(true);

    // First waiter resolves on confirm.
    store.confirm();
    expect(await first).toBe(true);
  });
});
