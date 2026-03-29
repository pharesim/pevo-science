"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

const DISCORD_URL = process.env.NEXT_PUBLIC_DISCORD_URL ?? "";

export default function GettingStartedPage() {
  const t = useTranslations("gettingStarted");

  const steps = [
    {
      key: "step1",
      link: { href: "https://hive-keychain.com/", label: t("step1Link"), external: true },
      dotClass: "bg-pevo-teal",
    },
    {
      key: "step2",
      link: { href: "https://signup.hive.io/", label: t("step2Link"), external: true },
      dotClass: "bg-pevo-green",
    },
    {
      key: "step3",
      link: null,
      dotClass: "bg-pevo-crimson",
    },
    {
      key: "step4",
      link: { href: "/accreditation", label: t("step4Link"), external: false },
      dotClass: "bg-pevo-teal",
    },
    {
      key: "step5",
      link: { href: "/publish", label: t("step5Link"), external: false },
      dotClass: "bg-pevo-green",
    },
    {
      key: "step6",
      link: { href: "/search", label: t("step6Link"), external: false },
      dotClass: "bg-pevo-crimson",
    },
    {
      key: "step7",
      link: null,
      dotClass: "bg-pevo-teal",
    },
  ] as const;

  const tips = ["tip1", "tip2", "tip3", "tip4", "tip5"] as const;

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

      {/* Steps */}
      <div className="container-narrow py-10">
        <div className="space-y-8">
          {steps.map(({ key, link, dotClass }) => (
            <div key={key} className="card">
              <div className="flex items-start gap-4">
                <div className={`flex-shrink-0 w-3 h-3 rounded-full ${dotClass} mt-1.5`} />
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-ink mb-2">
                    {t(`${key}Title` as keyof typeof t)}
                  </h2>
                  <p className="text-sm text-ink-muted leading-relaxed mb-3">
                    {key === "step2" && DISCORD_URL
                      ? t.rich(`${key}Description` as any, {
                          discord: (chunks) => (
                            <a
                              href={DISCORD_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-pevo-teal hover:underline"
                            >
                              {chunks}
                            </a>
                          ),
                        })
                      : t(`${key}Description` as any)}
                  </p>
                  {link && (
                    link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-primary text-sm no-underline inline-block"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="btn-primary text-sm no-underline inline-block"
                      >
                        {link.label}
                      </Link>
                    )
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tips */}
        <div className="mt-12">
          <h2 className="text-2xl font-bold text-ink mb-6">{t("tipsTitle")}</h2>
          <div className="card">
            <ul className="space-y-3">
              {tips.map((tip) => (
                <li key={tip} className="flex items-start gap-3 text-sm text-ink-muted">
                  <svg className="w-5 h-5 text-pevo-green flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                  </svg>
                  <span>{t(tip)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
