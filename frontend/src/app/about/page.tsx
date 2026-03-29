import type { Metadata } from "next";
import Image from "next/image";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "About",
};

export default async function AboutPage() {
  const t = await getTranslations("about");

  return (
    <div className="container-narrow py-8">
      {/* Hero */}
      <div className="relative rounded-xl overflow-hidden mb-10">
        <Image
          src="/images/hero-banner.png"
          alt="The Future of Scientific Publishing - pevo.science"
          width={960}
          height={540}
          className="w-full h-auto"
          priority
        />
      </div>

      <div className="max-w-reading mx-auto">
        <h1 className="text-3xl font-bold text-ink mb-6">{t("title")}</h1>

        <div className="prose prose-ink space-y-8 text-ink-light text-[0.95rem] leading-relaxed">
          <section>
            <h2 className="text-section-title text-ink font-serif mt-0">
              {t("whatIsTitle")}
            </h2>
            <p>
              {t.rich("whatIsDescription", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </section>

          <section>
            <h2 className="text-section-title text-ink font-serif">
              {t("whyTitle")}
            </h2>
            <p>
              {t("whyDescription")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 not-prose">
              <div className="rounded-lg bg-pevo-teal-light border border-pevo-teal/20 p-4">
                <p className="text-sm font-semibold text-pevo-teal mb-1">{t("noPaywalls")}</p>
                <p className="text-xs text-ink-muted">{t("noPaywallsDesc")}</p>
              </div>
              <div className="rounded-lg bg-pevo-green-light border border-pevo-green/20 p-4">
                <p className="text-sm font-semibold text-pevo-green-dark mb-1">{t("transparentReview")}</p>
                <p className="text-xs text-ink-muted">{t("transparentReviewDesc")}</p>
              </div>
              <div className="rounded-lg bg-pevo-crimson-light border border-pevo-crimson/20 p-4">
                <p className="text-sm font-semibold text-pevo-crimson mb-1">{t("noGatekeepers")}</p>
                <p className="text-xs text-ink-muted">{t("noGatekeepersDesc")}</p>
              </div>
              <div className="rounded-lg bg-parchment-warm border border-parchment-dark p-4">
                <p className="text-sm font-semibold text-ink mb-1">{t("immutableRecord")}</p>
                <p className="text-xs text-ink-muted">{t("immutableRecordDesc")}</p>
              </div>
            </div>
          </section>

          {/* Infographic: How it works */}
          <section className="not-prose">
            <h2 className="text-section-title text-ink font-serif mb-4">
              {t("howItWorks")}
            </h2>
            <div className="rounded-xl overflow-hidden border border-parchment-dark">
              <Image
                src="/images/infographic-publishing.jpg"
                alt="PEvO publishing process - comparing traditional publishing with the PEvO open science approach"
                width={960}
                height={680}
                className="w-full h-auto"
              />
            </div>
            <p className="text-xs text-ink-muted mt-2 text-center">
              {t("howItWorksCaption")}
            </p>
          </section>

          <section>
            <h2 className="text-section-title text-ink font-serif">
              {t("processTitle")}
            </h2>
            <ul className="space-y-4 list-none pl-0">
              <li className="flex gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-green text-white text-sm font-bold shrink-0">1</span>
                <div>
                  <strong className="text-ink">{t("step1Title")}</strong>{" "}
                  {t("step1Desc")}
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-teal text-white text-sm font-bold shrink-0">2</span>
                <div>
                  <strong className="text-ink">{t("step2Title")}</strong>{" "}
                  {t("step2Desc")}
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-crimson text-white text-sm font-bold shrink-0">3</span>
                <div>
                  <strong className="text-ink">{t("step3Title")}</strong>{" "}
                  {t("step3Desc")}
                </div>
              </li>
            </ul>
          </section>

          {/* Architecture infographic */}
          <section className="not-prose">
            <h2 className="text-section-title text-ink font-serif mb-4">
              {t("architectureTitle")}
            </h2>
            <div className="rounded-xl overflow-hidden border border-parchment-dark">
              <Image
                src="/images/infographic-architecture.jpg"
                alt="PEvO architecture - Hive network, IPFS storage, and the PEvO frontend"
                width={960}
                height={680}
                className="w-full h-auto"
              />
            </div>
            <p className="text-xs text-ink-muted mt-2 text-center">
              {t("architectureCaption")}
            </p>
          </section>

          <section>
            <h2 className="text-section-title text-ink font-serif">
              {t("accreditationTitle")}
            </h2>
            <p>
              {t("accreditationDesc")}
            </p>
          </section>

          <section>
            <h2 className="text-section-title text-ink font-serif">
              {t("openSourceTitle")}
            </h2>
            <p>
              {t("openSourceDesc")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
