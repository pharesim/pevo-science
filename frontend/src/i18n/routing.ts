// Locale constants — single source of truth for i18n configuration.
// Imported by request.ts (server-side locale detection) and LanguageSwitcher (client-side).

export const SUPPORTED_LOCALES = ["ar", "cs", "da", "de", "en", "es", "fa", "fr", "he", "it", "pl", "pt", "sv", "zh"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const RTL_LOCALES: readonly Locale[] = ["ar", "he", "fa"];
