// Hive Keychain TypeScript wrapper
// All Keychain interactions are promise-based wrappers around the callback API.

import { APP_TAG, APP_ID } from "./app-config";

export interface KeychainResponse {
  success: boolean;
  message: string;
  result: string;
  data: {
    type: string;
    username: string;
    [key: string]: unknown;
  };
  publicKey?: string;
}

interface HiveKeychain {
  requestHandshake(callback: (response: { success: boolean; message?: string }) => void): void;
  requestBroadcast(
    username: string,
    operations: unknown[][],
    keyType: string,
    callback: (response: KeychainResponse) => void
  ): void;
  requestVote(
    voter: string,
    permlink: string,
    author: string,
    weight: number,
    callback: (response: KeychainResponse) => void
  ): void;
  requestSignBuffer(
    username: string,
    message: string,
    keyType: string,
    callback: (response: KeychainResponse) => void
  ): void;
}

declare global {
  interface Window {
    hive_keychain?: HiveKeychain;
  }
}

export function isKeychainInstalled(): boolean {
  return typeof window !== "undefined" && typeof window.hive_keychain !== "undefined";
}

export function waitForKeychain(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if (isKeychainInstalled()) return resolve(true);
    const start = Date.now();
    const interval = setInterval(() => {
      if (isKeychainInstalled()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

export function signMessage(
  username: string,
  message: string
): Promise<{ signature: string }> {
  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestSignBuffer(
      username,
      message,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) {
          resolve({ signature: response.result });
        } else {
          reject(new Error(response.message));
        }
      }
    );
  });
}

export function publishPaper(
  username: string,
  permlink: string,
  title: string,
  body: string,
  jsonMetadata: Record<string, unknown>
): Promise<KeychainResponse> {
  const operations = [
    [
      "comment",
      {
        parent_author: "",
        parent_permlink: APP_TAG,
        author: username,
        permlink,
        title,
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      "comment_options",
      {
        author: username,
        permlink,
        max_accepted_payout: "1000000.000 HBD",
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function postReview(
  username: string,
  permlink: string,
  paperAuthor: string,
  paperPermlink: string,
  body: string,
  jsonMetadata: Record<string, unknown>
): Promise<KeychainResponse> {
  const operations = [
    [
      "comment",
      {
        parent_author: paperAuthor,
        parent_permlink: paperPermlink,
        author: username,
        permlink,
        title: "",
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      "comment_options",
      {
        author: username,
        permlink,
        max_accepted_payout: "1000000.000 HBD",
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function postComment(
  username: string,
  permlink: string,
  parentAuthor: string,
  parentPermlink: string,
  body: string
): Promise<KeychainResponse> {
  const jsonMetadata = {
    app: APP_ID,
    tags: [APP_TAG],
    format: "markdown",
    [APP_TAG]: {
      type: "comment",
      version: 1,
    },
  };

  const operations = [
    [
      "comment",
      {
        parent_author: parentAuthor,
        parent_permlink: parentPermlink,
        author: username,
        permlink,
        title: "",
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      "comment_options",
      {
        author: username,
        permlink,
        max_accepted_payout: "1000000.000 HBD",
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function broadcastVouch(
  username: string,
  vouchee: string,
  relationship: "colleague" | "advisor" | "collaborator"
): Promise<KeychainResponse> {
  const payload = {
    action: "vouch" as const,
    voucher: username,
    vouchee,
    relationship,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      "custom_json",
      {
        required_auths: [],
        required_posting_auths: [username],
        id: APP_TAG,
        json: JSON.stringify(payload),
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function broadcastRetractVouch(
  username: string,
  vouchee: string,
  reason: string
): Promise<KeychainResponse> {
  const payload = {
    action: "retract_vouch" as const,
    voucher: username,
    vouchee,
    reason,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      "custom_json",
      {
        required_auths: [],
        required_posting_auths: [username],
        id: APP_TAG,
        json: JSON.stringify(payload),
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function retractPaper(
  username: string,
  author: string,
  permlink: string,
  reason: string
): Promise<KeychainResponse> {
  const payload = {
    action: "retract_paper" as const,
    author,
    permlink,
    reason,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      "custom_json",
      {
        required_auths: [],
        required_posting_auths: [username],
        id: APP_TAG,
        json: JSON.stringify(payload),
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      "posting",
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function vote(
  voter: string,
  author: string,
  permlink: string,
  weight: number
): Promise<KeychainResponse> {
  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error("Hive Keychain is not installed"));
    }
    window.hive_keychain.requestVote(
      voter,
      permlink,
      author,
      weight,
      (response: KeychainResponse) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}
