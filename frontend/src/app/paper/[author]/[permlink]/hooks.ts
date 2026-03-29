"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { CitationFormat, DoiResponse, PaperDetail } from "@pevo/contracts";
import { fetchCitationExport, retractPaper as retractPaperApi, fetchDoi, assignDoi, updateBridgePaper, fetchPaper } from "@/lib/api";
import { retractPaper as retractPaperKeychain } from "@/lib/keychain";
import { useToast } from "@/components/Toast";

// ─── Citation Export ──────────────────────────────────────────

export function useCitationExport(paper: PaperDetail | null) {
  const tCitation = useTranslations("citation");
  const { toast } = useToast();
  const [citeOpen, setCiteOpen] = useState(false);
  const [citeLoading, setCiteLoading] = useState(false);
  const citeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (citeRef.current && !citeRef.current.contains(e.target as Node)) {
        setCiteOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCitationExport = useCallback(async (format: CitationFormat) => {
    if (!paper) return;
    setCiteLoading(true);
    try {
      const data = await fetchCitationExport(paper.author, paper.permlink, format);
      if (format === "apa") {
        await navigator.clipboard.writeText(data.content);
        toast(tCitation("copiedToClipboard"), "success");
      } else {
        const ext = format === "bibtex" ? "bib" : "ris";
        const mimeType = format === "bibtex" ? "application/x-bibtex" : "application/x-research-info-systems";
        const blob = new Blob([data.content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${paper.permlink}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast(tCitation("downloadStarted"), "success");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tCitation("exportFailed");
      toast(message, "error");
    } finally {
      setCiteLoading(false);
      setCiteOpen(false);
    }
  }, [paper, tCitation, toast]);

  return { citeOpen, setCiteOpen, citeLoading, citeRef, handleCitationExport };
}

// ─── Retraction ──────────────────────────────────────────────

export function useRetraction(
  author: string,
  permlink: string,
  username: string | null,
  setPaper: (p: PaperDetail) => void,
) {
  const tRetraction = useTranslations("retraction");
  const { toast } = useToast();
  const [retractDialogOpen, setRetractDialogOpen] = useState(false);
  const [retractReason, setRetractReason] = useState("");
  const [retractLoading, setRetractLoading] = useState(false);

  const handleRetract = useCallback(async () => {
    if (!username) return;
    setRetractLoading(true);
    try {
      await retractPaperKeychain(username, author, permlink, retractReason);
      await retractPaperApi(author, permlink, retractReason);
      toast(tRetraction("success"), "success");
      setRetractDialogOpen(false);
      const res = await fetchPaper(author, permlink);
      setPaper(res.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : tRetraction("failed");
      toast(message, "error");
    } finally {
      setRetractLoading(false);
    }
  }, [author, permlink, username, retractReason, tRetraction, toast, setPaper]);

  return {
    retractDialogOpen, setRetractDialogOpen,
    retractReason, setRetractReason,
    retractLoading, handleRetract,
  };
}

// ─── DOI ─────────────────────────────────────────────────────

export function usePaperDoi(paper: PaperDetail | null, username: string | null) {
  const tDoi = useTranslations("doi");
  const { toast } = useToast();
  const [doiData, setDoiData] = useState<DoiResponse | null>(null);
  const [doiLoading, setDoiLoading] = useState(false);

  useEffect(() => {
    if (!paper) return;
    fetchDoi(paper.author, paper.permlink)
      .then(setDoiData)
      .catch(() => {}); // DOI is optional
  }, [paper?.author, paper?.permlink]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAssignDoi = useCallback(async () => {
    if (!paper || !username) return;
    setDoiLoading(true);
    try {
      const result = await assignDoi(paper.author, paper.permlink);
      setDoiData(result);
      toast(tDoi("assignSuccess"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tDoi("assignFailed");
      toast(message, "error");
    } finally {
      setDoiLoading(false);
    }
  }, [paper, username, tDoi, toast]);

  return { doiData, doiLoading, handleAssignDoi };
}

// ─── Bridge Sync ─────────────────────────────────────────────

export function useBridgeSync(
  author: string,
  permlink: string,
  username: string | null,
  setPaper: (p: PaperDetail) => void,
) {
  const tBridge = useTranslations("bridge");
  const { toast } = useToast();
  const [syncLoading, setSyncLoading] = useState(false);

  const handleSync = useCallback(async () => {
    if (!username) return;
    setSyncLoading(true);
    try {
      await updateBridgePaper(permlink);
      toast(tBridge("syncSuccess"), "success");
      const refreshed = await fetchPaper(author, permlink);
      setPaper(refreshed.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : tBridge("syncFailed");
      toast(msg, "error");
    } finally {
      setSyncLoading(false);
    }
  }, [author, permlink, username, tBridge, toast, setPaper]);

  return { syncLoading, handleSync };
}
