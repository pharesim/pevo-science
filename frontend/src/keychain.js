// App identity — reads from global config injected by backend or defaults
function getAppTag() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.appTag) || 'pevo';
}

function getAppVersion() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.appVersion) || '0.1';
}

function getAppId() {
  return `${getAppTag()}/${getAppVersion()}`;
}

export function isKeychainInstalled() {
  return typeof window !== 'undefined' && typeof window.hive_keychain !== 'undefined';
}

export function waitForKeychain(timeoutMs = 3000) {
  return new Promise((resolve) => {
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

export function signMessage(username, message) {
  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestSignBuffer(
      username,
      message,
      'posting',
      (response) => {
        if (response.success) {
          resolve({ signature: response.result });
        } else {
          reject(new Error(response.message));
        }
      }
    );
  });
}

export function publishPaper(username, permlink, title, body, jsonMetadata) {
  const APP_TAG = getAppTag();
  const operations = [
    [
      'comment',
      {
        parent_author: '',
        parent_permlink: APP_TAG,
        author: username,
        permlink,
        title,
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      'comment_options',
      {
        author: username,
        permlink,
        max_accepted_payout: '1000000.000 HBD',
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function postReview(username, permlink, paperAuthor, paperPermlink, body, jsonMetadata) {
  const operations = [
    [
      'comment',
      {
        parent_author: paperAuthor,
        parent_permlink: paperPermlink,
        author: username,
        permlink,
        title: '',
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      'comment_options',
      {
        author: username,
        permlink,
        max_accepted_payout: '1000000.000 HBD',
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function postComment(username, permlink, parentAuthor, parentPermlink, body) {
  const APP_TAG = getAppTag();
  const APP_ID = getAppId();
  const jsonMetadata = {
    app: APP_ID,
    tags: [APP_TAG],
    format: 'markdown',
    [APP_TAG]: {
      type: 'comment',
      version: 1,
    },
  };

  const operations = [
    [
      'comment',
      {
        parent_author: parentAuthor,
        parent_permlink: parentPermlink,
        author: username,
        permlink,
        title: '',
        body,
        json_metadata: JSON.stringify(jsonMetadata),
      },
    ],
    [
      'comment_options',
      {
        author: username,
        permlink,
        max_accepted_payout: '1000000.000 HBD',
        percent_hbd: 0,
        allow_votes: true,
        allow_curation_rewards: true,
        extensions: [],
      },
    ],
  ];

  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function broadcastVouch(username, vouchee, relationship) {
  const APP_TAG = getAppTag();
  const payload = {
    action: 'vouch',
    voucher: username,
    vouchee,
    relationship,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      'custom_json',
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
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function broadcastRetractVouch(username, vouchee, reason) {
  const APP_TAG = getAppTag();
  const payload = {
    action: 'retract_vouch',
    voucher: username,
    vouchee,
    reason,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      'custom_json',
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
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function retractPaper(username, author, permlink, reason) {
  const APP_TAG = getAppTag();
  const payload = {
    action: 'retract_paper',
    author,
    permlink,
    reason,
    timestamp: new Date().toISOString(),
  };

  const operations = [
    [
      'custom_json',
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
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestBroadcast(
      username,
      operations,
      'posting',
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}

export function vote(voter, author, permlink, weight) {
  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestVote(
      voter,
      permlink,
      author,
      weight,
      (response) => {
        if (response.success) resolve(response);
        else reject(new Error(response.message));
      }
    );
  });
}
