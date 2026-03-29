interface RatingBarProps {
  label: string;
  value: number;
  max?: number;
}

export default function RatingBar({ label, value, max = 5 }: RatingBarProps) {
  const pct = (value / max) * 100;

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-28 text-ink-muted shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
        <div
          className="h-full bg-pevo-teal rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right font-medium text-ink">{value}/{max}</span>
    </div>
  );
}
