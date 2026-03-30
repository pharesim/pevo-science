import { cache } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { fetchPaper } from "@/lib/api";
import PaperDetailClient from "./PaperDetailClient";

const getCachedPaper = cache((author: string, permlink: string) =>
  fetchPaper(author, permlink)
);

interface PaperDetailPageProps {
  params: Promise<{
    author: string;
    permlink: string;
  }>;
}

export async function generateMetadata({ params }: PaperDetailPageProps): Promise<Metadata> {
  const { author, permlink } = await params;
  try {
    const res = await getCachedPaper(author, permlink);
    return {
      title: res.data.title,
      description: res.data.body.slice(0, 200),
    };
  } catch {
    const t = await getTranslations("nav");
    return {
      title: t("papers"),
    };
  }
}

export default async function PaperDetailPage({ params }: PaperDetailPageProps) {
  const { author, permlink } = await params;

  // Fetch server-side so the client component doesn't need a second request.
  // On failure, pass null — the client will show an error state.
  let initialData = null;
  try {
    const res = await getCachedPaper(author, permlink);
    initialData = res.data;
  } catch {
    // Client will handle error display
  }

  return (
    <PaperDetailClient
      author={author}
      permlink={permlink}
      initialData={initialData}
    />
  );
}
