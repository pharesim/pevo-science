// Shared "you need to be accredited" banner used on gated authoring routes
// (publish, review, edit) for the connected+unaccredited state.
//
// Pages interpolate `${accreditationBannerTemplate(messageKey)}` into their
// own template literals. The banner reads `isConnected` and `isAccredited`
// from the parent Alpine scope via inheritance, plus `navigate(path)` and
// `$t(key)`. Pages that call this MUST expose those on their `x-data` scope.
//
// `messageKey` is the i18n key for the banner's main copy. We pass it as a
// parameter rather than hardcoding so each page can keep its own framing
// ("...to publish papers", "...to submit reviews", "...to edit this paper").
//
// Escaping note: same trap as pagination.js. The function returns a plain
// string; do NOT add ${...} or backticks inside the returned literal — keep
// dynamic bits as Alpine `x-text` / `:attr` bindings.
//
// PEvO is a filter, not a gate (see project_unaccredited_banner_not_redirect
// memory + root CLAUDE.md design principle 3): the banner appears alongside
// the page content rather than replacing or redirecting.

export function accreditationBannerTemplate(messageKey) {
  return `
        <template x-if="isConnected && !isAccredited">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('${messageKey}')"></p>
                <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary text-xs mt-2 no-underline inline-block" x-text="$t('common.getAccredited')"></a>
              </div>
            </div>
          </div>
        </template>
  `;
}
