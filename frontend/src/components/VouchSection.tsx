"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { VouchStatus } from "@pevo/contracts";
import { fetchVouchStatus, notifyVouch, notifyRetractVouch } from "@/lib/api";
import { broadcastVouch, broadcastRetractVouch } from "@/lib/keychain";
import { useAuth } from "@/lib/auth";

type VouchStep = "idle" | "signing" | "success" | "error";
type Relationship = "colleague" | "advisor" | "collaborator";

import { formatDateShort as formatDate } from "@/lib/format";

interface VouchSectionProps {
  targetUsername: string;
  isTargetAccredited: boolean;
}

export default function VouchSection({ targetUsername, isTargetAccredited }: VouchSectionProps) {
  const t = useTranslations("wot");
  const { username, isConnected } = useAuth();
  const [vouchStatus, setVouchStatus] = useState<VouchStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<VouchStep>("idle");
  const [relationship, setRelationship] = useState<Relationship>("colleague");
  const [retractReason, setRetractReason] = useState("");
  const [showRetract, setShowRetract] = useState(false);
  const [message, setMessage] = useState("");

  const relationshipLabel = useCallback((r: string): string => {
    switch (r) {
      case "colleague":
        return t("colleague");
      case "advisor":
        return t("advisor");
      case "collaborator":
        return t("collaborator");
      default:
        return r;
    }
  }, [t]);

  const loadVouchStatus = useCallback(async () => {
    try {
      const res = await fetchVouchStatus(targetUsername);
      setVouchStatus(res.data);
    } catch {
      setVouchStatus(null);
    } finally {
      setLoading(false);
    }
  }, [targetUsername]);

  useEffect(() => {
    loadVouchStatus();
  }, [loadVouchStatus]);

  const currentUserHasVouched =
    vouchStatus?.vouches.some((v) => v.voucher === username) ?? false;

  const canVouch =
    isConnected &&
    username !== targetUsername &&
    !currentUserHasVouched &&
    !isTargetAccredited;

  const canRetract =
    isConnected && currentUserHasVouched;

  const handleVouch = async () => {
    if (!username) return;
    setStep("signing");
    setMessage("");
    try {
      await broadcastVouch(username, targetUsername, relationship);
      try {
        const res = await notifyVouch(targetUsername);
        const accMsg = res.data.accredited
          ? ` ${t("accreditedViaWot", { username: targetUsername })}`
          : "";
        setStep("success");
        setMessage(`${t("vouchSuccess")}${accMsg}`);
      } catch {
        setStep("success");
        setMessage(t("vouchBroadcastPending"));
      }
      await loadVouchStatus();
    } catch (err) {
      setStep("error");
      setMessage(err instanceof Error ? err.message : t("vouchFailed"));
    }
  };

  const handleRetract = async () => {
    if (!username) return;
    setStep("signing");
    setMessage("");
    try {
      await broadcastRetractVouch(username, targetUsername, retractReason || "Retracted");
      try {
        const res = await notifyRetractVouch(targetUsername);
        const revocations = res.data.revocations;
        const revMsg = revocations.length > 0
          ? ` ${t("accreditationRevoked", { accounts: revocations.join(", ") })}`
          : "";
        setStep("success");
        setMessage(`${t("retractSuccess")}${revMsg}`);
      } catch {
        setStep("success");
        setMessage(t("retractBroadcastPending"));
      }
      setShowRetract(false);
      setRetractReason("");
      await loadVouchStatus();
    } catch (err) {
      setStep("error");
      setMessage(err instanceof Error ? err.message : t("retractFailed"));
    }
  };

  if (isTargetAccredited && !vouchStatus) return null;
  if (loading) return null;

  return (
    <div className="card">
      <h2 className="text-section-title text-ink font-serif mb-4">
        {t("title")}
      </h2>

      {/* Vouch progress */}
      {vouchStatus && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-ink-muted">
              {t("vouches", { count: vouchStatus.vouch_count, threshold: vouchStatus.threshold })}
            </span>
            {vouchStatus.eligible && (
              <span className="text-xs font-medium text-pevo-green-dark bg-pevo-green-light px-2 py-0.5 rounded-full">
                {t("thresholdMet")}
              </span>
            )}
          </div>
          <div className="h-2 bg-parchment-warm rounded-full overflow-hidden">
            <div
              className="h-full bg-pevo-teal rounded-full transition-all"
              style={{
                width: `${Math.min(100, (vouchStatus.vouch_count / vouchStatus.threshold) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Existing vouches */}
      {vouchStatus && vouchStatus.vouches.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
            {t("vouchedBy")}
          </h3>
          <div className="space-y-2">
            {vouchStatus.vouches.map((v) => (
              <div
                key={v.voucher}
                className="flex items-center justify-between text-sm bg-parchment-warm/50 rounded-md px-3 py-2"
              >
                <div>
                  <Link
                    href={`/profile/${v.voucher}`}
                    className="text-pevo-teal hover:underline font-medium"
                  >
                    @{v.voucher}
                  </Link>
                  <span className="text-ink-muted ml-2">
                    ({relationshipLabel(v.relationship)})
                  </span>
                </div>
                <span className="text-xs text-ink-muted">
                  {formatDate(v.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status messages */}
      {step === "success" && (
        <div className="bg-pevo-green-light border border-pevo-green/30 rounded-lg p-3 mb-4">
          <p className="text-sm text-pevo-green-dark">{message}</p>
        </div>
      )}
      {step === "error" && (
        <div className="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-3 mb-4">
          <p className="text-sm text-pevo-crimson-dark">{message}</p>
        </div>
      )}

      {/* Vouch form */}
      {canVouch && (
        <div className="border-t border-parchment-dark pt-4">
          <p className="text-sm text-ink-muted mb-3">
            {t("vouchPrompt")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              className="rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-pevo-teal"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value as Relationship)}
            >
              <option value="colleague">{t("colleague")}</option>
              <option value="advisor">{t("advisor")}</option>
              <option value="collaborator">{t("collaborator")}</option>
            </select>
            <button
              className="btn-primary text-sm"
              onClick={handleVouch}
              disabled={step === "signing"}
            >
              {step === "signing" ? t("signing") : t("vouchButton")}
            </button>
          </div>
        </div>
      )}

      {/* Retract vouch */}
      {canRetract && !showRetract && (
        <div className="border-t border-parchment-dark pt-4">
          <button
            className="text-sm text-pevo-crimson hover:underline"
            onClick={() => setShowRetract(true)}
          >
            {t("retractVouch")}
          </button>
        </div>
      )}
      {canRetract && showRetract && (
        <div className="border-t border-parchment-dark pt-4">
          <p className="text-sm text-ink-muted mb-2">
            {t("retractConfirm")}
          </p>
          <input
            type="text"
            className="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-light focus:outline-none focus:ring-2 focus:ring-pevo-teal mb-3"
            placeholder={t("retractReasonPlaceholder")}
            value={retractReason}
            onChange={(e) => setRetractReason(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn-primary bg-pevo-crimson hover:bg-pevo-crimson-dark text-sm"
              onClick={handleRetract}
              disabled={step === "signing"}
            >
              {step === "signing" ? t("signing") : t("confirmRetract")}
            </button>
            <button
              className="btn-secondary text-sm"
              onClick={() => {
                setShowRetract(false);
                setRetractReason("");
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Not connected hint */}
      {!isConnected && !isTargetAccredited && (
        <p className="text-xs text-ink-muted mt-2">
          {t("connectToVouch")}
        </p>
      )}
    </div>
  );
}
