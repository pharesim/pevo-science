"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SUPPORTED_LOCALES } from "@/i18n/routing";

export default function LanguageSwitcher() {
  const t = useTranslations("locale");
  const currentLocale = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (locale: string) => {
    document.cookie = `NEXT_LOCALE=${locale};path=/;max-age=31536000`;
    setOpen(false);
    window.location.reload();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded-md border border-parchment-dark bg-white px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-pevo-teal"
        aria-label="Language"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {t(currentLocale)}
        <span className="ml-1">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Language"
          className="absolute end-0 z-50 mt-1 grid w-64 grid-cols-2 gap-1 rounded-md border border-parchment-dark bg-white p-2 shadow-lg"
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              role="option"
              aria-selected={locale === currentLocale}
              onClick={() => handleSelect(locale)}
              className={`rounded px-3 py-1.5 text-start text-xs whitespace-nowrap ${
                locale === currentLocale
                  ? "bg-pevo-teal/10 font-medium text-pevo-teal"
                  : "text-ink hover:bg-parchment-light"
              }`}
            >
              {t(locale)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
