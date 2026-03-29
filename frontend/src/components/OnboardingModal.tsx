"use client";

import { useEffect, useState, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const ONBOARDING_DISMISSED_KEY = "pevo_onboarding_dismissed";

interface OnboardingModalProps {
  /** Show the modal (typically: user just connected for the first time) */
  username: string | null;
}

export default function OnboardingModal({ username }: OnboardingModalProps) {
  const t = useTranslations("onboarding");
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: cycle focus within the modal
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      dismiss();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!username) return;
    try {
      const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY);
      if (!dismissed) {
        setOpen(true);
      }
    } catch {
      // localStorage not available
    }
  }, [username]);

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // localStorage not available
    }
  };

  // Focus first interactive element when modal opens
  useEffect(() => {
    if (open && dialogRef.current) {
      const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-modal-title"
    >
      <div ref={dialogRef} className="bg-white rounded-lg shadow-lg max-w-lg w-full p-6 sm:p-8 relative">
        {/* Close button */}
        <button
          className="absolute top-3 right-3 rtl:right-auto rtl:left-3 text-ink-muted hover:text-ink p-1"
          onClick={dismiss}
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 id="onboarding-modal-title" className="text-2xl font-bold text-ink mb-2">{t("title")}</h2>
        <p className="text-sm text-ink-muted mb-6">{t("description")}</p>

        <div className="space-y-4">
          {/* Publish */}
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-pevo-green-light flex items-center justify-center">
              <svg className="w-5 h-5 text-pevo-green" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-ink">{t("publishTitle")}</h3>
              <p className="text-xs text-ink-muted">{t("publishDescription")}</p>
            </div>
            <Link href="/publish" className="btn-primary text-xs no-underline" onClick={dismiss}>
              {t("publishButton")}
            </Link>
          </div>

          {/* Browse */}
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-pevo-teal-light flex items-center justify-center">
              <svg className="w-5 h-5 text-pevo-teal" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-ink">{t("browseTitle")}</h3>
              <p className="text-xs text-ink-muted">{t("browseDescription")}</p>
            </div>
            <Link href="/" className="btn-secondary text-xs no-underline" onClick={dismiss}>
              {t("browseButton")}
            </Link>
          </div>

          {/* Accreditation */}
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-pevo-crimson-light flex items-center justify-center">
              <svg className="w-5 h-5 text-pevo-crimson" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-ink">{t("accreditTitle")}</h3>
              <p className="text-xs text-ink-muted">{t("accreditDescription")}</p>
            </div>
            <Link href="/accreditation" className="btn-secondary text-xs no-underline" onClick={dismiss}>
              {t("accreditButton")}
            </Link>
          </div>
        </div>

        <div className="mt-6 text-center">
          <button className="text-sm text-ink-muted hover:text-pevo-teal transition-colors" onClick={dismiss}>
            {t("dismissButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
