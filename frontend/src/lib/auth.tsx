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
import { setSessionTokenGetter } from "./api";
import UsernameModal from "@/components/UsernameModal";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface AuthState {
  username: string | null;
  isConnected: boolean;
  isKeychainInstalled: boolean;
  isLoading: boolean;
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

  useEffect(() => {
    waitForKeychain(3000).then((installed) => {
      setKeychainInstalled(installed);
      setIsLoading(false);
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
      }

      // If signMessage succeeds, the user controls this account
      setUsername(inputUsername);
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

  const disconnect = useCallback(() => {
    setUsername(null);
    tokenRef.current = null;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        username,
        isConnected: username !== null,
        isKeychainInstalled: keychainInstalled,
        isLoading,
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
