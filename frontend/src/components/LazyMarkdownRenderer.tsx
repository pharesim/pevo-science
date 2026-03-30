"use client";

import dynamic from "next/dynamic";

const MarkdownRenderer = dynamic(() => import("./MarkdownRenderer"), {
  ssr: false,
  loading: () => (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-parchment-warm rounded w-full" />
      <div className="h-4 bg-parchment-warm rounded w-5/6" />
      <div className="h-4 bg-parchment-warm rounded w-4/5" />
      <div className="h-4 bg-parchment-warm rounded w-full" />
      <div className="h-4 bg-parchment-warm rounded w-3/4" />
    </div>
  ),
});

export default MarkdownRenderer;
