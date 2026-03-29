"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { submitContactForm } from "@/lib/api";
import type { ContactCategory } from "@pevo/contracts";

type Step = "idle" | "submitting" | "success" | "error";

const CATEGORIES: ContactCategory[] = ["bug", "accreditation", "keychain", "general"];
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "support@pevo.science";
const DISCORD_URL = process.env.NEXT_PUBLIC_DISCORD_URL ?? "";
const GITHUB_ISSUES_URL = process.env.NEXT_PUBLIC_GITHUB_ISSUES_URL ?? "";

export default function ContactPage() {
  const t = useTranslations("contact");
  const searchParams = useSearchParams();
  const initialCategory = CATEGORIES.includes(searchParams.get("category") as ContactCategory)
    ? (searchParams.get("category") as ContactCategory)
    : "general";

  const [category, setCategory] = useState<ContactCategory>(initialCategory);
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [step, setStep] = useState<Step>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (website) return; // honeypot triggered

    setStep("submitting");
    setErrorMessage("");

    try {
      await submitContactForm({ category, email, subject, message });
      setStep("success");
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : t("errorGeneric"));
    }
  };

  const handleReset = () => {
    setCategory("general");
    setEmail("");
    setSubject("");
    setMessage("");
    setStep("idle");
    setErrorMessage("");
  };

  const contactEmail = CONTACT_EMAIL;
  const discordUrl = DISCORD_URL;
  const githubIssuesUrl = GITHUB_ISSUES_URL;

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink mb-2">{t("title")}</h1>
      <p className="text-ink-muted mb-8">{t("description")}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Contact form */}
        <div className="md:col-span-2">
          <div className="card">
            {step === "success" ? (
              <div className="text-center py-6">
                <svg className="h-12 w-12 text-pevo-green mx-auto mb-3" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                <h2 className="text-lg font-semibold text-ink mb-1">{t("successTitle")}</h2>
                <p className="text-sm text-ink-muted mb-4">{t("successMessage")}</p>
                <button className="btn-secondary" onClick={handleReset}>
                  {t("sendAnother")}
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {step === "error" && (
                  <div className="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4">
                    <p className="text-sm font-medium text-pevo-crimson-dark">{errorMessage}</p>
                  </div>
                )}

                <div>
                  <label htmlFor="category" className="block text-sm font-medium text-ink mb-1">
                    {t("categoryLabel")}
                  </label>
                  <select
                    id="category"
                    className="select-control"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as ContactCategory)}
                  >
                    <option value="bug">{t("categoryBug")}</option>
                    <option value="accreditation">{t("categoryAccreditation")}</option>
                    <option value="keychain">{t("categoryKeychain")}</option>
                    <option value="general">{t("categoryGeneral")}</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="contact-email" className="block text-sm font-medium text-ink mb-1">
                    {t("emailLabel")}
                  </label>
                  <input
                    id="contact-email"
                    type="email"
                    className="select-control"
                    placeholder={t("emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="subject" className="block text-sm font-medium text-ink mb-1">
                    {t("subjectLabel")}
                  </label>
                  <input
                    id="subject"
                    type="text"
                    className="select-control"
                    placeholder={t("subjectPlaceholder")}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    required
                    maxLength={200}
                  />
                </div>

                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-ink mb-1">
                    {t("messageLabel")}
                  </label>
                  <textarea
                    id="message"
                    className="select-control min-h-[150px]"
                    placeholder={t("messagePlaceholder")}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                    minLength={10}
                    maxLength={5000}
                  />
                </div>

                {/* Honeypot — hidden from real users */}
                <div className="absolute -left-[9999px]" aria-hidden="true">
                  <label htmlFor="website">Website</label>
                  <input
                    id="website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={step === "submitting"}
                  >
                    {step === "submitting" ? t("submitting") : t("submitButton")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* Info sidebar */}
        <div className="space-y-4">
          <div className="card">
            <h3 className="text-sm font-semibold text-ink mb-3">{t("infoTitle")}</h3>
            <ul className="space-y-4 text-sm">
              <li>
                <p className="font-medium text-ink">{t("emailUs")}</p>
                <a href={`mailto:${contactEmail}`} className="text-pevo-teal hover:underline break-all">
                  {contactEmail}
                </a>
              </li>
              {githubIssuesUrl && (
                <li>
                  <p className="font-medium text-ink">{t("githubIssues")}</p>
                  <p className="text-ink-muted text-xs mb-1">{t("githubIssuesDesc")}</p>
                  <a
                    href={githubIssuesUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-pevo-teal hover:underline"
                  >
                    GitHub Issues
                  </a>
                </li>
              )}
              {discordUrl && (
                <li>
                  <p className="font-medium text-ink">{t("discordCommunity")}</p>
                  <p className="text-ink-muted text-xs mb-1">{t("discordDesc")}</p>
                  <a
                    href={discordUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-pevo-teal hover:underline"
                  >
                    Discord
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
