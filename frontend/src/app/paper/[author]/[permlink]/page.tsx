import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { fetchPaper } from "@/lib/api";
import PaperDetailClient from "./PaperDetailClient";

interface PaperDetailPageProps {
  params: Promise<{
    author: string;
    permlink: string;
  }>;
}

export async function generateMetadata({ params }: PaperDetailPageProps): Promise<Metadata> {
  const { author, permlink } = await params;
  try {
    const res = await fetchPaper(author, permlink);
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
  return <PaperDetailClient author={author} permlink={permlink} />;
}
