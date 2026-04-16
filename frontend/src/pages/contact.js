import Alpine from 'alpinejs';
import { submitContactForm } from '../api.js';
import { getDiscordUrl, getGithubUrl } from '../config.js';

const template = `
      <div x-data="contactPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('contact.title')"></h1>
        <p class="text-ink-muted mb-8" x-text="$t('contact.description')"></p>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <!-- Contact form -->
          <div class="md:col-span-2">
            <div class="card">
              <!-- Success state -->
              <template x-if="step === 'success'">
                <div class="text-center py-6">
                  <svg class="h-12 w-12 text-pevo-green mx-auto mb-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                  </svg>
                  <h2 class="text-lg font-semibold text-ink mb-1" x-text="$t('contact.successTitle')"></h2>
                  <p class="text-sm text-ink-muted mb-4" x-text="$t('contact.successMessage')"></p>
                  <button class="btn-secondary" @click="handleReset()" x-text="$t('contact.sendAnother')"></button>
                </div>
              </template>

              <!-- Form state -->
              <template x-if="step !== 'success'">
                <form @submit.prevent="handleSubmit()" class="space-y-4">
                  <!-- Error banner -->
                  <div x-show="step === 'error'" class="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4">
                    <p class="text-sm font-medium text-pevo-crimson-dark" x-text="errorMessage"></p>
                  </div>

                  <div>
                    <label for="category" class="block text-sm font-medium text-ink mb-1" x-text="$t('contact.categoryLabel')"></label>
                    <select id="category" class="select-control" x-model="category">
                      <option value="bug" x-text="$t('contact.categoryBug')"></option>
                      <option value="accreditation" x-text="$t('contact.categoryAccreditation')"></option>
                      <option value="keychain" x-text="$t('contact.categoryKeychain')"></option>
                      <option value="general" x-text="$t('contact.categoryGeneral')"></option>
                    </select>
                  </div>

                  <div>
                    <label for="contact-email" class="block text-sm font-medium text-ink mb-1" x-text="$t('contact.emailLabel')"></label>
                    <input id="contact-email" type="email" class="select-control"
                           :placeholder="$t('contact.emailPlaceholder')"
                           x-model="email" required />
                  </div>

                  <div>
                    <label for="subject" class="block text-sm font-medium text-ink mb-1" x-text="$t('contact.subjectLabel')"></label>
                    <input id="subject" type="text" class="select-control"
                           :placeholder="$t('contact.subjectPlaceholder')"
                           x-model="subject" required maxlength="200" />
                  </div>

                  <div>
                    <label for="message" class="block text-sm font-medium text-ink mb-1" x-text="$t('contact.messageLabel')"></label>
                    <textarea id="message" class="select-control min-h-[150px]"
                              :placeholder="$t('contact.messagePlaceholder')"
                              x-model="message" required minlength="10" maxlength="5000"></textarea>
                  </div>

                  <!-- Honeypot -->
                  <div class="absolute -left-[9999px]" aria-hidden="true">
                    <label for="website">Website</label>
                    <input id="website" type="text" tabindex="-1" autocomplete="off" x-model="website" />
                  </div>

                  <div class="pt-2">
                    <button type="submit" class="btn-primary" :disabled="step === 'submitting'"
                            x-text="step === 'submitting' ? $t('contact.submitting') : $t('contact.submitButton')"></button>
                  </div>
                </form>
              </template>
            </div>
          </div>

          <!-- Info sidebar -->
          <div class="space-y-4">
            <div class="card">
              <h3 class="text-sm font-semibold text-ink mb-3" x-text="$t('contact.infoTitle')"></h3>
              <ul class="space-y-4 text-sm">
                <li>
                  <p class="font-medium text-ink" x-text="$t('contact.emailUs')"></p>
                  <a href="mailto:support@pevo.science" class="text-pevo-teal hover:underline break-all">support@pevo.science</a>
                </li>
                <li x-show="githubIssuesUrl">
                  <p class="font-medium text-ink" x-text="$t('contact.githubIssues')"></p>
                  <p class="text-ink-muted text-xs mb-1" x-text="$t('contact.githubIssuesDesc')"></p>
                  <a :href="githubIssuesUrl" target="_blank" rel="noopener noreferrer"
                     class="text-pevo-teal hover:underline">GitHub Issues</a>
                </li>
                <li x-show="discordUrl">
                  <p class="font-medium text-ink" x-text="$t('contact.discordCommunity')"></p>
                  <p class="text-ink-muted text-xs mb-1" x-text="$t('contact.discordDesc')"></p>
                  <a :href="discordUrl" target="_blank" rel="noopener noreferrer"
                     class="text-pevo-teal hover:underline">Discord</a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
`;

export { template as contactPageTemplate };

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
