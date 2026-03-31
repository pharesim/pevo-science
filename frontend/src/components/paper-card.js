import Alpine from 'alpinejs';

export function initPaperCard() {
  // Paper card is template-driven. All data comes from the parent x-for loop.
  // Helper registered as a global Alpine magic for date formatting.
}

/**
 * Truncate text to maxLength, breaking at word boundary.
 */
export function truncateText(text, maxLength = 280) {
  if (!text || text.length <= maxLength) return text || '';
  return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

/**
 * Format an ISO date string for display.
 */
export function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
