"use client";

import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";

const DISCORD_URL = process.env.NEXT_PUBLIC_DISCORD_URL ?? "";

export default function Footer() {
  const t = useTranslations("footer");
  const tNav = useTranslations("nav");

  return (
    <footer className="border-t border-parchment-dark bg-white mt-auto">
      <div className="container-narrow py-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Image
                src="/images/pevo-logo.png"
                alt="PEvO logo"
                width={28}
                height={28}
                className="rounded-sm"
              />
              <span className="text-lg font-bold text-ink">pevo</span>
            </div>
            <p className="text-sm text-ink-muted leading-relaxed">
              {t("description")}
            </p>
            <p className="text-xs text-pevo-teal mt-2 font-medium">
              {t("tagline")}
            </p>
          </div>

          {/* Links */}
          <div>
            <p className="font-sans text-sm font-semibold text-ink mb-3">
              {t("platform")}
            </p>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("paperFeed")}
                </Link>
              </li>
              <li>
                <Link href="/publish" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("publishPaper")}
                </Link>
              </li>
              <li>
                <Link href="/accreditation" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {tNav("accreditation")}
                </Link>
              </li>
              <li>
                <Link href="/about" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("aboutPevo")}
                </Link>
              </li>
              <li>
                <Link href="/getting-started" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("gettingStarted")}
                </Link>
              </li>
              <li>
                <Link href="/faq" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("faq")}
                </Link>
              </li>
              <li>
                <Link href="/contact" className="text-ink-muted hover:text-pevo-teal no-underline">
                  {t("contact")}
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <p className="font-sans text-sm font-semibold text-ink mb-3">
              {t("resources")}
            </p>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href="https://github.com/pharesim/pevo-science"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-muted hover:text-pevo-teal no-underline"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://hive.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-muted hover:text-pevo-teal no-underline"
                >
                  Hive Network
                </a>
              </li>
              <li>
                <a
                  href="https://hive-keychain.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-muted hover:text-pevo-teal no-underline"
                >
                  Hive Keychain
                </a>
              </li>
              {DISCORD_URL && (
                <li>
                  <a
                    href={DISCORD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink-muted hover:text-pevo-teal no-underline"
                  >
                    {t("discord")}
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* Bottom bar with brand gradient */}
        <div className="mt-8 pt-4 border-t border-parchment-dark flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">
            {t("license")}
          </p>
          <a
            href="https://hive.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-pevo-teal no-underline"
          >
            <Image
              src="/images/hive-logo.svg"
              alt="Hive logo"
              width={16}
              height={16}
              style={{ width: 16, height: 'auto' }}
            />
            Powered by Hive
          </a>
          <p className="text-xs text-ink-muted">
            pevo.science
          </p>
        </div>
      </div>
      {/* Bottom brand bar */}
      <div className="h-1 bg-gradient-to-r from-pevo-green via-pevo-teal to-pevo-crimson" />
    </footer>
  );
}
