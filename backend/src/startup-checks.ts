import { config } from './config.js';
import { logger } from './logger.js';

interface EnvCheck {
  key: string;
  value: string;
  required: boolean;
  description: string;
}

export function validateConfig(): void {
  const checks: EnvCheck[] = [
    { key: 'HAF_DATABASE_URL', value: config.hafDatabaseUrl, required: false, description: 'HAF SQL (primary data source)' },
    { key: 'APP_DATABASE_URL', value: config.appDatabaseUrl, required: false, description: 'App database (tokens, mappings)' },
    { key: 'PEVO_ADMIN_POSTING_KEY', value: config.pevoAdminPostingKey, required: false, description: `Posting key for admin account (${config.hiveAdminAccount}) — accreditation & bridge posting disabled without it` },
    { key: 'PEVO_ANON_POSTING_KEY', value: config.pevoAnonPostingKey, required: false, description: `Posting key for anon account (${config.hiveAnonAccount}) — anonymous reviews disabled without it` },
    { key: 'ANON_REVIEW_ENCRYPTION_KEY', value: config.anonReviewEncryptionKey, required: false, description: 'Anonymous review encryption — anonymous reviews disabled without it' },
    { key: 'PINATA_API_KEY', value: config.pinataApiKey, required: false, description: 'IPFS pinning' },
    { key: 'PINATA_SECRET_KEY', value: config.pinataSecretKey, required: false, description: 'IPFS pinning' },
    { key: 'SMTP_HOST', value: config.smtpHost, required: false, description: 'Email verification' },
  ];

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const check of checks) {
    if (!check.value) {
      if (check.required) {
        missing.push(`  ${check.key} — ${check.description}`);
      } else {
        warnings.push(`  ${check.key} — ${check.description} (feature disabled)`);
      }
    }
  }

  // Validate encryption key format if present
  if (config.anonReviewEncryptionKey) {
    if (!/^[0-9a-f]{64}$/i.test(config.anonReviewEncryptionKey)) {
      missing.push('  ANON_REVIEW_ENCRYPTION_KEY — must be 64 hex characters (256-bit key)');
    }
  }

  // Validate previous encryption key format if present (for key rotation)
  if (config.anonReviewEncryptionKeyPrev) {
    if (!/^[0-9a-f]{64}$/i.test(config.anonReviewEncryptionKeyPrev)) {
      missing.push('  ANON_REVIEW_ENCRYPTION_KEY_PREV — must be 64 hex characters (256-bit key)');
    }
  }

  // In production, APP_URL should be explicitly set (not the default localhost)
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && (!config.appUrl || config.appUrl === 'http://localhost:3000')) {
    warnings.push('  APP_URL — should be set to the real frontend URL in production');
  }

  if (warnings.length > 0) {
    logger.warn('Optional config not set:\n' + warnings.join('\n'));
  }

  if (missing.length > 0) {
    logger.error('Required config missing:\n' + missing.join('\n'));
    process.exit(1);
  }
}
