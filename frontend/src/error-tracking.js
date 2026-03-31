import Alpine from 'alpinejs';

/**
 * Lightweight error tracking setup.
 * - Conditionally loads @sentry/browser if a DSN is configured
 * - Sets up global error and unhandledrejection handlers
 * - Hooks into Alpine's error handler to show toast notifications
 */

let Sentry = null;

export async function initErrorTracking() {
  const dsn =
    window.__PEVO_CONFIG__?.sentryDsn ||
    document.querySelector('meta[name="sentry-dsn"]')?.content;

  if (dsn) {
    try {
      Sentry = await import('@sentry/browser');
      Sentry.init({
        dsn,
        environment: window.__PEVO_CONFIG__?.environment || 'production',
        sampleRate: 1.0,
        // Keep bundle light — no integrations beyond defaults
      });
    } catch {
      console.warn('[PEvO] Sentry init failed — error tracking disabled');
    }
  }

  // Global error handler
  window.addEventListener('error', (event) => {
    captureException(event.error || event.message);
    showErrorToast();
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    captureException(event.reason);
    showErrorToast();
  });
}

/**
 * Hook into Alpine's error handling after Alpine is initialized.
 * Call this before Alpine.start().
 */
export function setupAlpineErrorHandler() {
  // Alpine 3.x does not expose a public onError API, but we can
  // monkey-patch window.onerror-style or rely on the global handlers above.
  // Alpine errors that throw will bubble to the global handler.
  // For extra safety, wrap the alpine:init event:
  document.addEventListener('alpine:error', (event) => {
    captureException(event.detail?.error || event.detail);
    showErrorToast();
  });
}

export function captureException(error, extra) {
  if (Sentry) {
    Sentry.captureException(error, extra ? { extra } : undefined);
  }
  console.error('[PEvO]', error);
}

function showErrorToast() {
  try {
    const toast = Alpine.store('toast');
    if (toast) {
      toast.show('Something went wrong. Please try again.', 'error');
    }
  } catch {
    // Toast store not yet initialized
  }
}
