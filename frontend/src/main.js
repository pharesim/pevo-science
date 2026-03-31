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
import { initOnboardingModal } from './components/onboarding-modal.js';
import { initUsernameModal } from './components/username-modal.js';

// Pages — Phase 2 (simple)
import { initAboutPage } from './pages/about.js';
import { initFaqPage } from './pages/faq.js';
import { initGettingStartedPage } from './pages/getting-started.js';
import { initContactPage } from './pages/contact.js';

// Pages — Phase 3 (data)
import { initHomePage } from './pages/home.js';
import { initPaperDetailPage } from './pages/paper-detail.js';
import { initSearchPage } from './pages/search.js';
import { initResearchersPage } from './pages/researchers.js';
import { initStatsPage } from './pages/stats.js';
import { initProfilePage } from './pages/profile.js';

// Pages — Phase 4 (complex interactive)
import { initPublishPage } from './pages/publish.js';
import { initReviewPage } from './pages/review.js';
import { initBridgePage } from './pages/bridge.js';
import { initAccreditationPage } from './pages/accreditation.js';
import { initAccreditationVerifyPage } from './pages/accreditation-verify.js';
import { initAccreditationOrcidCallbackPage } from './pages/accreditation-orcid-callback.js';

// Components — Phase 4
import { initThreadedComments } from './components/threaded-comments.js';
import { initCommentComposer } from './components/comment-composer.js';
import { initVoteButtons } from './components/vote-buttons.js';
import { initVouchSection } from './components/vouch-section.js';

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
initOnboardingModal();
initUsernameModal();

// Initialize pages — Phase 2
initAboutPage();
initFaqPage();
initGettingStartedPage();
initContactPage();

// Initialize pages — Phase 3
initHomePage();
initPaperDetailPage();
initSearchPage();
initResearchersPage();
initStatsPage();
initProfilePage();

// Initialize components — Phase 4
initThreadedComments();
initCommentComposer();
initVoteButtons();
initVouchSection();

// Initialize pages — Phase 4
initPublishPage();
initReviewPage();
initBridgePage();
initAccreditationPage();
initAccreditationVerifyPage();
initAccreditationOrcidCallbackPage();

// Load i18n messages, then start Alpine
initI18n().then(() => {
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
