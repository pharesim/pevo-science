import Alpine from 'alpinejs';
import './styles.css';

// Error tracking (init early, before anything else)
import { initErrorTracking, setupAlpineErrorHandler } from './error-tracking.js';

// Stores
import { initRouter } from './router.js';
import { initI18n } from './i18n.js';
import { initAuth } from './auth.js';
import { initToast } from './toast.js';
import { initNotifications } from './notifications.js';

// Components
import { initHeader } from './components/header.js';
import { initFooter } from './components/footer.js';
import { initMarkdownRenderer } from './components/markdown-renderer.js';
import { initSignInModal } from './components/sign-in-modal.js';
import { initPageMount } from './components/page-mount.js';

// Page registry (all 26 pages)
import { pages } from './pages/index.js';

// Components — Phase 4
import { initThreadedComments } from './components/threaded-comments.js';
import { initCommentComposer } from './components/comment-composer.js';
import { initVoteButtons } from './components/vote-buttons.js';
import { initVouchSection } from './components/vouch-section.js';
import { initBroadcastConfirm } from './components/broadcast-confirm.js';

// Make Alpine available globally for debugging
window.Alpine = Alpine;

// Initialize error tracking (global handlers)
initErrorTracking();
setupAlpineErrorHandler();

// Initialize stores (order matters: router and i18n first)
initRouter();
initToast();
initNotifications();
initAuth();

// Initialize components
initHeader();
initFooter();
initMarkdownRenderer();
initSignInModal();
initPageMount();

// Initialize all pages from registry
Object.values(pages).forEach(p => p.init());

// Initialize components — Phase 4
initThreadedComments();
initCommentComposer();
initVoteButtons();
initVouchSection();
initBroadcastConfirm();

// Load i18n messages, sync locale with router, then start Alpine
initI18n().then(() => {
  const router = Alpine.store('router');
  const i18n = Alpine.store('i18n');
  if (router && i18n && router.locale !== i18n.locale) {
    router.locale = i18n.locale;
  }
  Alpine.start();
});

// Watch auth state to start/stop notification polling.
// start()/stop() must run outside the reactive scope (via queueMicrotask),
// otherwise their reads/writes to the notification store create dependencies
// that re-trigger the effect in an infinite loop.
document.addEventListener('alpine:init', () => {
  Alpine.effect(() => {
    const auth = Alpine.store('auth');
    const isConnected = auth.isConnected;
    const username = auth.username;
    queueMicrotask(() => {
      const notifications = Alpine.store('notifications');
      if (isConnected && username) {
        if (notifications._username !== username) {
          notifications.start(username);
        }
      } else if (notifications._username) {
        notifications.stop();
      }
    });
  });
});
