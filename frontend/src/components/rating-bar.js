import Alpine from 'alpinejs';

export function initRatingBar() {
  // Rating bar is template-driven. The percentage width is computed inline.
  // Usage in templates:
  //   <div class="flex items-center gap-3 text-sm">
  //     <span class="w-28 text-ink-muted shrink-0" x-text="label"></span>
  //     <div class="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
  //       <div class="h-full bg-pevo-teal rounded-full transition-all"
  //            :style="`width: ${(value / max) * 100}%`"></div>
  //     </div>
  //     <span class="w-8 text-right font-medium text-ink" x-text="`${value}/${max}`"></span>
  //   </div>
}
