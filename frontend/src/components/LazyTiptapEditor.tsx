"use client";

import dynamic from "next/dynamic";
import type { TiptapEditorProps } from "./TiptapEditor";

function EditorSkeleton({ variant }: { variant?: "full" | "abstract" }) {
  const minH = variant === "abstract" ? "min-h-[120px]" : "min-h-[280px]";
  return (
    <div className="border border-parchment-dark rounded-lg overflow-hidden bg-white animate-pulse">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-parchment-dark bg-parchment">
        {Array.from({ length: variant === "abstract" ? 4 : 8 }).map((_, i) => (
          <div key={i} className="h-6 w-10 bg-parchment-warm rounded" />
        ))}
      </div>
      {/* Editor area skeleton */}
      <div className={`${minH} px-4 py-3 space-y-3`}>
        <div className="h-4 bg-parchment-warm rounded w-3/4" />
        <div className="h-4 bg-parchment-warm rounded w-1/2" />
        {variant !== "abstract" && (
          <>
            <div className="h-4 bg-parchment-warm rounded w-5/8" />
            <div className="h-4 bg-parchment-warm rounded w-2/3" />
          </>
        )}
      </div>
    </div>
  );
}

const TiptapEditor = dynamic(() => import("./TiptapEditor"), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

export default function LazyTiptapEditor(props: TiptapEditorProps) {
  return <TiptapEditor {...props} />;
}
