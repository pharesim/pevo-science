"use client";

import { useTranslations } from "next-intl";

interface AccreditationBadgeProps {
  isAccredited: boolean;
  className?: string;
}

export default function AccreditationBadge({
  isAccredited,
  className = "",
}: AccreditationBadgeProps) {
  const t = useTranslations("badge");

  if (!isAccredited) return null;

  return (
    <span
      className={`badge-accredited ${className}`}
      title={t("accreditedTitle")}
    >
      <svg
        className="mr-1 h-3 w-3"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
          clipRule="evenodd"
        />
      </svg>
      {t("accredited")}
    </span>
  );
}
