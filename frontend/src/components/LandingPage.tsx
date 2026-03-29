"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { PlatformStats } from "@pevo/contracts";
import { fetchPlatformStats } from "@/lib/api";
export default function LandingPage() {
  const t = useTranslations("landing");
  const tc = useTranslations("common");

  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    fetchPlatformStats()
      .then((res) => setStats(res.data))
      .catch(() => {
        // Non-critical
      })
      .finally(() => setStatsLoading(false));
  }, []);

  return (
    <div>
      {/* Hero Section */}
      <section className="relative bg-white border-b border-parchment-dark overflow-hidden">
        <div className="absolute inset-0 geo-pattern opacity-60" />
        <div className="container-narrow relative py-16 sm:py-24">
          <div className="flex flex-col sm:flex-row items-center gap-10">
            <div className="flex-1 max-w-xl">
              <h1 className="text-4xl sm:text-5xl font-bold text-ink mb-5 leading-tight">
                {tc.rich("heroTitle", {
                  highlight: (chunks) => (
                    <span className="text-pevo-teal">{chunks}</span>
                  ),
                })}
              </h1>
              <p className="text-lg text-ink-muted mb-8 leading-relaxed">
                {tc("heroDescription")}
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/getting-started" className="btn-primary no-underline">
                  {t("publishPaper")}
                </Link>
                <Link href="/search" className="btn-secondary no-underline">
                  {t("browsePapers")}
                </Link>
              </div>
            </div>
            <div className="shrink-0 hidden md:block">
              <Image
                src="/images/pevo-logo.png"
                alt="PEvO"
                width={200}
                height={200}
                className="opacity-90"
                priority
              />
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="bg-parchment py-16 sm:py-20">
        <div className="container-narrow">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-ink mb-3">{t("howItWorksTitle")}</h2>
            <p className="text-ink-muted max-w-2xl mx-auto">
              {t("howItWorksDescription")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Step 1: Publish */}
            <div className="card text-center">
              <div className="w-14 h-14 rounded-full bg-pevo-green-light flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-pevo-green" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{t("step1Title")}</h3>
              <p className="text-sm text-ink-muted leading-relaxed">{t("step1Description")}</p>
            </div>

            {/* Step 2: Review */}
            <div className="card text-center">
              <div className="w-14 h-14 rounded-full bg-pevo-teal-light flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-pevo-teal" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{t("step2Title")}</h3>
              <p className="text-sm text-ink-muted leading-relaxed">{t("step2Description")}</p>
            </div>

            {/* Step 3: Build Reputation */}
            <div className="card text-center">
              <div className="w-14 h-14 rounded-full bg-pevo-crimson-light flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-pevo-crimson" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{t("step3Title")}</h3>
              <p className="text-sm text-ink-muted leading-relaxed">{t("step3Description")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Why PEvO? */}
      <section className="bg-white py-16 sm:py-20 border-b border-parchment-dark">
        <div className="container-narrow">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-ink mb-3">{t("whyPevoTitle")}</h2>
            <p className="text-ink-muted max-w-2xl mx-auto">
              {t("whyPevoDescription")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {([
              { key: "noPaywalls", dotClass: "bg-pevo-green" },
              { key: "transparentReview", dotClass: "bg-pevo-teal" },
              { key: "noGatekeepers", dotClass: "bg-pevo-crimson" },
              { key: "immutableRecord", dotClass: "bg-pevo-green" },
              { key: "openSource", dotClass: "bg-pevo-teal" },
              { key: "decentralized", dotClass: "bg-pevo-crimson" },
            ] as const).map(({ key, dotClass }) => (
              <div key={key} className="card">
                <div className={`w-2 h-2 rounded-full ${dotClass} mb-3`} />
                <h3 className="text-sm font-semibold text-ink mb-1">
                  {t(key)}
                </h3>
                <p className="text-sm text-ink-muted leading-relaxed">
                  {t(`${key}Desc` as keyof typeof t)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Platform Stats */}
      <section className="bg-parchment py-16 sm:py-20">
        <div className="container-narrow">
          <h2 className="text-3xl font-bold text-ink text-center mb-10">{t("statsTitle")}</h2>

          {statsLoading ? (
            <p className="text-center text-ink-muted">{t("statsLoading")}</p>
          ) : stats ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl mx-auto">
              <div className="card text-center">
                <p className="text-3xl font-bold text-pevo-teal mb-1">{stats.total_papers}</p>
                <p className="text-sm text-ink-muted">{t("statsPapers")}</p>
              </div>
              <div className="card text-center">
                <p className="text-3xl font-bold text-pevo-green mb-1">{stats.total_reviews}</p>
                <p className="text-sm text-ink-muted">{t("statsReviews")}</p>
              </div>
              <div className="card text-center">
                <p className="text-3xl font-bold text-pevo-crimson mb-1">{stats.total_accredited_researchers}</p>
                <p className="text-sm text-ink-muted">{t("statsResearchers")}</p>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* CTA */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 geo-pattern opacity-40" />
        <div className="container-narrow relative py-16 sm:py-20 text-center">
          <h2 className="text-3xl font-bold text-ink mb-4">{t("ctaTitle")}</h2>
          <p className="text-ink-muted max-w-xl mx-auto mb-8">
            {t("ctaDescription")}
          </p>
          <Link href="/getting-started" className="btn-primary no-underline">
            {t("ctaButton")}
          </Link>
        </div>
      </section>
    </div>
  );
}
