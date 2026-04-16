import Alpine from 'alpinejs';
import { pages } from '../pages/index.js';

export function initPageMount() {
  Alpine.data('pageMount', () => ({
    _container: null,

    init() {
      // Create a dedicated container for dynamically-rendered pages.
      // This avoids destroying the inline <template x-if> blocks that
      // coexist during migration.
      this._container = document.createElement('div');
      this.$el.prepend(this._container);

      Alpine.effect(() => {
        const route = Alpine.store('router').route;
        this.renderPage(route);
      });
    },

    renderPage(route) {
      const page = pages[route];
      const container = this._container;

      // Clear previous dynamic content
      Alpine.mutateDom(() => {
        while (container.firstChild) {
          Alpine.destroyTree(container.firstChild);
          container.removeChild(container.firstChild);
        }
      });

      if (!page) return;

      Alpine.mutateDom(() => {
        // Insert new template
        const wrapper = document.createElement('div');
        wrapper.innerHTML = page.template.trim();
        while (wrapper.firstChild) {
          container.appendChild(wrapper.firstChild);
        }

        // Initialize Alpine on new DOM
        Alpine.initTree(container);
      });
    }
  }));
}
