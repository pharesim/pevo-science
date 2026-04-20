import { signMessage } from './keychain.js';
import { getAppTag } from './config.js';
import { sha256Hex } from './crypto.js';

/**
 * Build a request-bound Keychain signature for an authenticated API call.
 *
 * Signs the message `{APP_TAG}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}`,
 * which binds the signature to this specific deployment, endpoint, body, and 60s window
 * so it cannot be replayed across dApps, deployments, endpoints, or time.
 *
 * The body hash is always computed over `JSON.stringify(bodyObject ?? {})` to match
 * the backend's `JSON.stringify(req.body || {})`. For GET/HEAD the serialized body is
 * still hashed but not sent on the wire.
 */
export async function signRequest(username, method, path, bodyObject) {
  const timestamp = new Date().toISOString();
  const bodyForHash = JSON.stringify(bodyObject ?? {});
  const bodyHash = await sha256Hex(bodyForHash);
  const message = `${getAppTag()}-auth|v1|${method}|${path}|${bodyHash}|${timestamp}`;
  const { signature } = await signMessage(username, message);

  const methodAllowsBody = method !== 'GET' && method !== 'HEAD';
  return {
    headers: {
      'X-Hive-Username': username,
      'X-Hive-Signature': signature,
      'X-Hive-Timestamp': timestamp,
    },
    body: methodAllowsBody ? bodyForHash : undefined,
  };
}
