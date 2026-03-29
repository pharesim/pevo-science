"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { useNotifications } from "@/lib/notifications";
import NotificationPanel from "./NotificationPanel";
import LanguageSwitcher from "./LanguageSwitcher";
import { useToast } from "@/components/Toast";

export default function Header() {
  const t = useTranslations();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const { username, isConnected, isKeychainInstalled, isLoading, connect, disconnect } = useAuth();
  const { unreadCount } = useNotifications();
  const { toast } = useToast();
  const toggleNotif = useCallback(() => setNotifOpen((v) => !v), []);

  // Close "More" dropdown on outside click
  useEffect(() => {
    if (!moreOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

  const PRIMARY_LINKS = useMemo(() => [
    { href: "/", label: t("nav.papers") },
    { href: "/search", label: t("nav.search") },
    { href: "/researchers", label: t("nav.researchers") },
    { href: "/publish", label: t("nav.publish") },
  ], [t]);

  const MORE_LINKS = useMemo(() => [
    ...(isConnected ? [{ href: "/bridge", label: t("bridge.navLabel") }] : []),
    { href: "/accreditation", label: t("nav.accreditation") },
    { href: "/stats", label: t("nav.stats") },
    { href: "/getting-started", label: t("nav.gettingStarted") },
    { href: "/faq", label: t("nav.faq") },
    { href: "/about", label: t("nav.about") },
  ], [t, isConnected]);

  const ALL_LINKS = useMemo(() => [...PRIMARY_LINKS, ...MORE_LINKS], [PRIMARY_LINKS, MORE_LINKS]);

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("common.connectionFailed");
      toast(message, "error");
    }
  };

  return (
    <header className="border-b border-parchment-dark bg-white">
      {/* Thin brand accent bar */}
      <div className="h-1 bg-gradient-to-r rtl:bg-gradient-to-l from-pevo-green via-pevo-teal to-pevo-crimson" />

      <div className="container-narrow">
        <div className="flex h-16 items-center justify-between">
          {/* Logo / Brand */}
          <Link href="/" className="flex items-center gap-2.5 no-underline">
            <Image
              src="/images/pevo-logo.png"
              alt="PEvO logo"
              width={36}
              height={36}
              className="rounded-sm"
            />
            <div className="flex flex-col">
              <span className="text-lg font-bold text-ink leading-tight tracking-tight">
                pevo
              </span>
              <span className="hidden sm:block text-[10px] text-ink-muted leading-tight">
                {t("header.tagline")}
              </span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <nav aria-label="Main navigation" className="hidden md:flex items-center gap-6">
            {PRIMARY_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-ink-light hover:text-pevo-teal no-underline transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <div ref={moreRef} className="relative">
              <button
                className="text-sm font-medium text-ink-light hover:text-pevo-teal transition-colors flex items-center gap-1"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="true"
              >
                {t("nav.more")}
                <svg className={`w-3.5 h-3.5 transition-transform ${moreOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
              {moreOpen && (
                <div className="absolute top-full right-0 rtl:right-auto rtl:left-0 mt-2 w-48 rounded-md border border-parchment-dark bg-white py-1 shadow-lg z-50">
                  {MORE_LINKS.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="block px-4 py-2 text-sm text-ink-light hover:text-pevo-teal hover:bg-pevo-teal-light no-underline transition-colors"
                      onClick={() => setMoreOpen(false)}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </nav>

          {/* Auth Controls */}
          <div className="hidden md:flex items-center gap-3">
            <LanguageSwitcher />
            {isLoading ? (
              <span className="text-sm text-ink-muted">{t("header.loading")}</span>
            ) : !isKeychainInstalled ? (
              <a
                href="https://hive-keychain.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm no-underline"
              >
                {t("header.installKeychain")}
              </a>
            ) : isConnected ? (
              <>
                <div className="relative">
                  <button
                    className="relative p-1.5 text-ink-muted hover:text-pevo-teal transition-colors"
                    onClick={toggleNotif}
                    aria-label="Notifications"
                    aria-expanded={notifOpen}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
                    </svg>
                    {unreadCount > 0 && (
                      <span aria-live="polite" className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-pevo-crimson px-1 text-[10px] font-bold text-white">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                  </button>
                  <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
                </div>
                <Link
                  href={`/profile/${username}`}
                  className="text-sm font-medium text-pevo-teal no-underline hover:text-pevo-teal-dark"
                >
                  @{username}
                </Link>
                <button className="btn-secondary text-sm" onClick={disconnect}>
                  {t("header.disconnect")}
                </button>
              </>
            ) : (
              <button className="btn-primary text-sm" onClick={handleConnect}>
                {t("header.connectWallet")}
              </button>
            )}
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 text-ink-muted hover:text-ink"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
          >
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
            >
              {mobileMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav aria-label="Mobile navigation" className="md:hidden border-t border-parchment-dark py-4 space-y-2">
            {ALL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block px-2 py-2 text-sm font-medium text-ink-light hover:text-pevo-teal hover:bg-pevo-teal-light rounded no-underline"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-2 px-2 flex items-center gap-2 mb-2">
              <LanguageSwitcher />
            </div>
            <div className="pt-2 px-2">
              {isLoading ? (
                <span className="text-sm text-ink-muted">{t("header.loading")}</span>
              ) : !isKeychainInstalled ? (
                <a
                  href="https://hive-keychain.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary text-sm w-full block text-center no-underline"
                >
                  {t("header.installKeychain")}
                </a>
              ) : isConnected ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Link
                      href={`/profile/${username}`}
                      className="block text-sm font-medium text-pevo-teal no-underline"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      @{username}
                    </Link>
                    <div className="relative">
                      <button
                        className="relative p-1.5 text-ink-muted hover:text-pevo-teal transition-colors"
                        onClick={toggleNotif}
                        aria-label="Notifications"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
                        </svg>
                        {unreadCount > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-pevo-crimson px-1 text-[10px] font-bold text-white">
                            {unreadCount > 99 ? "99+" : unreadCount}
                          </span>
                        )}
                      </button>
                      <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
                    </div>
                  </div>
                  <button
                    className="btn-secondary text-sm w-full"
                    onClick={() => {
                      disconnect();
                      setMobileMenuOpen(false);
                    }}
                  >
                    {t("header.disconnect")}
                  </button>
                </div>
              ) : (
                <button
                  className="btn-primary text-sm w-full"
                  onClick={async () => {
                    setMobileMenuOpen(false);
                    await handleConnect();
                  }}
                >
                  {t("header.connectWallet")}
                </button>
              )}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
