"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const FAQ_ITEMS = [
  "q1", "q2", "q3", "q4", "q5", "q6",
  "q7", "q8", "q9", "q10", "q11", "q12",
] as const;

export default function FAQPage() {
  const t = useTranslations("faq");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggle = (idx: number) => {
    setOpenIndex((prev) => (prev === idx ? null : idx));
  };

  return (
    <div>
      {/* Header */}
      <section className="relative bg-white border-b border-parchment-dark overflow-hidden">
        <div className="absolute inset-0 geo-pattern opacity-60" />
        <div className="container-narrow relative py-12 sm:py-16">
          <h1 className="text-3xl sm:text-4xl font-bold text-ink mb-3">{t("title")}</h1>
          <p className="text-lg text-ink-muted max-w-2xl">{t("description")}</p>
        </div>
      </section>

      {/* FAQ Items */}
      <div className="container-narrow py-10">
        <div className="space-y-3">
          {FAQ_ITEMS.map((qKey, idx) => {
            const aKey = qKey.replace("q", "a") as `a${typeof qKey extends `q${infer N}` ? N : never}`;
            const isOpen = openIndex === idx;

            return (
              <div key={qKey} className="card p-0 overflow-hidden">
                <button
                  className="w-full flex items-center justify-between p-5 text-left hover:bg-parchment transition-colors"
                  onClick={() => toggle(idx)}
                  aria-expanded={isOpen}
                >
                  <span className="text-sm font-semibold text-ink pr-4">
                    {t(qKey)}
                  </span>
                  <svg
                    className={`w-5 h-5 text-ink-muted flex-shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="1.5"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
                {isOpen && (
                  <div className="px-5 pb-5 border-t border-parchment-dark">
                    <p className="text-sm text-ink-muted leading-relaxed pt-4">
                      {t(aKey)}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Contact CTA */}
        <div className="card p-6 text-center mt-8">
          <p className="text-lg font-semibold text-ink mb-2">{t("ctaTitle")}</p>
          <p className="text-sm text-ink-muted mb-4">{t("ctaDescription")}</p>
          <Link href="/contact" className="btn-primary inline-block">
            {t("ctaButton")}
          </Link>
        </div>
      </div>
    </div>
  );
}
