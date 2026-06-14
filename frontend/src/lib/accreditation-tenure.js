// Tenure ("accredited since") anchor accessor.
//
// The backend exposes the earliest-accredit chain block time as
// `accredited_since`. Tenure reads that anchor so a metadata re-broadcast (which
// advances the latest-op `timestamp`) does not reset the displayed date.
// Response surfaces that do not yet carry the anchor fall back to the latest-op
// `timestamp` so the date keeps rendering.
//
// Centralized so the anchor field name lives in one place across the three
// tenure surfaces (accreditation page, profile page, researcher directory). The
// silent `|| timestamp` fallback would otherwise mask a backend field rename
// across three files: with the read in one place, a rename is a one-line edit
// here, and the tenure tests assert against this single accessor.
//
// `acc` is the accreditation-shaped object that carries the date fields — the
// accreditation status object on the accreditation/profile pages, or a
// researcher-directory row (which carries `accredited_since`/`timestamp` at top
// level) on the researchers page.
export function getAccreditedSince(acc) {
  if (!acc) return null;
  return acc.accredited_since || acc.timestamp || null;
}
