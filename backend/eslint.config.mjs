// Minimal ESLint config — safety-focused, not stylistic.
//
// Only the four rules called out in BE-ENABLE-ESLINT-TS-RULES are active.
// Broader rule sets (airbnb / strict / recommended) are deliberately NOT
// enabled: the codebase pragmatically leaks `any` at Express/dhive/pg
// boundaries, and a full opinionated config would drown the signal from
// the one rule that actually matters here:
//
// - @typescript-eslint/no-floating-promises (error): burnSentinel and
//   withOrcidBindingLock return Promise<void>; a fire-and-forget caller
//   silently reopens the timing oracle / lock window those helpers exist to
//   close. Hand review cannot reliably catch this; the rule does.
//
// - @typescript-eslint/no-explicit-any (warn): keeps new `any` visible without
//   blocking existing boundary code.
//
// Frontend has its own tooling; this config is backend-scoped.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  tseslint.configs.base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
