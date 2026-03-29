/**
 * Shared formatting utilities.
 */

export function formatDate(iso: string, monthStyle: "long" | "short" = "long"): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: monthStyle,
    day: "numeric",
  });
}

export function formatDateShort(iso: string): string {
  return formatDate(iso, "short");
}
