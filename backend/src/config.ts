import pino from 'pino';

if (!process.env.APP_TAG) {
  throw new Error('APP_TAG must be set in .env');
}
if (!process.env.APP_VERSION) {
  throw new Error('APP_VERSION must be set in .env');
}

const appTag = process.env.APP_TAG;
const appVersion = process.env.APP_VERSION;

if (!/^[a-z][a-z0-9._-]*$/.test(appTag)) {
  throw new Error('APP_TAG must start with a letter and contain only lowercase alphanumeric, dots, hyphens, underscores');
}

const hiveAdminAccount = process.env.HIVE_ADMIN_ACCOUNT || 'pevo.admin';
const hiveBridgeAccount = process.env.HIVE_BRIDGE_ACCOUNT || hiveAdminAccount;

// Bridge posting key: use dedicated key if set, otherwise fall back to admin key
// when bridge account is the same as admin (avoids entering the same key twice)
function resolveBridgePostingKey(): string {
  const explicit = process.env.PEVO_BRIDGE_POSTING_KEY || '';
  if (explicit) return explicit;
  if (hiveBridgeAccount === hiveAdminAccount) return process.env.PEVO_ADMIN_POSTING_KEY || '';
  throw new Error(
    `HIVE_BRIDGE_ACCOUNT (${hiveBridgeAccount}) differs from HIVE_ADMIN_ACCOUNT (${hiveAdminAccount}) ` +
    `but PEVO_BRIDGE_POSTING_KEY is not set. Either set the key or use the same account.`
  );
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  hiveApiNodes: (process.env.HIVE_API_NODES || 'https://api.hive.blog,https://api.deathwing.me,https://anyx.io')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  hafDatabaseUrl: (() => {
    if ('HAF_DATABASE_URL' in process.env) return process.env.HAF_DATABASE_URL!;
    if (process.env.NODE_ENV === 'production') {
      // Using pino directly instead of the logger module because logger imports
      // config, and importing logger here would create a circular dependency.
      pino({ level: process.env.LOG_LEVEL || 'info' }).warn('[config] HAF_DATABASE_URL not set — falling back to public HAF node (hafsql-sql.mahdiyari.info). Set HAF_DATABASE_URL for production use.');
    }
    return 'postgresql://hafsql_public:hafsql_public@hafsql-sql.mahdiyari.info:5432/haf_block_log';
  })(),
  appDatabaseUrl: process.env.APP_DATABASE_URL || '',
  ipfsApiUrl: process.env.IPFS_API_URL || 'http://ipfs:5001',
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || 'http://ipfs:8080',
  maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(10 * 1024 * 1024), 10),
  pinataApiKey: process.env.PINATA_API_KEY || '',
  pinataSecretKey: process.env.PINATA_SECRET_KEY || '',
  pevoAnonPostingKey: process.env.PEVO_ANON_POSTING_KEY || '',
  pevoAdminPostingKey: process.env.PEVO_ADMIN_POSTING_KEY || '',
  pevoBridgePostingKey: resolveBridgePostingKey(),
  anonReviewEncryptionKey: process.env.ANON_REVIEW_ENCRYPTION_KEY || '',
  anonReviewEncryptionKeyPrev: process.env.ANON_REVIEW_ENCRYPTION_KEY_PREV || '',
  anonReviewKeyVersion: parseInt(process.env.ANON_REVIEW_KEY_VERSION || '1', 10),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'noreply@pevo.science',
  contactEmail: process.env.CONTACT_EMAIL || process.env.SMTP_FROM || 'support@pevo.science',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  redisUrl: process.env.REDIS_URL || '',
  orcidClientId: process.env.ORCID_CLIENT_ID || '',
  orcidClientSecret: process.env.ORCID_CLIENT_SECRET || '',
  orcidRedirectUri: process.env.ORCID_REDIRECT_URI || '',
  orcidBaseUrl: process.env.NODE_ENV === 'production' ? 'https://orcid.org' : 'https://sandbox.orcid.org',
  dataciteRepositoryId: process.env.DATACITE_REPOSITORY_ID || '',
  datacitePassword: process.env.DATACITE_PASSWORD || '',
  dataciteDoiPrefix: process.env.DATACITE_DOI_PREFIX || '',
  dataciteApiUrl: process.env.DATACITE_API_URL || 'https://api.datacite.org',

  accreditationAuthorities: (() => {
    const extra = (process.env.ACCREDITATION_AUTHORITIES || '').split(',').map(s => s.trim()).filter(Boolean);
    return [hiveAdminAccount, ...extra];
  })(),

  sessionSecret: process.env.SESSION_SECRET ?? (() => { throw new Error('SESSION_SECRET must be set'); })(),
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || '',

  // App identity — configurable so alpha/testing uses different namespace
  hiveAdminAccount,
  hiveAnonAccount: process.env.HIVE_ANON_ACCOUNT || 'pevo.anon',
  hiveBridgeAccount,
  appTag,
  appVersion,
  appId: `${appTag}/${appVersion}`,

  // Public URLs (injected into frontend via __PEVO_CONFIG__)
  discordUrl: process.env.DISCORD_URL || '',
  githubUrl: process.env.GITHUB_URL || '',
};
