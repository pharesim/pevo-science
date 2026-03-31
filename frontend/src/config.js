// App identity — reads from global config injected by backend or defaults
export function getAppTag() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.appTag) || 'pevo';
}

export function getAppVersion() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.appVersion) || '0.1';
}

export function getAppId() {
  return `${getAppTag()}/${getAppVersion()}`;
}
