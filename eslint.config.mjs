import CodeX from 'eslint-config-codex';

export default [
  ...CodeX,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['eslint.config.mjs', 'vitest*.config.ts', '**/*.test.ts', 'src/test-support/**'],
    rules: {
      'n/no-unpublished-import': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Same selectors as eslint-config-codex, plus environment variable
      // names (UPPER_SNAKE) among external property names it already allows.
      '@typescript-eslint/naming-convention': ['error',
        {
          selector: 'default',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow',
        },
        { selector: 'typeLike',
          format: ['PascalCase'] },
        { selector: 'typeParameter',
          format: ['StrictPascalCase'] },
        { selector: 'enumMember',
          format: ['PascalCase'] },
        {
          selector: 'property',
          format: ['camelCase'],
          filter: { regex: '^(?!(2xx|2[0-9][0-9]|application/json|[A-Z][A-Z0-9_]*)$).*',
            match: true },
        },
        {
          selector: 'property',
          format: null,
          filter: { regex: '^(2xx|2[0-9][0-9]|application/json|[A-Z][A-Z0-9_]*)$',
            match: true },
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'src/test-support/**'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },
  {
    // node:sqlite is still flagged experimental by the plugin but is the chosen store.
    files: ['**/*.ts'],
    rules: {
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['sqlite'] }],
    },
  },
];
