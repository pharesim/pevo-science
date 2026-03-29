/**
 * Base skeleton components for loading placeholder states.
 * All variants use Tailwind's animate-pulse with bg-gray-200 rounded.
 */

interface SkeletonProps {
  className?: string;
}

/** Generic pulsing block — use className to set width/height. */
export function SkeletonBlock({ className = "" }: SkeletonProps) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

/** Single line of text. Default h-4, full width. */
export function SkeletonText({ className = "" }: SkeletonProps) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded h-4 w-full ${className}`} />
  );
}

/** Round avatar placeholder. Default w-10 h-10. */
export function SkeletonAvatar({ className = "" }: SkeletonProps) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded-full w-10 h-10 ${className}`} />
  );
}

/** Card-shaped placeholder with internal shimmer lines. */
export function SkeletonCard({ className = "", children }: SkeletonProps & { children?: React.ReactNode }) {
  return (
    <div className={`card ${className}`}>
      {children ?? (
        <div className="space-y-3">
          <SkeletonText className="h-5 w-3/4" />
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-5/6" />
          <SkeletonText className="h-4 w-2/3" />
        </div>
      )}
    </div>
  );
}
