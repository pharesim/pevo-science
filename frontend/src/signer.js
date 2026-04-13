import Alpine from 'alpinejs';

/**
 * Broadcast operations to Hive, routing to either Keychain or the
 * custodial broadcast endpoint based on the session's custody claim.
 *
 * @param {string} username - Hive username performing the operations
 * @param {Array} operations - Array of [opType, opBody] tuples
 * @param {string} [keyType='posting'] - Keychain key type (ignored for light accounts)
 * @returns {Promise<{tx_id?: string, block_num?: number}>}
 */
export async function broadcastOps(username, operations, keyType = 'posting') {
  const auth = Alpine.store('auth');

  if (auth.custody === 'light') {
    const res = await fetch('/api/custody/broadcast', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operations }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Broadcast failed');
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
