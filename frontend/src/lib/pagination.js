// Guards against Math.ceil(n/0) === Infinity when a misconfigured API
// returns limit=0. Infinity is truthy, so the old `|| 1` fallback didn't
// trigger and pagination tried to render infinitely many page buttons.
export function totalPagesFromMeta(meta) {
  const pages = meta ? Math.ceil(meta.total / meta.limit) : NaN;
  return Number.isFinite(pages) && pages > 0 ? pages : 1;
}
