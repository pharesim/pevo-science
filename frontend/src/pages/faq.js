import Alpine from 'alpinejs';

export function initFaqPage() {
  Alpine.data('faqPage', () => ({
    openIndex: null,

    faqItems: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12'],

    toggle(idx) {
      this.openIndex = this.openIndex === idx ? null : idx;
    },

    answerKey(qKey) {
      return qKey.replace('q', 'a');
    },
  }));
}
