import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

interface SecretRule {
  description: string
  pattern: RegExp
}

const SECRET_RULES: SecretRule[] = [
  {
    description: 'private key block',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  { description: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { description: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { description: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { description: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { description: 'Stripe live secret key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { description: 'bearer token literal', pattern: /Bearer\s+[A-Za-z0-9._-]{40,}/ },
  {
    description: 'hardcoded credential assignment',
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|client[_-]?secret|token)\s*[:=]\s*['"][^'"\s${}<>]{8,}['"]/i,
  },
]

async function collectFiles(root: string, skip: Set<string>): Promise<string[]> {
  const found: string[] = []

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await collectFiles(full, skip)))
    else found.push(full)
  }

  return found
}

async function scanConsole(files: string[]): Promise<string[]> {
  const findings: string[] = []

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (/\bconsole\s*\./.test(line)) findings.push(`${file}:${index + 1} console statement`)
    })
  }

  return findings
}

async function scanSecrets(files: string[]): Promise<string[]> {
  const findings: string[] = []

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      for (const rule of SECRET_RULES) {
        if (rule.pattern.test(line)) {
          findings.push(`${file}:${index + 1} possible ${rule.description}`)
        }
      }
    })
  }

  return findings
}

const command = process.argv[2]
const targets = process.argv.slice(3)

const CONSOLE_SKIP = new Set(['node_modules', 'coverage', 'dist'])
const SECRETS_SKIP = new Set(['node_modules', 'coverage', 'dist'])
const SECRETS_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.env',
  '.js',
  '.json',
  '.md',
  '.mts',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])
const SECRETS_SKIP_FILES = new Set(['.env', 'package-lock.json'])

async function collectSecretTargets(): Promise<string[]> {
  const all = await collectFiles(path.resolve('.'), SECRETS_SKIP)
  return all
    .filter((file) => !SECRETS_SKIP_FILES.has(path.basename(file)))
    .filter((file) => {
      if (file.endsWith('.env')) return true
      return SECRETS_EXTENSIONS.has(path.extname(file))
    })
    .sort()
}

const resolved =
  targets.length > 0
    ? targets
    : command === 'secrets'
      ? await collectSecretTargets()
      : (await collectFiles(path.resolve('src'), CONSOLE_SKIP)).sort()

if (command === 'secrets') {
  const findings = await scanSecrets(resolved)
  if (findings.length > 0) {
    fail(`possible secrets committed:\n${findings.join('\n')}\n`)
    process.exit(1)
  }
  out(`no secrets detected in ${resolved.length} file(s)\n`)
} else if (command === 'console') {
  const findings = await scanConsole(resolved)
  if (findings.length > 0) {
    fail(`console usage found:\n${findings.join('\n')}\n`)
    process.exit(1)
  }
  out(`no console usage in ${resolved.length} file(s)\n`)
} else {
  fail('usage: repo-guards.ts <secrets|console> [files...]\n')
  process.exit(2)
}
