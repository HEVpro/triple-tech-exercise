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

// ---------------------------------------------------------------------------------------------
// Domain architecture (AGENTS.md, "Domain structure").
//
// src/domain is split into blocks. Each block is a folder whose index.ts is its public API.
// Three rules keep it that way:
//   1. Outside a block, only its index.ts may be imported (DOMAIN_PUBLIC_API_ONLY and the
//      relative-path variant inside domainBlock).
//   2. Blocks depend on each other in one direction only (DOMAIN_BLOCK_DEPENDENCIES).
//   3. Zod is allowed in the events block only.
// To add a block: create the folder with an index.ts and add one line below.
// ---------------------------------------------------------------------------------------------

// Which blocks each block may import. Anything not listed is a lint error. The resulting
// direction is: shared <- money, deadline <- rules <- events <- dispute.
/** @type {Record<string, readonly string[]>} */
const DOMAIN_BLOCK_DEPENDENCIES = {
  deadline: ['shared'],
  dispute: ['shared', 'money', 'deadline', 'rules', 'events'],
  events: ['shared', 'rules'],
  money: ['shared'],
  rules: ['shared', 'deadline'],
  shared: [],
}

const DOMAIN_BLOCKS_WITH_ZOD = new Set(['events'])

// From anywhere outside src/domain: `.../domain/<block>/<file>` is only allowed for index.js.
const DOMAIN_PUBLIC_API_ONLY = {
  message: 'Import a domain block through its index.ts, never one of its internal files.',
  regex: String.raw`(^|/)domain/[^/]+/(?!index\.js$)[^/]+$`,
}

const DOMAIN_OUTER_LAYERS = {
  group: [
    '**/infrastructure/**',
    '**/http/**',
    '**/worker/**',
    '**/config/**',
    '**/application/**',
  ],
  message: 'src/domain must not depend on outer layers.',
}

// ESLint replaces, rather than merges, a rule's options when several config objects match the
// same file, so each block's config restates the domain-wide restrictions.
/**
 * @param {string} block
 * @param {readonly string[]} allowed
 */
function domainBlock(block, allowed) {
  const forbidden = Object.keys(DOMAIN_BLOCK_DEPENDENCIES).filter(
    (other) => other !== block && !allowed.includes(other),
  )
  const patterns = [
    DOMAIN_FORBIDDEN_PACKAGES,
    DOMAIN_OUTER_LAYERS,
    {
      message: `Import another domain block through its index.ts (../<block>/index.js).`,
      regex: String.raw`^\.\./(?!\.\.)[^/]+/(?!index\.js$)`,
    },
  ]
  if (forbidden.length > 0) {
    patterns.push({
      message: `src/domain/${block} may only depend on: ${allowed.length > 0 ? allowed.join(', ') : 'nothing'}.`,
      regex: String.raw`^\.\./(${forbidden.join('|')})/`,
    })
  }
  if (!DOMAIN_BLOCKS_WITH_ZOD.has(block)) {
    patterns.push({
      group: ['zod'],
      message: `Zod belongs to the events block only (events/schemas.ts).`,
    })
  }
  return {
    files: [`src/domain/${block}/**/*.ts`],
    name: `domain/${block}`,
    rules: { 'no-restricted-imports': ['error', { patterns }] },
  }
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
    // Inline `eslint-disable` comments are ignored, so a rule cannot be switched off from a
    // source file. Exceptions belong in this config, where they are reviewed.
    linterOptions: {
      noInlineConfig: true,
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
    files: ['**/*.ts'],
    name: 'layering/domain-public-api',
    rules: { 'no-restricted-imports': ['error', { patterns: [DOMAIN_PUBLIC_API_ONLY] }] },
  },

  {
    files: ['src/domain/**/*.ts'],
    name: 'domain/purity',
    rules: {
      // The domain receives `now` as an argument. Reading a clock here would make decisions
      // untestable at the boundary and different on every app instance.
      'no-restricted-syntax': [
        'error',
        {
          message: 'src/domain must not read the clock: take `now` as a parameter.',
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
        },
        {
          message: 'src/domain must not read the clock: take `now` as a parameter.',
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
        },
        {
          message: 'src/domain must be deterministic.',
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
        },
      ],
    },
  },

  ...Object.entries(DOMAIN_BLOCK_DEPENDENCIES).map(([block, allowed]) =>
    domainBlock(block, allowed),
  ),

  {
    files: ['src/application/**/*.ts'],
    name: 'layering/application',
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DOMAIN_PUBLIC_API_ONLY,
            {
              group: ['**/http/**', '**/worker/**'],
              message: 'src/application must not depend on delivery layers.',
            },
            {
              group: ['**/infrastructure/**'],
              message:
                'src/application depends on ports (application/*/ports.ts), never on the adapters that implement them.',
            },
          ],
        },
      ],
    },
  },

  prettierConfig,
)
