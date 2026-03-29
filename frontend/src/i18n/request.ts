import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./routing";

export default getRequestConfig(async () => {
  // 1. Cookie (set by LanguageSwitcher)
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  if (cookieLocale && (SUPPORTED_LOCALES as readonly string[]).includes(cookieLocale)) {
    return {
      locale: cookieLocale,
      messages: (await import(`../../messages/${cookieLocale}.json`)).default,
    };
  }

  // 2. Accept-Language header (best match from supported locales)
  const headerStore = await headers();
  const acceptLang = headerStore.get("accept-language") ?? "";
  const preferred = acceptLang
    .split(",")
    .map((s) => s.split(";")[0].trim().split("-")[0]);
  const matched = preferred.find((l) =>
    (SUPPORTED_LOCALES as readonly string[]).includes(l)
  );
  const locale = matched ?? DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
