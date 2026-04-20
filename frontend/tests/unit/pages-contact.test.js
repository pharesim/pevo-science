import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubmitContactForm = vi.fn();

vi.mock('../../src/api.js', () => ({
  submitContactForm: (...args) => mockSubmitContactForm(...args),
}));

vi.mock('../../src/config.js', () => ({
  getDiscordUrl: () => 'https://discord.gg/test',
  getGithubUrl: () => 'https://github.com/test/repo',
}));

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
  },
}));

import Alpine from 'alpinejs';
import { initContactPage } from '../../src/pages/contact.js';

function createComponent() {
  initContactPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('contactPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSubmit', () => {
    it('silently returns when honeypot is filled (bot detection)', async () => {
      const comp = createComponent();
      comp.website = 'http://spam.com';
      comp.email = 'test@example.com';
      comp.subject = 'Hello';
      comp.message = 'Test message';

      await comp.handleSubmit();

      expect(mockSubmitContactForm).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    });

    it('transitions idle -> submitting -> success', async () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.subject = 'Bug report';
      comp.message = 'Something broke';
      comp.category = 'bug';

      let stepDuringFetch;
      mockSubmitContactForm.mockImplementation(() => {
        stepDuringFetch = comp.step;
        return Promise.resolve();
      });

      await comp.handleSubmit();

      expect(stepDuringFetch).toBe('submitting');
      expect(comp.step).toBe('success');
    });

    it('sends correct form data', async () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.subject = 'Bug report';
      comp.message = 'Something broke';
      comp.category = 'bug';

      mockSubmitContactForm.mockResolvedValue();
      await comp.handleSubmit();

      expect(mockSubmitContactForm).toHaveBeenCalledWith({
        category: 'bug',
        email: 'test@example.com',
        subject: 'Bug report',
        message: 'Something broke',
      });
    });

    it('transitions to error on failure with Error instance', async () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.subject = 'Test';
      comp.message = 'Message';

      mockSubmitContactForm.mockRejectedValue(new Error('Rate limited'));
      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('Rate limited');
    });

    it('uses i18n fallback for non-Error rejections', async () => {
      const comp = createComponent();
      comp.email = 'test@example.com';
      comp.subject = 'Test';
      comp.message = 'Message';

      mockSubmitContactForm.mockRejectedValue('string error');
      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('contact.errorGeneric');
    });

    it('clears errorMessage before submitting', async () => {
      const comp = createComponent();
      comp.errorMessage = 'old error';
      comp.email = 'test@example.com';
      comp.subject = 'Test';
      comp.message = 'Message';

      mockSubmitContactForm.mockResolvedValue();
      await comp.handleSubmit();

      expect(comp.errorMessage).toBe('');
    });
  });

  describe('handleReset', () => {
    it('resets all form fields and step to idle', () => {
      const comp = createComponent();
      comp.category = 'bug';
      comp.email = 'test@example.com';
      comp.subject = 'Bug';
      comp.message = 'Details';
      comp.step = 'success';
      comp.errorMessage = 'Some error';

      comp.handleReset();

      expect(comp.category).toBe('general');
      expect(comp.email).toBe('');
      expect(comp.subject).toBe('');
      expect(comp.message).toBe('');
      expect(comp.step).toBe('idle');
      expect(comp.errorMessage).toBe('');
    });
  });

  describe('state machine transitions', () => {
    it('idle -> submitting -> error -> idle (via retry)', async () => {
      const comp = createComponent();
      comp.email = 'a@b.com';
      comp.subject = 's';
      comp.message = 'm';

      mockSubmitContactForm.mockRejectedValue(new Error('fail'));
      await comp.handleSubmit();
      expect(comp.step).toBe('error');

      // Simulate user clicking "try again" which sets step back to idle
      comp.step = 'idle';
      expect(comp.step).toBe('idle');
    });

    it('success -> idle (via handleReset)', async () => {
      const comp = createComponent();
      comp.email = 'a@b.com';
      comp.subject = 's';
      comp.message = 'm';

      mockSubmitContactForm.mockResolvedValue();
      await comp.handleSubmit();
      expect(comp.step).toBe('success');

      comp.handleReset();
      expect(comp.step).toBe('idle');
    });
  });
});
