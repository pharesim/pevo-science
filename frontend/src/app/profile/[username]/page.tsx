"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { Profile, PaperSummary, NotificationPreferences, DigestFrequency } from "@pevo/contracts";
import { fetchProfile, fetchProfilePapers, fetchNotificationPreferences, updateNotificationPreferences } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/Toast";
import AccreditationBadge from "@/components/AccreditationBadge";
import PaperCard from "@/components/PaperCard";
import VouchSection from "@/components/VouchSection";
import ProfileSkeleton from "@/components/skeletons/ProfileSkeleton";

interface ProfilePageProps {
  params: Promise<{
    username: string;
  }>;
}

import { formatDate } from "@/lib/format";

function ReputationBreakdownBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 sm:gap-3 text-sm">
      <span className="w-20 sm:w-28 text-ink-muted shrink-0 capitalize text-xs sm:text-sm">{label.replace(/_/g, " ")}</span>
      <div className="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
        <div
          className="h-full bg-pevo-teal rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right font-medium text-ink">{value}</span>
    </div>
  );
}

export default function ProfilePage({ params }: ProfilePageProps) {
  const { username } = use(params);
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const tDigest = useTranslations("digest");
  const { isConnected, username: currentUser } = useAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [userPapers, setUserPapers] = useState<PaperSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Notification preferences (only for own profile)
  const isOwnProfile = isConnected && currentUser === username;
  const [, setPrefs] = useState<NotificationPreferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsEmail, setPrefsEmail] = useState("");
  const [prefsDigest, setPrefsDigest] = useState(false);
  const [prefsFrequency, setPrefsFrequency] = useState<DigestFrequency>("weekly");

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      fetchProfile(username).then((res) => res.data),
      fetchProfilePapers(username)
        .then((res) => res.data)
        .catch(() => [] as PaperSummary[]),
    ])
      .then(([profileData, papers]) => {
        setProfile(profileData);
        setUserPapers(papers);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : t("loadFailed");
        setError(message);
      })
      .finally(() => setLoading(false));
  }, [username]);

  // Load notification preferences for own profile
  useEffect(() => {
    if (!isOwnProfile || !currentUser) return;
    setPrefsLoading(true);
    fetchNotificationPreferences(currentUser)
      .then((data) => {
        setPrefs(data);
        setPrefsEmail(data.email ?? "");
        setPrefsDigest(data.email_digest);
        setPrefsFrequency(data.digest_frequency);
      })
      .catch((err) => {
        // 404 = prefs don't exist yet (expected); other errors deserve feedback
        const status = err?.response?.status ?? err?.status;
        if (status !== 404) {
          toast(err instanceof Error ? err.message : tDigest("saveFailed"), "error");
        }
      })
      .finally(() => setPrefsLoading(false));
  }, [isOwnProfile, currentUser, toast]);

  const handleSavePrefs = async () => {
    if (!currentUser) return;
    setPrefsSaving(true);
    try {
      const updated = await updateNotificationPreferences(currentUser, {
        email_digest: prefsDigest,
        digest_frequency: prefsFrequency,
        email: prefsEmail || null,
      });
      setPrefs(updated);
      toast(tDigest("saved"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tDigest("saveFailed");
      toast(message, "error");
    } finally {
      setPrefsSaving(false);
    }
  };

  if (loading) {
    return <ProfileSkeleton />;
  }

  if (error || !profile) {
    return (
      <div className="container-narrow py-8">
        <div className="card text-center py-12">
          <h1 className="text-2xl font-bold text-ink mb-2">{t("notFoundTitle")}</h1>
          <p className="text-ink-muted mb-4">
            {error ?? t("notFoundDescription", { username: username })}
          </p>
          <Link href="/" className="btn-primary">
            {tCommon("backToPapers")}
          </Link>
        </div>
      </div>
    );
  }

  const maxBreakdownValue = Math.max(
    ...Object.values(profile.reputation.breakdown)
  );

  return (
    <div className="container-narrow py-8">
      {/* Profile header */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-ink">
                {profile.accreditation?.name ?? `@${profile.username}`}
              </h1>
              <AccreditationBadge isAccredited={profile.is_accredited} />
            </div>
            <p className="text-sm text-ink-muted">@{profile.username}</p>
            {profile.accreditation && (
              <div className="mt-2 text-sm text-ink-light">
                <p>{profile.accreditation.institution}</p>
                <p className="capitalize">{profile.accreditation.field}</p>
              </div>
            )}
          </div>

          {/* Reputation score */}
          <div className="text-center sm:text-right">
            <div className="text-4xl font-bold text-ink font-serif">
              {profile.reputation.score}
            </div>
            <div className="text-xs text-ink-muted mt-1">{t("reputationScore")}</div>
          </div>
        </div>

        {profile.accreditation && (
          <div className="mt-4 pt-4 border-t border-parchment-dark text-xs text-ink-muted flex items-center gap-2 flex-wrap">
            <span>
              {t("accreditedVia", {
                method: profile.accreditation.method,
                date: formatDate(profile.accreditation.timestamp),
              })}
              {profile.accreditation.field && (
                <span> -- field: <span className="capitalize">{profile.accreditation.field}</span></span>
              )}
            </span>
            {profile.accreditation.method === "orcid" && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[#A6CE39]/15 border border-[#A6CE39]/30 px-2 py-0.5 text-xs font-medium text-[#6B8E23]"
                title="Verified via ORCID"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M256 128C256 198.692 198.692 256 128 256C57.3076 256 0 198.692 0 128C0 57.3076 57.3076 0 128 0C198.692 0 256 57.3076 256 128Z" fill="#A6CE39"/>
                  <path d="M86.3 186.2H70.9V79.1H86.3V186.2ZM78.6 56.1C73.5 56.1 69.4 60.2 69.4 65.3C69.4 70.4 73.5 74.5 78.6 74.5C83.7 74.5 87.8 70.4 87.8 65.3C87.8 60.2 83.7 56.1 78.6 56.1ZM108.5 79.1H150.3C185 79.1 200.5 102.7 200.5 132.6C200.5 165.2 181.5 186.2 150.3 186.2H108.5V79.1ZM124 172.5H148.6C175.2 172.5 184.6 153.3 184.6 132.6C184.6 110.6 173.8 92.8 148.6 92.8H124V172.5Z" fill="white"/>
                </svg>
                ORCID
              </span>
            )}
          </div>
        )}
      </div>

      {/* Stats + Reputation breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Quick stats */}
        <div className="card">
          <h2 className="text-section-title text-ink font-serif mb-4">{t("activity")}</h2>
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-ink font-serif">
                {profile.stats.paper_count}
              </div>
              <div className="text-xs text-ink-muted mt-1">{t("papers")}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-ink font-serif">
                {profile.stats.review_count}
              </div>
              <div className="text-xs text-ink-muted mt-1">{t("reviews")}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-ink font-serif">
                {profile.stats.citation_count}
              </div>
              <div className="text-xs text-ink-muted mt-1">{t("citationsLabel")}</div>
            </div>
          </div>
          {profile.stats.first_pevo_post && (
          <div className="mt-4 pt-3 border-t border-parchment-dark text-xs text-ink-muted">
            {t("firstPost", { date: formatDate(profile.stats.first_pevo_post) })}
          </div>
          )}
        </div>

        {/* Reputation breakdown */}
        <div className="card">
          <h2 className="text-section-title text-ink font-serif mb-4">
            {t("reputationBreakdown")}
          </h2>
          <div className="space-y-2">
            {Object.entries(profile.reputation.breakdown).map(([key, value]) => (
              <ReputationBreakdownBar
                key={key}
                label={key}
                value={value}
                max={maxBreakdownValue}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Web of Trust */}
      <div className="mb-8">
        <VouchSection
          targetUsername={profile.username}
          isTargetAccredited={profile.is_accredited}
        />
      </div>

      {/* Email Digest Preferences (own profile only) */}
      {isOwnProfile && (
        <div className="card mb-8">
          <h2 className="text-section-title text-ink font-serif mb-4">{tDigest("title")}</h2>
          {prefsLoading ? (
            <p className="text-sm text-ink-muted">{tCommon("loading")}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  id="email-digest"
                  type="checkbox"
                  className="h-4 w-4 rounded border-parchment-dark text-pevo-teal focus:ring-pevo-teal"
                  checked={prefsDigest}
                  onChange={(e) => setPrefsDigest(e.target.checked)}
                />
                <label htmlFor="email-digest" className="text-sm text-ink">
                  {tDigest("enableDigest")}
                </label>
              </div>

              {prefsDigest && (
                <>
                  <div>
                    <label htmlFor="digest-email" className="block text-sm font-medium text-ink mb-1">
                      {tDigest("emailLabel")}
                    </label>
                    <input
                      id="digest-email"
                      type="email"
                      className="select-control max-w-sm"
                      placeholder={tDigest("emailPlaceholder")}
                      value={prefsEmail}
                      onChange={(e) => setPrefsEmail(e.target.value)}
                    />
                  </div>

                  <div>
                    <label htmlFor="digest-frequency" className="block text-sm font-medium text-ink mb-1">
                      {tDigest("frequencyLabel")}
                    </label>
                    <select
                      id="digest-frequency"
                      className="select-control max-w-xs"
                      value={prefsFrequency}
                      onChange={(e) => setPrefsFrequency(e.target.value as DigestFrequency)}
                    >
                      <option value="daily">{tDigest("daily")}</option>
                      <option value="weekly">{tDigest("weekly")}</option>
                    </select>
                  </div>
                </>
              )}

              <button
                type="button"
                className="btn-primary text-sm"
                onClick={handleSavePrefs}
                disabled={prefsSaving}
              >
                {prefsSaving ? tDigest("saving") : tDigest("saveButton")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* User's papers */}
      <section>
        <h2 className="text-section-title text-ink font-serif mb-4">
          {t("publications", { count: userPapers.length })}
        </h2>
        {userPapers.length > 0 ? (
          <div className="space-y-4">
            {userPapers.map((paper) => (
              <PaperCard key={`${paper.author}/${paper.permlink}`} paper={paper} />
            ))}
          </div>
        ) : (
          <div className="card text-center py-8">
            <p className="text-ink-muted">{t("noPapers")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
