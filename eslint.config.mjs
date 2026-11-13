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
];
