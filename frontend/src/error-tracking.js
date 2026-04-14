import Alpine from 'alpinejs';

/**
 * Lightweight error tracking setup.
 * - Sets up global error and unhandledrejection handlers
 * - Hooks into Alpine's error handler to show toast notifications
 */

export async function initErrorTracking() {
  window.addEventListener('error', (event) => {
    console.error('[PEvO]', event.error || event.message);
    showErrorToast();
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[PEvO]', event.reason);
    showErrorToast();
  });
}

export function setupAlpineErrorHandler() {
  document.addEventListener('alpine:error', (event) => {
    console.error('[PEvO]', event.detail?.error || event.detail);
    showErrorToast();
  });
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
