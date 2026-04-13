import Alpine from 'alpinejs';
import { getDiscordUrl, getGithubUrl } from '../config.js';

export function initFooter() {
  Alpine.data('footer', () => ({
    discordUrl: getDiscordUrl(),
    githubUrl: getGithubUrl(),
    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}
