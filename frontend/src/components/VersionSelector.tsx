"use client";

import { useTranslations } from "next-intl";
import type { PaperVersion } from "@pevo/contracts";

interface VersionSelectorProps {
  versions: PaperVersion[];
  currentVersion: number;
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function VersionSelector({ versions, currentVersion }: VersionSelectorProps) {
  const t = useTranslations("versions");

  if (versions.length <= 1) return null;

  const sorted = [...versions].sort((a, b) => a.version_number - b.version_number);
  const latest = sorted[sorted.length - 1];

  return (
    <div className="space-y-2">
      {/* Version pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-muted">{t("label")}:</span>
        {sorted.map((v) => {
          const isCurrent = v.version_number === currentVersion;
          const isLatest = v.version_number === latest.version_number;

          return (
            <span
              key={v.version_number}
              className={`
                inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full
                border
                ${isCurrent
                  ? "bg-pevo-teal text-white border-pevo-teal"
                  : "bg-parchment-warm text-ink-muted border-parchment-dark"
                }
              `}
              title={t("versionWithDate", {
                number: String(v.version_number),
                date: formatShortDate(v.created),
              })}
            >
              <span>v{v.version_number}</span>
              <span className="hidden sm:inline text-[0.65rem] opacity-75">
                {formatShortDate(v.created)}
              </span>
              {!v.is_content_revision && (
                <span
                  className={`text-[0.6rem] italic ${
                    isCurrent ? "text-white/70" : "text-ink-muted"
                  }`}
                  title={t("metadataOnly")}
                >
                  {t("metadataOnlyShort")}
                </span>
              )}
              {isLatest && (
                <span
                  className={`text-[0.6rem] font-semibold uppercase tracking-wide ${
                    isCurrent ? "text-white/80" : "text-pevo-teal"
                  }`}
                >
                  {t("latest")}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
