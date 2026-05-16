import Alpine from 'alpinejs';

/**
 * Broadcast operations to Hive, routing to either Keychain or the
 * custodial broadcast endpoint based on the session's custody claim.
 *
 * For light accounts the backend requires a single-use `fresh_auth_proof`
 * on every call (consent and non-consent). Callers MUST mint one via
 * `mintNonConsentProof()` (non-consent bundles) or the consent-op flow
 * (consent bundles) and pass it as `opts.freshAuthProof`. The optionality
 * at the JS API level is a migration affordance and will tighten once all
 * call sites are wired; Keychain (self-custody) does not need a proof.
 *
 * @param {string} username
 * @param {Array} operations - Array of [opType, opBody] tuples
 * @param {object|string} [opts] - Options object, or legacy keyType string ('posting'|'active')
 * @param {string} [opts.freshAuthProof] - Single-use proof token (light-account only)
 * @param {string} [opts.keyType='posting'] - Keychain key type (self-custody only)
 * @returns {Promise<{tx_id?: string, block_num?: number, outcome?: string}>}
 */
export async function broadcastOps(username, operations, opts = {}) {
  // Back-compat: third arg used to be a bare keyType string.
  const { freshAuthProof, keyType = 'posting' } =
    typeof opts === 'string' ? { keyType: opts } : opts;
  const auth = Alpine.store('auth');

  if (auth.custody === 'light') {
    const body = { operations };
    if (freshAuthProof) body.fresh_auth_proof = freshAuthProof;
    const res = await fetch('/api/custody/broadcast', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      const err = new Error(respBody.error?.message || respBody.error || 'Broadcast failed');
      err.status = res.status;
      err.code = respBody.error?.code;
      err.details = respBody.error?.details;
      throw err;
    }
    return res.json();
  }

  // Keychain path: vote operations use requestVote, everything else uses requestBroadcast
  if (operations.length === 1 && operations[0][0] === 'vote') {
    const op = operations[0][1];
    return new Promise((resolve, reject) => {
      if (!window.hive_keychain) {
        return reject(new Error('Hive Keychain is not installed'));
      }
      window.hive_keychain.requestVote(
        op.voter,
        op.permlink,
        op.author,
        op.weight,
        (response) => {
          if (response.success) resolve(response);
          else reject(new Error(response.message));
        }
      );
    });
  }

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      keyType,
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}
