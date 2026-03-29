"use client";

import { useState, useEffect, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

interface UsernameModalProps {
  open: boolean;
  onConfirm: (username: string) => void;
  onCancel: () => void;
}

export default function UsernameModal({ open, onConfirm, onCancel }: UsernameModalProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: cycle focus within the modal
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      // Small delay so the DOM is rendered before focusing
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  const handleConfirm = useCallback(() => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      setError("Username cannot be empty.");
      return;
    }
    if (trimmed !== trimmed.toLowerCase() || trimmed !== value.trim().toLowerCase()) {
      // Already lowercased above, this is just defensive
      setError("Username must be lowercase.");
      return;
    }
    onConfirm(trimmed);
  }, [value, onConfirm]);

  // Keyboard support
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="username-modal-title"
    >
      <div ref={dialogRef} className="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 id="username-modal-title" className="text-lg font-semibold text-ink mb-4">Enter your Hive username</h2>

        <label htmlFor="hive-username-input" className="sr-only">Hive username</label>
        <input
          id="hive-username-input"
          ref={inputRef}
          type="text"
          className="w-full px-3 py-2 border border-parchment-dark rounded-md text-sm text-ink focus:outline-none focus:ring-2 focus:ring-pevo-teal focus:border-transparent"
          placeholder="e.g. satoshi"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleConfirm();
            }
          }}
        />

        {error && (
          <p className="text-sm text-pevo-crimson mt-1">{error}</p>
        )}

        <p className="text-sm text-ink/60 mt-3">
          Don&apos;t have an account?{" "}
          <a href="/getting-started" className="text-pevo-teal hover:underline font-medium">
            Get started
          </a>
        </p>

        <div className="flex justify-end gap-3 mt-5">
          <button
            type="button"
            className="btn-secondary text-sm px-4 py-2"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary text-sm px-4 py-2"
            onClick={handleConfirm}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
