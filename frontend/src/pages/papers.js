import Alpine from 'alpinejs';
import { paperFeedTemplate } from '../components/paper-feed.js';

const template = `
      <div x-data="papersPage" class="container-narrow py-8">
        <div class="mb-6">
          <h2 class="text-2xl font-bold text-ink mb-1" x-text="$t('home.feedTitle')"></h2>
          <p class="text-sm text-ink-muted" x-text="$t('home.feedDescription')"></p>
        </div>
        <div x-data="paperFeed">${paperFeedTemplate}</div>
      </div>
`;

export { template as papersPageTemplate };

export function initPapersPage() {
  Alpine.data('papersPage', () => ({}));
}
