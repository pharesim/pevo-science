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

export function getDiscordUrl() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.discordUrl) || '';
}

export function getGithubUrl() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.githubUrl) || '';
}

export function getMaxUploadSize() {
  return (window.__PEVO_CONFIG__ && window.__PEVO_CONFIG__.maxUploadSize) || 10 * 1024 * 1024;
}

export function getMaxUploadSizeMB() {
  return Math.round(getMaxUploadSize() / (1024 * 1024));
}
