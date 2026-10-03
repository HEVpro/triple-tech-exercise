import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import perfectionist from 'eslint-plugin-perfectionist'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const CONSOLE_BAN = {
  message:
    'console is banned. Use the shared logger from src/logger.ts in src/, or process.stdout.write in scripts/.',
  name: 'console',
}

const DOMAIN_FORBIDDEN_PACKAGES = {
  group: [
    'pg',
    'drizzle-orm',
    'hono',
    '@hono/*',
    'pino',
    'prom-client',
    'node:*',
    'fs',
    'path',
    'os',
  ],
  message: 'src/domain must stay pure: no infrastructure, no I/O, no runtime globals.',
}

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'docs/**/*.md'],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['commitlint.config.js', 'eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports', prefer: 'type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowBoolean: true, allowNumber: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-implicit-coercion': 'error',
      'no-restricted-globals': ['error', CONSOLE_BAN],
      'no-return-await': 'error',
      'prefer-const': 'error',
      'require-await': 'error',
    },
  },

  {
    name: 'perfectionist/sorting',
    plugins: { perfectionist },
    rules: {
      'perfectionist/sort-enums': 'error',
      'perfectionist/sort-imports': 'error',
      'perfectionist/sort-interfaces': 'error',
      'perfectionist/sort-modules': 'error',
      'perfectionist/sort-named-imports': 'error',
      'perfectionist/sort-objects': 'error',
      'perfectionist/sort-union-types': 'error',
    },
  },

  {
    files: ['src/domain/**/*.ts'],
    name: 'layering/domain',
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DOMAIN_FORBIDDEN_PACKAGES,
            {
              group: ['**/infrastructure/**', '**/http/**', '**/worker/**', '**/config/**'],
              message: 'src/domain must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/application/**/*.ts'],
    name: 'layering/application',
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/**', '**/worker/**'],
              message: 'src/application must not depend on delivery layers.',
            },
          ],
        },
      ],
    },
  },

  prettierConfig,
)
