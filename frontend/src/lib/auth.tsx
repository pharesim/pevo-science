"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  waitForKeychain,
  isKeychainInstalled,
  signMessage,
} from "./keychain";
import { setSessionTokenGetter, fetchAccreditationStatus } from "./api";
import type { Accreditation } from "@pevo/contracts";
import UsernameModal from "@/components/UsernameModal";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface AuthState {
  username: string | null;
  isConnected: boolean;
  isKeychainInstalled: boolean;
  isLoading: boolean;
  isAccredited: boolean;
  accreditation: Accreditation | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Returns the current session JWT, or null if not logged in */
  getSessionToken: () => string | null;
}

const AuthContext = createContext<AuthState>({
  username: null,
  isConnected: false,
  isKeychainInstalled: false,
  isLoading: true,
  isAccredited: false,
  accreditation: null,
  connect: async () => {},
  disconnect: () => {},
  getSessionToken: () => null,
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [keychainInstalled, setKeychainInstalled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [isAccredited, setIsAccredited] = useState(false);
  const [accreditation, setAccreditation] = useState<Accreditation | null>(null);
  const tokenRef = useRef<string | null>(null);

  // Store resolve/reject callbacks for the connect promise
  const pendingRef = useRef<{
    resolve: (value: void) => void;
    reject: (reason: Error) => void;
  } | null>(null);

  // Wire up session token getter for the API client
  useEffect(() => {
    setSessionTokenGetter(() => tokenRef.current);
  }, []);

  // Restore session from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pevo_session");
      if (saved) {
        const { token, username: savedUser, expiresAt, isAccredited: savedAccredited, accreditation: savedAccreditation } = JSON.parse(saved);
        if (token && savedUser && new Date(expiresAt) > new Date()) {
          tokenRef.current = token;
          setUsername(savedUser);
          setIsAccredited(savedAccredited ?? false);
          setAccreditation(savedAccreditation ?? null);
        } else {
          localStorage.removeItem("pevo_session");
        }
      }
    } catch {
      localStorage.removeItem("pevo_session");
    }
    // Session restore is done — UI can render logged-in state immediately
    setIsLoading(false);
  }, []);

  // Detect Keychain in background (doesn't block UI)
  useEffect(() => {
    waitForKeychain(3000).then((installed) => {
      setKeychainInstalled(installed);
    });
  }, []);

  const connect = useCallback(async () => {
    if (!isKeychainInstalled()) {
      throw new Error("Hive Keychain is not installed");
    }

    // Show modal and wait for user input
    return new Promise<void>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      setModalOpen(true);
    });
  }, []);

  const handleModalConfirm = useCallback(async (inputUsername: string) => {
    setModalOpen(false);
    const pending = pendingRef.current;
    pendingRef.current = null;

    try {
      // Verify account ownership with a random challenge
      const challenge = `pevo-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { signature } = await signMessage(inputUsername, challenge);

      // Exchange the Keychain signature for a session JWT
      const timestamp = new Date().toISOString();
      const res = await fetch(`${BASE_URL}/api/auth/session`, {
        method: "POST",
        headers: {
          "X-Hive-Username": inputUsername,
          "X-Hive-Signature": signature,
          "X-Hive-Message": challenge,
          "X-Hive-Timestamp": timestamp,
        },
      });
      if (res.ok) {
        const body = await res.json();
        tokenRef.current = body.data.token;

        // Show logged-in state immediately, fetch accreditation in background
        setUsername(inputUsername);
        try {
          localStorage.setItem("pevo_session", JSON.stringify({
            token: body.data.token,
            username: inputUsername,
            expiresAt: body.data.expires_at,
            isAccredited: false,
            accreditation: null,
          }));
        } catch { /* storage full or blocked */ }

        // Fetch accreditation status in background (non-blocking)
        fetchAccreditationStatus(inputUsername).then((accRes) => {
          const accreditedFlag = accRes.data.is_accredited;
          const accreditationData = accRes.data.accreditation;
          setIsAccredited(accreditedFlag);
          setAccreditation(accreditationData);
          try {
            localStorage.setItem("pevo_session", JSON.stringify({
              token: body.data.token,
              username: inputUsername,
              expiresAt: body.data.expires_at,
              isAccredited: accreditedFlag,
              accreditation: accreditationData,
            }));
          } catch { /* storage full or blocked */ }
        }).catch(() => { /* non-critical — default to unaccredited */ });
      }

      pending?.resolve();
    } catch (err) {
      pending?.reject(err instanceof Error ? err : new Error("Sign failed"));
    }
  }, []);

  const handleModalCancel = useCallback(() => {
    setModalOpen(false);
    const pending = pendingRef.current;
    pendingRef.current = null;
    // Resolve (not reject) on cancel — same behavior as the old window.prompt returning null
    pending?.resolve();
  }, []);

  const getSessionToken = useCallback((): string | null => {
    return tokenRef.current;
  }, []);

  // Check accreditation status immediately + poll every 60s while not yet accredited
  useEffect(() => {
    if (!username || isAccredited) return;
    const check = async () => {
      try {
        const accRes = await fetchAccreditationStatus(username);
        if (accRes.data.is_accredited) {
          setIsAccredited(true);
          setAccreditation(accRes.data.accreditation);
          try {
            const saved = localStorage.getItem("pevo_session");
            if (saved) {
              const session = JSON.parse(saved);
              session.isAccredited = true;
              session.accreditation = accRes.data.accreditation;
              localStorage.setItem("pevo_session", JSON.stringify(session));
            }
          } catch { /* noop */ }
        }
      } catch { /* non-critical */ }
    };
    check();
    const interval = setInterval(check, 60_000);
    return () => clearInterval(interval);
  }, [username, isAccredited]);

  const disconnect = useCallback(() => {
    setUsername(null);
    setIsAccredited(false);
    setAccreditation(null);
    tokenRef.current = null;
    try { localStorage.removeItem("pevo_session"); } catch { /* noop */ }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        username,
        isConnected: username !== null,
        isKeychainInstalled: keychainInstalled,
        isLoading,
        isAccredited,
        accreditation,
        connect,
        disconnect,
        getSessionToken,
      }}
    >
      {children}
      <UsernameModal
        open={modalOpen}
        onConfirm={handleModalConfirm}
        onCancel={handleModalCancel}
      />
    </AuthContext.Provider>
  );
}
