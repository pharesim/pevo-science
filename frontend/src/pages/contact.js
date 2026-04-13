import Alpine from 'alpinejs';
import { submitContactForm } from '../api.js';
import { getDiscordUrl, getGithubUrl } from '../config.js';

export function initContactPage() {
  Alpine.data('contactPage', () => ({
    discordUrl: getDiscordUrl(),
    githubUrl: getGithubUrl(),
    get githubIssuesUrl() { return this.githubUrl ? this.githubUrl + '/issues' : ''; },
    category: 'general',
    email: '',
    subject: '',
    message: '',
    website: '', // honeypot
    step: 'idle', // idle | submitting | success | error
    errorMessage: '',

    categories: ['bug', 'accreditation', 'keychain', 'general'],

    async handleSubmit() {
      if (this.website) return; // honeypot triggered

      this.step = 'submitting';
      this.errorMessage = '';

      try {
        await submitContactForm({
          category: this.category,
          email: this.email,
          subject: this.subject,
          message: this.message,
        });
        this.step = 'success';
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err instanceof Error ? err.message : this.$t('contact.errorGeneric');
      }
    },

    handleReset() {
      this.category = 'general';
      this.email = '';
      this.subject = '';
      this.message = '';
      this.step = 'idle';
      this.errorMessage = '';
    },
  }));
}
