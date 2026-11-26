/**
 * Host half of the GitHub integration bundle.
 *
 * Owns one durable binding (owner, repository, branch, and the personal access
 * token) in the credential store, calls the GitHub REST API, registers the
 * `github` agent tool, and serves the browser route the Settings > GitHub page
 * talks to. Every browser request passes the composition's Connection trust
 * fence before it reaches this service, matching the shipped route pattern.
 *
 * The token never enters configuration or a response: `status` reports only
 * whether one is configured and from which layer, and the record holds the
 * value in the local credential store.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Loader plugin name. */
export const name = 'github-integration'

/** The tool registry is the only hard dependency; everything else is optional so
 * a headless profile without a Web carrier still gets the agent tool. */
export const inject = ['tools']

const RECORD_KEY = 'github-integration/binding'
const RPC_PATH = '/github-integration/rpc'
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_BODY_BYTES = 12 * 1024 * 1024
const TOOL_TEXT_LIMIT = 200 * 1024
const TOOL_RENDER_LIMIT = 6_000
const GIT_TIMEOUT_MS = 180_000
const GIT_OUTPUT_BYTES = 1024 * 1024
const MAX_COMMIT_FILES = 2_000
const MAX_COMMIT_TOTAL_BYTES = 32 * 1024 * 1024
const SCAN_MAX_FILE_BYTES = 1024 * 1024
const SCAN_MAX_FILES = 500
const SCAN_REPORT_LIMIT = 30
const LARGE_FILE_BYTES = 5 * 1024 * 1024

/** One operation failure with a stable code for the UI and the tool result. */
class GithubError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - readable reason.
   * @param {number} status - HTTP status the remote host answered, or 0.
   */
  constructor(code, message, status = 0) {
    super(message)
    this.name = 'GithubError'
    this.code = code
    this.status = status
  }
}

/**
 * Normalize a configured URL base.
 * @param {unknown} value - configured value.
 * @returns {string} base without a trailing slash.
 */
function normalizeApiBase(value) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_API_BASE
  return text.replace(/\/+$/, '')
}

/**
 * Take a bounded positive integer from configuration.
 * @param {unknown} value - configured value.
 * @param {number} min - lowest accepted value.
 * @param {number} max - highest accepted value.
 * @param {number} fallback - value used when absent or invalid.
 * @returns {number} the accepted value.
 */
function boundedInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback
  return number
}

/**
 * Normalize an owner/repository pair; a full URL or `owner/repo` in either
 * field is accepted and split.
 * @param {{ owner?: unknown, repo?: unknown }} input - user input.
 * @returns {{ owner: string, repo: string }} cleaned pair.
 */
function normalizeTarget(input) {
  const clean = (value) => String(value ?? '').trim()
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
  let owner = clean(input?.owner)
  let repo = clean(input?.repo)
  if (repo === '' && owner.includes('/')) {
    const parts = owner.split('/')
    owner = parts[0] ?? ''
    repo = parts.slice(1).join('/')
  }
  if (repo.includes('/')) repo = repo.split('/')[0] ?? ''
  return { owner, repo }
}

/**
 * Percent-encode one repository path while keeping its separators.
 * @param {string} path - repository-relative path.
 * @returns {string} encoded path.
 */
function encodePath(path) {
  return String(path).replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')
}

/**
 * Validate one repository-relative path.
 * @param {string} path - repository path.
 * @param {{ allowEmpty?: boolean }} options - whether the repository root is accepted.
 * @returns {string} the validated path.
 */
function assertRepoPath(path, options = {}) {
  if (path === '') {
    if (options.allowEmpty === true) return ''
    throw new GithubError('bad-request', 'A repository path is required.')
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new GithubError('bad-request', 'The repository path must be a simple relative path.')
  }
  return path
}

/**
 * Join two abort signals without leaking a timeout controller.
 * @param {AbortSignal | undefined} caller - caller cancellation.
 * @param {AbortSignal} timeout - per-request deadline.
 * @returns {AbortSignal} the merged signal.
 */
function combineSignals(caller, timeout) {
  if (caller === undefined) return timeout
  if (caller.aborted) return caller
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([caller, timeout])
  const controller = new AbortController()
  const abort = (signal) => () => { controller.abort(signal.reason) }
  caller.addEventListener('abort', abort(caller), { once: true })
  timeout.addEventListener('abort', abort(timeout), { once: true })
  return controller.signal
}

/**
 * Decide whether a byte buffer is valid UTF-8 text rather than binary.
 * @param {Buffer} buffer - file bytes.
 * @returns {boolean} true for text.
 */
function isText(buffer) {
  if (buffer.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Validate a branch name conservatively.
 * @param {unknown} value - branch name.
 * @returns {string} the accepted name.
 */
function branchName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new GithubError('bad-request', 'A branch name is required.')
  if (text.length > 200) throw new GithubError('bad-request', 'The branch name is too long.')
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.startsWith('-') || text.startsWith('/') || text.endsWith('/')
    || text.includes('..') || text.endsWith('.lock')) {
    throw new GithubError('bad-request', `Invalid branch name: ${text}`)
  }
  return text
}

/**
 * Normalize an optional repository subdirectory.
 * @param {unknown} value - folder inside the repository.
 * @returns {string} normalized folder, empty for the repository root.
 */
function normalizeRepoDir(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : ''
  if (text === '') return ''
  const segments = text.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new GithubError('bad-request', 'repoDir must be a simple relative path.')
  }
  return segments.join('/')
}

/**
 * Build the environment that authenticates git HTTPS calls. The token travels
 * in the child environment through git's config-count mechanism, never in argv.
 * @param {string} token - personal access token.
 * @returns {Record<string, string>} child environment overrides.
 */
function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  }
}

/**
 * Remove embedded credentials from a remote URL before showing it.
 * @param {string} value - remote URL.
 * @returns {string} credential-free URL.
 */
function sanitizeRemoteUrl(value) {
  return String(value).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}

/**
 * Compare two remotes while ignoring embedded credentials and a `.git` suffix.
 * @param {string} left - first remote.
 * @param {string} right - second remote.
 * @returns {boolean} true when both name the same repository.
 */
function sameRemote(left, right) {
  const normalize = (value) => sanitizeRemoteUrl(String(value))
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  return normalize(left) === normalize(right)
}

/** Content patterns that usually mean a secret is about to be committed. */
const SECRET_CONTENT_RULES = [
  { message: 'private key header', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { message: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { message: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { message: 'API secret key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { message: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { message: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { message: 'credential assignment', pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
]

/**
 * Filename and directory rules for the pre-commit safety scan.
 * @param {string} relative - repository-relative path.
 * @returns {Array<{ path: string, message: string, severity: string }>} findings.
 */
function pathFindings(relative) {
  const segments = relative.split('/')
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  const lower = relative.toLowerCase()
  const findings = []
  const add = (message, severity) => findings.push({ path: relative, message, severity })
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) add('environment file', 'secret')
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) add('private key file', 'secret')
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) add('key or certificate file', 'secret')
  if (/^(\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/.test(base)) add('credential file', 'secret')
  if (/^(credentials|secrets?)(\.|$)/.test(base)) add('credential file', 'secret')
  if (/(^|\/)(\.ssh|\.aws)\//.test(lower)) add('credential directory', 'secret')
  if (/(^|\/)(node_modules|\.venv|__pycache__)\//.test(lower)) add('temporary or generated directory', 'temp')
  if (/^(\.ds_store|thumbs\.db)$/.test(base)) add('OS metadata file', 'temp')
  if (/\.(tmp|temp|log|bak|swp|swo|orig|rej|pyc)$/.test(base)) add('temporary or backup file', 'temp')
  return findings
}

/**
 * Scan one buffered file for likely secrets and temporary content.
 * @param {string} relative - repository-relative path.
 * @param {Buffer} buffer - file bytes.
 * @returns {Array<{ path: string, message: string, severity: string }>} findings.
 */
function scanBuffer(relative, buffer) {
  const findings = pathFindings(relative)
  if (buffer.length > LARGE_FILE_BYTES) findings.push({ path: relative, message: 'large file', severity: 'large' })
  if (buffer.length <= SCAN_MAX_FILE_BYTES && isText(buffer)) {
    const text = buffer.toString('utf8')
    for (const rule of SECRET_CONTENT_RULES) {
      if (rule.pattern.test(text)) findings.push({ path: relative, message: rule.message, severity: 'secret' })
    }
  }
  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.path}|${finding.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** JSON response with no-store, matching the shipped route convention. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded UTF-8 request body; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Register the GitHub service, browser route, and agent tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown> | undefined} rawConfig - bundle row config.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const apiBase = normalizeApiBase(config.apiBase)
  const tokenRef = typeof config.tokenRef === 'string' && config.tokenRef.trim() !== ''
    ? config.tokenRef.trim()
    : 'GITHUB_TOKEN'
  const maxFileBytes = boundedInt(config.maxFileBytes, 1024, 8 * 1024 * 1024, DEFAULT_MAX_FILE_BYTES)
  const timeoutMs = boundedInt(config.timeoutMs, 5_000, 120_000, DEFAULT_TIMEOUT_MS)

  /** Profile-owned session-to-branch map; it holds no secrets. */
  const explicitProfileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const profileName = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  const profileDir = explicitProfileDir !== ''
    ? explicitProfileDir
    : (profileName === '' ? '' : join(dshHome, 'profiles', profileName))
  const sessionStoreFile = profileDir === '' ? undefined : join(profileDir, 'github-integration', 'session-branches.json')
  let sessionMapPromise
  let sessionWrite = Promise.resolve()

  /** Load the persisted session map once. */
  function loadSessionMap() {
    sessionMapPromise ??= (async () => {
      const map = new Map()
      if (sessionStoreFile === undefined) return map
      try {
        const data = JSON.parse(await readFile(sessionStoreFile, 'utf8'))
        if (data !== null && typeof data === 'object') {
          for (const [sessionId, value] of Object.entries(data)) {
            if (value === null || typeof value !== 'object') continue
            if (typeof value.owner !== 'string' || typeof value.repo !== 'string' || typeof value.branch !== 'string') continue
            if (value.owner === '' || value.repo === '' || value.branch === '') continue
            map.set(sessionId, { owner: value.owner, repo: value.repo, branch: value.branch })
          }
        }
      } catch {
        // A missing or malformed state file starts from an empty map.
      }
      return map
    })()
    return sessionMapPromise
  }

  /** Persist the session map, serializing writes. */
  async function persistSessionMap() {
    if (sessionStoreFile === undefined) return
    sessionWrite = sessionWrite.then(async () => {
      const map = await loadSessionMap()
      await mkdir(dirname(sessionStoreFile), { recursive: true })
      await writeFile(sessionStoreFile, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8')
    }).catch(() => {
      // Session routing is a convenience; a failed write leaves the in-memory map usable.
    })
    await sessionWrite
  }

  /**
   * Session id owning one tool execution.
   * @param {{ agent?: any } | undefined} exec - execution context.
   * @returns {string | undefined} session id.
   */
  function sessionIdOf(exec) {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * Read the branch remembered for this session and repository.
   * @param {{ agent?: any } | undefined} exec - execution context.
   * @param {Record<string, any>} binding - current binding.
   * @returns {Promise<string | undefined>} remembered branch.
   */
  async function storedSessionBranch(exec, binding) {
    const sessionId = sessionIdOf(exec)
    if (sessionId === undefined) return undefined
    const map = await loadSessionMap()
    const entry = map.get(sessionId)
    if (entry === undefined) return undefined
    if (entry.owner !== binding.owner || entry.repo !== binding.repo) {
      map.delete(sessionId)
      await persistSessionMap()
      return undefined
    }
    return entry.branch
  }

  /**
   * Remember a branch for this session and repository.
   * @param {{ agent?: any } | undefined} exec - execution context.
   * @param {Record<string, any>} binding - current binding.
   * @param {string} branch - chosen branch.
   * @returns {Promise<boolean>} whether a session id was available.
   */
  async function rememberSessionBranch(exec, binding, branch) {
    const sessionId = sessionIdOf(exec)
    if (sessionId === undefined) return false
    const map = await loadSessionMap()
    map.set(sessionId, { owner: binding.owner, repo: binding.repo, branch })
    await persistSessionMap()
    return true
  }

  /**
   * Branch choices offered in the first-commit question.
   * @param {Record<string, any>} binding - current binding.
   * @returns {Promise<string[]>} branch names, bound and default first.
   */
  async function branchChoices(binding) {
    try {
      const result = await branches()
      const names = result.branches.map((entry) => entry.name)
      const preferred = [binding.branch, binding.defaultBranch].filter((name) => typeof name === 'string' && name !== '')
      return [...new Set([...preferred, ...names])].slice(0, 12)
    } catch {
      return []
    }
  }

  /**
   * Ask the user which branch this session commits to.
   * @param {{ agent?: any, signal?: AbortSignal } | undefined} exec - execution context.
   * @param {Record<string, any>} binding - current binding.
   * @returns {Promise<{ kind: 'chosen', branch: string } | { kind: 'cancelled' } | { kind: 'unavailable' } | { kind: 'failed' }>} outcome.
   */
  async function askForBranch(exec, binding) {
    const questions = ctx.get('userQuestions')
    if (questions === undefined || exec?.agent === undefined) return { kind: 'unavailable' }
    const names = await branchChoices(binding)
    const options = names.map((name) => ({
      label: name,
      ...(name === binding.branch ? { description: 'Currently bound branch' } : {}),
    }))
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'github-branch',
          header: '提交分支',
          question: `选择要提交到 ${binding.owner}/${binding.repo} 的分支，或直接输入新分支名称。`,
          ...(options.length === 0 ? {} : { options }),
        }],
        agent: exec.agent,
        signal: exec.signal,
      })
      const item = answer.answers.find((entry) => entry.id === 'github-branch')
      if (item === undefined) return { kind: 'cancelled' }
      const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
      const selected = Array.isArray(item.selected) ? item.selected : []
      const chosen = custom !== '' ? custom : selected[0]
      if (typeof chosen !== 'string' || chosen.trim() === '') return { kind: 'cancelled' }
      return { kind: 'chosen', branch: branchName(chosen.trim()) }
    } catch {
      return { kind: 'failed' }
    }
  }

  /**
   * Resolve the branch for one commit: explicit argument, session memory, or a
   * first-commit question. A caller without interactive support receives a
   * selection request instead of a write.
   * @param {{ agent?: any, signal?: AbortSignal } | undefined} exec - execution context.
   * @param {Record<string, any>} binding - current binding.
   * @param {{ branch?: unknown }} input - action input.
   * @returns {Promise<{ kind: 'chosen', branch: string } | { kind: 'cancelled' } | { kind: 'select', branches: string[] }>} resolution.
   */
  async function resolveSessionBranch(exec, binding, input) {
    if (typeof input.branch === 'string' && input.branch.trim() !== '') {
      const branch = branchName(input.branch)
      await rememberSessionBranch(exec, binding, branch)
      return { kind: 'chosen', branch }
    }
    const stored = await storedSessionBranch(exec, binding)
    if (stored !== undefined) return { kind: 'chosen', branch: stored }
    const asked = await askForBranch(exec, binding)
    if (asked.kind === 'chosen') {
      await rememberSessionBranch(exec, binding, asked.branch)
      return asked
    }
    if (asked.kind === 'cancelled') return { kind: 'cancelled' }
    return { kind: 'select', branches: await branchChoices(binding) }
  }

  /**
   * Ask the user to accept scan findings before a write.
   * @param {{ agent?: any, signal?: AbortSignal } | undefined} exec - execution context.
   * @param {Array<{ path: string, message: string }>} findings - scan findings.
   * @returns {Promise<{ kind: 'proceed' } | { kind: 'cancel' } | { kind: 'unavailable' }>} decision.
   */
  async function askScanConfirmation(exec, findings) {
    const questions = ctx.get('userQuestions')
    if (questions === undefined || exec?.agent === undefined) return { kind: 'unavailable' }
    const listed = findings.slice(0, 10).map((finding) => `- ${finding.path}: ${finding.message}`).join('\n')
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'github-confirm',
          header: '提交前确认',
          question: `提交前扫描到以下可能不该提交的内容：\n${listed}\n\n是否仍然提交？`,
          options: [
            { label: '取消 (Recommended)', description: '先移除或忽略这些文件再提交。' },
            { label: '仍然提交', description: '已确认这些内容可以提交。' },
          ],
        }],
        agent: exec.agent,
        signal: exec.signal,
      })
      const item = answer.answers.find((entry) => entry.id === 'github-confirm')
      const selected = Array.isArray(item?.selected) ? item.selected : []
      return { kind: selected.includes('仍然提交') ? 'proceed' : 'cancel' }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  /**
   * Apply one scan result: clean or explicitly confirmed writes proceed.
   * @param {{ agent?: any, signal?: AbortSignal } | undefined} exec - execution context.
   * @param {{ findings: Array<Record<string, any>>, checked: number, truncated: boolean }} scan - scan result.
   * @param {boolean | undefined} confirm - explicit approval from a prior turn.
   * @returns {Promise<{ kind: 'proceed' } | { kind: 'cancel' } | { kind: 'needs-confirmation' }>} decision.
   */
  async function decideScan(exec, scan, confirm) {
    if (scan.findings.length === 0 || confirm === true) return { kind: 'proceed' }
    const asked = await askScanConfirmation(exec, scan.findings)
    if (asked.kind === 'proceed') return asked
    if (asked.kind === 'cancel') return asked
    return { kind: 'needs-confirmation' }
  }

  /**
   * Shape one scan result for the tool result.
   * @param {{ findings: Array<Record<string, any>>, checked: number }} scan - scan result.
   * @returns {Record<string, any>} public summary.
   */
  function scanSummary(scan) {
    return {
      clean: scan.findings.length === 0,
      checkedFiles: scan.checked,
      findings: scan.findings.slice(0, SCAN_REPORT_LIMIT),
      truncated: scan.truncated === true || scan.findings.length > SCAN_REPORT_LIMIT,
      scannedFileLimit: SCAN_MAX_FILES,
    }
  }

  /**
   * Scan files that a push would commit.
   * @param {string} gitRoot - repository root.
   * @param {readonly string[]} paths - repository-relative paths.
   * @returns {Promise<{ findings: Array<Record<string, any>>, checked: number, truncated: boolean }>} scan result.
   */
  async function scanStagedFiles(gitRoot, paths) {
    const findings = []
    let checked = 0
    let truncated = false
    for (const relative of paths) {
      if (checked >= SCAN_MAX_FILES) {
        truncated = true
        break
      }
      checked += 1
      const absolute = join(gitRoot, relative)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (info.size > LARGE_FILE_BYTES) {
        findings.push({ path: relative, message: 'large file', severity: 'large' })
        continue
      }
      if (info.size > SCAN_MAX_FILE_BYTES) continue
      try {
        findings.push(...scanBuffer(relative, await readFile(absolute)))
      } catch {
        // An unreadable file is left out of the scan; git will report its own failure.
      }
    }
    return { findings, checked, truncated }
  }

  /**
   * Scan a set of already-collected source files.
   * @param {Array<{ relative: string, absolute: string }>} files - collected files.
   * @returns {Promise<{ findings: Array<Record<string, any>>, checked: number, truncated: boolean }>} scan result.
   */
  async function scanCollectedFiles(files) {
    const findings = []
    let checked = 0
    let truncated = false
    for (const file of files) {
      if (checked >= SCAN_MAX_FILES) {
        truncated = true
        break
      }
      checked += 1
      try {
        const info = await stat(file.absolute)
        if (!info.isFile()) continue
        if (info.size > LARGE_FILE_BYTES) {
          findings.push({ path: file.relative, message: 'large file', severity: 'large' })
          continue
        }
        if (info.size > SCAN_MAX_FILE_BYTES) continue
        findings.push(...scanBuffer(file.relative, await readFile(file.absolute)))
      } catch {
        // An unreadable file is left out of the scan; the writer will report its own failure.
      }
    }
    return { findings, checked, truncated }
  }

  /** @returns {any} the credential service when the profile provides one. */
  const credentialsOf = () => ctx.get('credentials')

  /**
   * Read the durable binding record.
   * @returns {Promise<Record<string, any> | undefined>} normalized binding.
   */
  async function readBinding() {
    const store = credentialsOf()
    if (store === undefined) return undefined
    let record
    try {
      record = await store.readRecord(RECORD_KEY)
    } catch {
      return undefined
    }
    if (record === undefined || record === null || record.kind !== 'grant') return undefined
    const payload = record.payload
    if (payload === null || typeof payload !== 'object') return undefined
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
    return {
      owner: text(payload.owner),
      repo: text(payload.repo),
      branch: text(payload.branch),
      token: text(payload.token),
      login: text(payload.login),
      avatarUrl: text(payload.avatarUrl),
      defaultBranch: text(payload.defaultBranch),
      host: text(payload.host),
      boundAt: text(payload.boundAt),
    }
  }

  /**
   * Resolve the token the next operation should use: the stored record first,
   * then the configured reference and the conventional environment names.
   * @param {Record<string, any> | undefined} binding - current binding.
   * @returns {Promise<{ value: string, source: string } | undefined>} token and layer.
   */
  async function tokenInfo(binding) {
    if (typeof binding?.token === 'string' && binding.token !== '') {
      return { value: binding.token, source: 'stored' }
    }
    const store = credentialsOf()
    const refs = [...new Set([tokenRef, 'GITHUB_TOKEN', 'GH_TOKEN'])]
    for (const ref of refs) {
      if (store !== undefined) {
        try {
          const hit = await store.resolve(ref)
          if (typeof hit?.value === 'string' && hit.value !== '') return { value: hit.value, source: `environment:${ref}` }
        } catch {
          // A provider that cannot resolve this reference falls through to the process environment.
        }
      }
      const ambient = process.env[ref]
      if (typeof ambient === 'string' && ambient.trim() !== '') return { value: ambient.trim(), source: `environment:${ref}` }
    }
    return undefined
  }

  /**
   * One GitHub REST call.
   * @param {string} method - HTTP method.
   * @param {string} apiPath - path under the API base, or an absolute URL.
   * @param {{ body?: unknown, token?: string, signal?: AbortSignal, accept?: string, raw?: boolean }} options - request facts.
   * @returns {Promise<any>} parsed JSON, or the raw response when `raw` is set.
   */
  async function requestJson(method, apiPath, options = {}) {
    const { body, token, signal, accept = 'application/vnd.github+json', raw = false, allowNotFound = false } = options
    if (typeof token !== 'string' || token === '') {
      throw new GithubError('unauthenticated', 'No GitHub token is configured. Open Settings > GitHub and bind an account.')
    }
    const url = apiPath.startsWith('http') ? apiPath : apiBase + apiPath
    const headers = {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-github-integration',
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const timeout = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combineSignals(signal, timeout),
      })
    } catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted === true) {
        throw new GithubError('cancelled', 'The GitHub request was cancelled.')
      }
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new GithubError('timeout', `GitHub did not answer within ${timeoutMs} ms.`)
      }
      throw new GithubError('network', `Cannot reach ${apiBase}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      if (allowNotFound === true && response.status === 404) return undefined
      const text = await response.text().catch(() => '')
      let message = `${response.status} ${response.statusText}`.trim()
      try {
        const data = JSON.parse(text)
        if (typeof data?.message === 'string' && data.message !== '') message = data.message
        if (Array.isArray(data?.errors) && data.errors.length > 0) {
          const details = data.errors.map((entry) => entry?.message ?? entry?.code ?? String(entry)).join('; ')
          if (details !== '') message = `${message}: ${details}`
        }
      } catch {
        if (text.trim() !== '') message = text.trim().slice(0, 300)
      }
      const remaining = response.headers.get('x-ratelimit-remaining')
      const code = response.status === 401
        ? 'unauthenticated'
        : response.status === 403 && remaining === '0'
          ? 'rate-limited'
          : response.status === 404
            ? 'not-found'
            : response.status === 413
              ? 'too-large'
              : response.status === 422
                ? 'validation'
                : 'github-error'
      throw new GithubError(code, message, response.status)
    }
    if (raw) return response
    if (response.status === 204) return undefined
    const text = await response.text()
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * Read the current binding and token state.
   * @param {{ verify?: boolean }} options - whether to confirm the token with GitHub.
   * @returns {Promise<Record<string, any>>} status view.
   */
  async function status(options = {}) {
    const binding = await readBinding()
    const token = await tokenInfo(binding)
    const result = {
      bound: Boolean(binding?.owner && binding?.repo),
      owner: binding?.owner ?? null,
      repo: binding?.repo ?? null,
      branch: binding?.branch ?? null,
      login: binding?.login ?? null,
      avatarUrl: binding?.avatarUrl ?? null,
      defaultBranch: binding?.defaultBranch ?? null,
      tokenConfigured: token !== undefined,
      tokenSource: token?.source ?? null,
      tokenRef,
      apiBase,
      maxFileBytes,
    }
    if (options.verify === true) {
      if (token === undefined) {
        result.identityError = 'No GitHub token is configured.'
      } else {
        try {
          const me = await requestJson('GET', '/user', { token: token.value })
          result.login = me?.login ?? result.login
          result.avatarUrl = me?.avatar_url ?? result.avatarUrl
        } catch (error) {
          result.identityError = error instanceof GithubError ? error.message : String(error)
        }
      }
    }
    return result
  }

  /**
   * Bind a repository and store the token record.
   * @param {{ token?: unknown, owner?: unknown, repo?: unknown, branch?: unknown }} input - binding form.
   * @returns {Promise<Record<string, any>>} the new status.
   */
  async function bind(input = {}) {
    const { owner, repo } = normalizeTarget(input)
    if (owner === '' || repo === '') {
      throw new GithubError('bad-request', 'Both the owner and the repository name are required.')
    }
    const provided = typeof input.token === 'string' ? input.token.trim() : ''
    const existing = await readBinding()
    const token = provided !== '' ? provided : (await tokenInfo(existing))?.value
    if (token === undefined) {
      throw new GithubError('unauthenticated', 'A GitHub personal access token is required for the first binding.')
    }
    const me = await requestJson('GET', '/user', { token })
    const target = await requestJson('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })
    const requested = typeof input.branch === 'string' ? input.branch.trim() : ''
    const branch = requested !== '' ? requested : (typeof target?.default_branch === 'string' ? target.default_branch : '')
    const store = credentialsOf()
    if (store === undefined) {
      throw new GithubError('unavailable', 'Credential storage is unavailable in this profile, so the binding cannot be saved.')
    }
    await store.modifyRecord(RECORD_KEY, async () => {
      const payload = {
        ...(provided !== '' ? { token: provided } : existing?.token !== undefined ? { token: existing.token } : {}),
        owner: typeof target?.owner?.login === 'string' ? target.owner.login : owner,
        repo: typeof target?.name === 'string' ? target.name : repo,
        branch,
        defaultBranch: typeof target?.default_branch === 'string' ? target.default_branch : branch,
        login: typeof me?.login === 'string' ? me.login : undefined,
        avatarUrl: typeof me?.avatar_url === 'string' ? me.avatar_url : undefined,
        host: new URL(apiBase).host,
        boundAt: new Date().toISOString(),
      }
      for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) delete payload[key]
      }
      return { kind: 'grant', payload }
    })
    return await status()
  }

  /**
   * Remove the binding record. An environment token may still remain.
   * @returns {Promise<Record<string, any>>} status after removal.
   */
  async function unbind() {
    const store = credentialsOf()
    if (store !== undefined) {
      try {
        await store.deleteRecord(RECORD_KEY)
      } catch (error) {
        throw new GithubError('unavailable', `Cannot remove the stored binding: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return await status()
  }

  /**
   * Resolve the bound repository and token, or fail with a useful reason.
   * @returns {Promise<{ binding: Record<string, any>, owner: string, repo: string, branch: string, token: { value: string, source: string } }>} operation context.
   */
  async function contextOf() {
    const binding = await readBinding()
    if (binding?.owner === undefined || binding?.repo === undefined) {
      throw new GithubError('not-bound', 'No repository is bound. Open Settings > GitHub and bind one first.')
    }
    const token = await tokenInfo(binding)
    if (token === undefined) {
      throw new GithubError('unauthenticated', 'The bound token is missing. Bind again in Settings > GitHub.')
    }
    return {
      binding,
      owner: binding.owner,
      repo: binding.repo,
      branch: binding.branch ?? binding.defaultBranch ?? '',
      token,
    }
  }

  /** Web origin for repository pages and HTTPS remotes. */
  function webBase() {
    return apiBase === 'https://api.github.com' ? 'https://github.com' : apiBase.replace(/\/api\/v3$/, '')
  }

  /**
   * Tokenless HTTPS remote for the bound repository.
   * @param {string} owner - repository owner.
   * @param {string} repo - repository name.
   * @returns {string} clone and push URL.
   */
  function remoteUrlOf(owner, repo) {
    return `${webBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`
  }

  /**
   * Web page of one branch.
   * @param {string} owner - repository owner.
   * @param {string} repo - repository name.
   * @param {string} branch - branch name.
   * @returns {string} web URL.
   */
  function branchUrl(owner, repo, branch) {
    return `${webBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodePath(branch)}`
  }

  /**
   * Resolve the session workspace root.
   * @param {{ agent?: any } | undefined} exec - tool execution context.
   * @returns {string} absolute workspace root.
   */
  function workspaceRoot(exec) {
    const workingDirectory = ctx.get('workingDirectory')
    if (exec?.agent !== undefined && workingDirectory !== undefined) {
      try {
        return workingDirectory.get(exec.agent.session)
      } catch {
        // Fall through to the process directory when no Session directory is available.
      }
    }
    return process.cwd()
  }

  /**
   * Resolve a user path and keep it inside the workspace.
   * @param {string} root - workspace root.
   * @param {unknown} value - user path.
   * @param {string} fallback - path used when the value is empty.
   * @returns {string} absolute path inside the workspace.
   */
  function resolveInWorkspace(root, value, fallback = '.') {
    const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
    const target = resolve(root, text)
    const rel = relative(root, target)
    if (rel !== '' && (isAbsolute(rel) || rel.startsWith('..'))) {
      throw new GithubError('bad-request', `Path is outside the workspace: ${text}`)
    }
    return target
  }

  /**
   * Run git through the composition's managed subprocess service. The token
   * reaches git through its environment, never through argv or a URL.
   * @param {readonly string[]} args - git arguments.
   * @param {{ cwd: string, token: string, signal?: AbortSignal, timeoutMs?: number }} options - execution facts.
   * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
   */
  async function runGit(args, options) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new GithubError('unavailable', 'The subprocess service is unavailable, so git cannot run in this profile.')
    }
    const { cwd, token, signal, timeoutMs = GIT_TIMEOUT_MS } = options
    const env = gitAuthEnv(token)
    let executable
    try {
      executable = await subprocess.resolveExecutable('git', env, signal)
    } catch {
      throw new GithubError('git-missing', 'Git is not installed or is not on PATH; install Git for Windows and retry.')
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const combined = signal === undefined
      ? controller.signal
      : typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable, '-c', 'core.quotepath=false', '--no-pager', ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: GIT_OUTPUT_BYTES },
          stderr: { maxBytes: GIT_OUTPUT_BYTES },
        },
        graceMs: 3000,
        signal: combined,
        env,
      })
    } catch (error) {
      clearTimeout(timer)
      if (timedOut) throw new GithubError('timeout', `git timed out after ${timeoutMs} ms.`)
      if (signal?.aborted === true) throw new GithubError('cancelled', 'The git command was cancelled.')
      throw new GithubError('git-error', `git could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      clearTimeout(timer)
      if (timedOut) throw new GithubError('timeout', `git timed out after ${timeoutMs} ms.`)
      if (signal?.aborted === true) throw new GithubError('cancelled', 'The git command was cancelled.')
      throw new GithubError('git-error', `git failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    clearTimeout(timer)
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (timedOut) throw new GithubError('timeout', `git timed out after ${timeoutMs} ms.`)
    if (signal?.aborted === true) throw new GithubError('cancelled', 'The git command was cancelled.')
    if (outcome.exitCode !== 0) {
      const detail = (stderr.trim() || stdout.trim() || `exit code ${String(outcome.exitCode)}`).slice(0, 2000)
      throw new GithubError('git-error', `git failed: ${detail}`)
    }
    return { stdout, stderr }
  }

  /**
   * Read every regular file below a directory for one API commit.
   * @param {string} sourceDir - absolute source directory.
   * @returns {Promise<{ files: Array<{ absolute: string, relative: string, size: number }>, total: number }>} file facts.
   */
  async function collectCommitFiles(sourceDir) {
    const files = []
    let total = 0
    const walk = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute)
          continue
        }
        if (!entry.isFile()) continue
        const details = await stat(absolute)
        if (details.size > maxFileBytes) {
          throw new GithubError('too-large', `${entry.name} is ${details.size} bytes; the per-file limit is ${maxFileBytes}.`)
        }
        total += details.size
        if (total > MAX_COMMIT_TOTAL_BYTES) {
          throw new GithubError('too-large', `The folder is larger than the ${MAX_COMMIT_TOTAL_BYTES}-byte commit limit; use push instead.`)
        }
        files.push({ absolute, relative: relative(sourceDir, absolute).split(sep).join('/'), size: details.size })
        if (files.length > MAX_COMMIT_FILES) {
          throw new GithubError('too-large', `The folder has more than ${MAX_COMMIT_FILES} files; use push instead.`)
        }
      }
    }
    await walk(sourceDir)
    files.sort((left, right) => left.relative.localeCompare(right.relative))
    return { files, total }
  }

  /**
   * Create a branch from an existing base branch through the API.
   * @param {{ branch?: unknown, base?: unknown }} input - branch request.
   * @param {{ agent?: any, signal?: AbortSignal } | undefined} exec - execution facts.
   * @returns {Promise<Record<string, any>>} created branch facts.
   */
  async function createBranch(input = {}, exec) {
    const { binding, owner, repo, token } = await contextOf()
    const branch = branchName(input.branch)
    const base = branchName(input.base === undefined || input.base === ''
      ? (binding.branch || binding.defaultBranch || 'main')
      : input.base)
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    const baseRef = await requestJson('GET', `${repoPath}/git/ref/heads/${base}`, { token: token.value })
    const sha = baseRef?.object?.sha
    if (typeof sha !== 'string' || sha === '') throw new GithubError('not-found', `Base branch ${base} has no head commit.`)
    await requestJson('POST', `${repoPath}/git/refs`, {
      token: token.value,
      body: { ref: `refs/heads/${branch}`, sha },
    })
    const remembered = await rememberSessionBranch(exec, binding, branch)
    return { branch, base, sha, sessionBranchStored: remembered, url: branchUrl(owner, repo, branch) }
  }

  /**
   * Ensure one branch exists, creating it from a base branch when absent.
   * @param {string} owner - repository owner.
   * @param {string} repo - repository name.
   * @param {string} token - personal access token.
   * @param {string} branch - target branch.
   * @param {string | undefined} base - base branch for a new branch.
   * @returns {Promise<boolean>} true when the branch was created.
   */
  async function ensureBranch(owner, repo, token, branch, base) {
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    const existing = await requestJson('GET', `${repoPath}/git/ref/heads/${branch}`, { token, allowNotFound: true })
    if (existing !== undefined) return false
    const baseName = branchName(base === undefined || base === '' ? 'main' : base)
    const baseRef = await requestJson('GET', `${repoPath}/git/ref/heads/${baseName}`, { token })
    const sha = baseRef?.object?.sha
    if (typeof sha !== 'string' || sha === '') throw new GithubError('not-found', `Base branch ${baseName} has no head commit.`)
    await requestJson('POST', `${repoPath}/git/refs`, {
      token,
      body: { ref: `refs/heads/${branch}`, sha },
    })
    return true
  }

  /**
   * Commit a local folder to a branch in one API commit, creating the branch
   * from the base branch when it does not exist.
   * @param {{ sourceDir?: unknown, branch?: unknown, base?: unknown, repoDir?: unknown, message?: unknown }} input - commit request.
   * @param {{ signal?: AbortSignal } | undefined} exec - execution facts.
   * @returns {Promise<Record<string, any>>} commit facts.
   */
  async function commitFiles(input = {}, exec) {
    if (typeof input.sourceDir !== 'string' || input.sourceDir.trim() === '') {
      throw new GithubError('bad-request', 'sourceDir is required for commit_files.')
    }
    const { binding, owner, repo, token } = await contextOf()
    const root = workspaceRoot(exec)
    const sourceDir = resolveInWorkspace(root, input.sourceDir)
    let info
    try {
      info = await stat(sourceDir)
    } catch {
      throw new GithubError('bad-request', `Source directory does not exist: ${input.sourceDir}`)
    }
    if (!info.isDirectory()) throw new GithubError('bad-request', `Source path is not a directory: ${input.sourceDir}`)
    const { files, total } = await collectCommitFiles(sourceDir)
    if (files.length === 0) throw new GithubError('bad-request', `No files found in ${input.sourceDir}.`)
    const resolved = await resolveSessionBranch(exec, binding, input)
    if (resolved.kind === 'cancelled') return { cancelled: true, reason: 'branch-selection-cancelled' }
    if (resolved.kind === 'select') {
      return {
        branchSelectionRequired: true,
        repository: `${owner}/${repo}`,
        branches: resolved.branches,
        instructions: 'Ask the user which branch to commit to (an existing branch or a new name); then call commit_files again with branch set.',
      }
    }
    const branch = resolved.branch
    const scan = await scanCollectedFiles(files)
    const decision = await decideScan(exec, scan, input.confirm)
    if (decision.kind === 'cancel') {
      return { cancelled: true, reason: 'confirmation-declined', scan: scanSummary(scan) }
    }
    if (decision.kind === 'needs-confirmation') {
      return {
        requiresConfirmation: true,
        scan: scanSummary(scan),
        instructions: 'Show the scan findings to the user; after explicit approval, call commit_files again with confirm=true.',
      }
    }
    const repoDir = normalizeRepoDir(input.repoDir)
    const message = typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message.trim()
      : `Commit ${files.length} files to ${branch}`
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    const signal = exec?.signal
    const existing = await requestJson('GET', `${repoPath}/git/ref/heads/${branch}`, { token: token.value, signal, allowNotFound: true })
    let parentSha
    let base = null
    if (existing !== undefined) {
      parentSha = existing?.object?.sha
    } else {
      base = branchName(input.base === undefined || input.base === ''
        ? (binding.defaultBranch || binding.branch || 'main')
        : input.base)
      const baseRef = await requestJson('GET', `${repoPath}/git/ref/heads/${base}`, { token: token.value, signal })
      parentSha = baseRef?.object?.sha
    }
    if (typeof parentSha !== 'string' || parentSha === '') throw new GithubError('not-found', 'The branch has no head commit to build on.')
    const parentCommit = await requestJson('GET', `${repoPath}/git/commits/${parentSha}`, { token: token.value, signal })
    const baseTree = parentCommit?.tree?.sha
    if (typeof baseTree !== 'string' || baseTree === '') throw new GithubError('not-found', 'Cannot read the branch tree.')
    const entries = []
    for (const file of files) {
      const bytes = await readFile(file.absolute)
      const blob = await requestJson('POST', `${repoPath}/git/blobs`, {
        token: token.value,
        signal,
        body: { content: bytes.toString('base64'), encoding: 'base64' },
      })
      if (typeof blob?.sha !== 'string' || blob.sha === '') {
        throw new GithubError('github-error', `GitHub did not return a blob for ${file.relative}.`)
      }
      entries.push({
        path: repoDir === '' ? file.relative : `${repoDir}/${file.relative}`,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      })
    }
    const tree = await requestJson('POST', `${repoPath}/git/trees`, {
      token: token.value,
      signal,
      body: { base_tree: baseTree, tree: entries },
    })
    if (typeof tree?.sha !== 'string' || tree.sha === '') throw new GithubError('github-error', 'GitHub did not return a tree.')
    const commit = await requestJson('POST', `${repoPath}/git/commits`, {
      token: token.value,
      signal,
      body: { message, tree: tree.sha, parents: [parentSha] },
    })
    if (typeof commit?.sha !== 'string' || commit.sha === '') throw new GithubError('github-error', 'GitHub did not return a commit.')
    if (existing !== undefined) {
      await requestJson('PATCH', `${repoPath}/git/refs/heads/${branch}`, {
        token: token.value,
        signal,
        body: { sha: commit.sha, force: false },
      })
    } else {
      await requestJson('POST', `${repoPath}/git/refs`, {
        token: token.value,
        signal,
        body: { ref: `refs/heads/${branch}`, sha: commit.sha },
      })
    }
    return {
      branch,
      base,
      created: existing === undefined,
      directory: repoDir === '' ? '/' : `/${repoDir}`,
      commitSha: commit.sha,
      commitUrl: `${webBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${commit.sha}`,
      branchUrl: branchUrl(owner, repo, branch),
      files: entries.map((entry) => entry.path),
      bytes: total,
      scan: scanSummary(scan),
    }
  }

  /**
   * Clone the bound repository into the workspace.
   * @param {{ target?: unknown, branch?: unknown }} input - clone request.
   * @param {{ signal?: AbortSignal } | undefined} exec - execution facts.
   * @returns {Promise<Record<string, any>>} clone facts.
   */
  async function cloneRepository(input = {}, exec) {
    const { owner, repo, token } = await contextOf()
    const root = workspaceRoot(exec)
    const target = resolveInWorkspace(root, input.target, repo)
    if (target === root) throw new GithubError('bad-request', 'The clone target cannot be the workspace root.')
    let exists = false
    try {
      const info = await stat(target)
      if (!info.isDirectory()) throw new GithubError('bad-request', `The clone target is not a directory: ${String(input.target)}`)
      exists = true
    } catch (error) {
      if (error instanceof GithubError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    if (exists) {
      const entries = await readdir(target)
      if (entries.length > 0) throw new GithubError('exists', `The clone target is not empty: ${String(input.target)}`)
    }
    await mkdir(dirname(target), { recursive: true })
    const branch = typeof input.branch === 'string' && input.branch.trim() !== '' ? branchName(input.branch) : ''
    const remote = remoteUrlOf(owner, repo)
    await runGit([
      'clone',
      ...(branch === '' ? [] : ['--branch', branch, '--single-branch']),
      remote,
      target,
    ], { cwd: root, token: token.value, signal: exec?.signal })
    let head = ''
    try {
      head = (await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        token: token.value,
        signal: exec?.signal,
      })).stdout.trim()
    } catch {
      // The clone succeeded; an unreadable HEAD only leaves the branch unnamed.
    }
    return {
      path: relative(root, target).split(sep).join('/'),
      branch: head || branch || null,
      remote,
      url: head === '' && branch === '' ? `${webBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` : branchUrl(owner, repo, head || branch),
    }
  }

  /**
   * Commit and push the whole workspace directory, initializing a repository
   * only when the caller explicitly allows it.
   * @param {{ cwd?: unknown, branch?: unknown, message?: unknown, init?: unknown, setRemote?: unknown }} input - push request.
   * @param {{ signal?: AbortSignal } | undefined} exec - execution facts.
   * @returns {Promise<Record<string, any>>} push facts.
   */
  async function pushWorkspace(input = {}, exec) {
    const { binding, owner, repo, token } = await contextOf()
    const root = workspaceRoot(exec)
    const cwd = resolveInWorkspace(root, input.cwd, '.')
    let info
    try {
      info = await stat(cwd)
    } catch {
      throw new GithubError('bad-request', `Push directory does not exist: ${String(input.cwd)}`)
    }
    if (!info.isDirectory()) throw new GithubError('bad-request', `Push path is not a directory: ${String(input.cwd)}`)
    const resolved = await resolveSessionBranch(exec, binding, input)
    if (resolved.kind === 'cancelled') return { cancelled: true, reason: 'branch-selection-cancelled' }
    if (resolved.kind === 'select') {
      return {
        branchSelectionRequired: true,
        repository: `${owner}/${repo}`,
        branches: resolved.branches,
        instructions: 'Ask the user which branch to push to (an existing branch or a new name); then call push again with branch set.',
      }
    }
    const branch = resolved.branch
    const requestedGit = (args) => runGit(['-C', cwd, ...args], { cwd, token: token.value, signal: exec?.signal })
    let inside = false
    try {
      inside = (await requestedGit(['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true'
    } catch {
      inside = false
    }
    let gitRoot = cwd
    if (!inside) {
      if (input.init !== true) {
        throw new GithubError('not-a-repo', `Not a git repository: ${cwd}. Pass init=true to initialize it.`)
      }
      await requestedGit(['init'])
    } else {
      try {
        gitRoot = (await requestedGit(['rev-parse', '--show-toplevel'])).stdout.trim() || cwd
      } catch {
        gitRoot = cwd
      }
      const rel = relative(root, gitRoot)
      if (rel !== '' && (isAbsolute(rel) || rel.startsWith('..'))) {
        throw new GithubError('bad-request', `The git repository root is outside the workspace: ${gitRoot}.`)
      }
    }
    const git = (args) => runGit(['-C', gitRoot, ...args], { cwd: gitRoot, token: token.value, signal: exec?.signal })
    const remote = remoteUrlOf(owner, repo)
    let origin = ''
    try {
      origin = (await git(['remote', 'get-url', 'origin'])).stdout.trim()
    } catch {
      origin = ''
    }
    if (origin === '') {
      await git(['remote', 'add', 'origin', remote])
    } else if (!sameRemote(origin, remote)) {
      if (input.setRemote !== true) {
        throw new GithubError('remote-mismatch', `origin points to ${sanitizeRemoteUrl(origin)}, not ${remote}. Pass setRemote=true to replace it.`)
      }
      await git(['remote', 'set-url', 'origin', remote])
    } else if (sanitizeRemoteUrl(origin) !== origin) {
      await git(['remote', 'set-url', 'origin', remote])
    }
    await git(['add', '-A'])
    const staged = await git(['diff', '--cached', '--name-only', '-z'])
    const stagedPaths = staged.stdout.split('\0').filter((entry) => entry !== '')
    const scan = await scanStagedFiles(gitRoot, stagedPaths)
    const decision = await decideScan(exec, scan, input.confirm)
    if (decision.kind === 'cancel') {
      return { cancelled: true, reason: 'confirmation-declined', scan: scanSummary(scan) }
    }
    if (decision.kind === 'needs-confirmation') {
      return {
        requiresConfirmation: true,
        scan: scanSummary(scan),
        instructions: 'Show the scan findings to the user; after explicit approval, call push again with confirm=true.',
      }
    }
    const status = await git(['status', '--porcelain'])
    const login = binding.login ?? binding.owner ?? 'dsh'
    const message = typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message.trim()
      : 'Update workspace'
    let committed = false
    if (status.stdout.trim() !== '') {
      await git([
        '-c', `user.name=${login}`,
        '-c', `user.email=${login}@users.noreply.github.com`,
        '-c', 'commit.gpgsign=false',
        'commit', '-m', message,
      ])
      committed = true
    }
    let headSha
    try {
      headSha = (await git(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    } catch {
      throw new GithubError('empty-repository', 'The directory has no commit to push.')
    }
    await git(['push', 'origin', `HEAD:refs/heads/${branch}`])
    return {
      path: relative(root, gitRoot).split(sep).join('/') || '.',
      branch,
      commitSha: headSha,
      committed,
      remote,
      url: branchUrl(owner, repo, branch),
      scan: scanSummary(scan),
    }
  }

  /**
   * Build the contents API path for one repository file or directory.
   * @param {string} owner - repository owner.
   * @param {string} repo - repository name.
   * @param {string} path - repository-relative path.
   * @param {string} ref - branch, tag, or commit; empty for the repository default.
   * @returns {string} API path with its ref query.
   */
  function contentsPath(owner, repo, path, ref) {
    const suffix = ref !== '' ? `?ref=${encodeURIComponent(ref)}` : ''
    const encoded = encodePath(path)
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encoded === '' ? '' : `/${encoded}`}${suffix}`
  }

  /**
   * List one repository directory.
   * @param {{ path?: unknown, ref?: unknown }} input - directory request.
   * @returns {Promise<Record<string, any>>} entries.
   */
  async function listFiles(input = {}) {
    const { owner, repo, branch, token } = await contextOf()
    const path = assertRepoPath(typeof input.path === 'string' ? input.path.trim() : '', { allowEmpty: true })
    const ref = typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : branch
    const result = await requestJson('GET', contentsPath(owner, repo, path, ref), { token: token.value })
    const rows = Array.isArray(result) ? result : result === undefined ? [] : [result]
    const entries = rows.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === 'dir' ? 'directory' : entry.type,
      size: entry.size ?? null,
      sha: entry.sha ?? null,
    })).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path, ref, entries }
  }

  /**
   * List repository branches.
   * @returns {Promise<Record<string, any>>} branches.
   */
  async function branches() {
    const { owner, repo, token } = await contextOf()
    const result = await requestJson('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`, { token: token.value })
    const rows = Array.isArray(result) ? result : []
    return {
      branches: rows.map((entry) => ({
        name: entry.name,
        protected: entry.protected === true,
        sha: entry.commit?.sha ?? null,
      })),
    }
  }

  /**
   * Download one file from the bound repository.
   * @param {{ path?: unknown, ref?: unknown }} input - file request.
   * @returns {Promise<Record<string, any>>} file content as UTF-8 text or base64.
   */
  async function download(input = {}) {
    const { owner, repo, branch, token } = await contextOf()
    const path = assertRepoPath(typeof input.path === 'string' ? input.path.trim().replace(/^\/+/, '') : '')
    const ref = typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : branch
    const response = await requestJson('GET', contentsPath(owner, repo, path, ref), {
      token: token.value,
      raw: true,
      accept: 'application/vnd.github.raw',
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      throw new GithubError('not-a-file', 'The repository path names a directory, not a file.')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxFileBytes) {
      throw new GithubError('too-large', `The file is ${buffer.length} bytes; the configured limit is ${maxFileBytes} bytes.`)
    }
    const text = isText(buffer)
    const webBase = apiBase.replace(/\/api\/v3$/, '')
    return {
      path,
      ref: ref === '' ? null : ref,
      name: basename(path),
      size: buffer.length,
      encoding: text ? 'utf8' : 'base64',
      content: text ? buffer.toString('utf8') : buffer.toString('base64'),
      htmlUrl: `${webBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(ref || 'HEAD')}/${encodePath(path)}`,
    }
  }

  /**
   * Create or replace one repository file.
   * @param {{ path?: unknown, content?: unknown, encoding?: unknown, message?: unknown, branch?: unknown }} input - upload request.
   * @returns {Promise<Record<string, any>>} commit and content identity.
   */
  async function upload(input = {}) {
    const { owner, repo, branch, token } = await contextOf()
    const path = assertRepoPath(typeof input.path === 'string' ? input.path.trim().replace(/^\/+/, '') : '')
    const encoding = input.encoding === 'utf8' ? 'utf8' : 'base64'
    const raw = typeof input.content === 'string' ? input.content : ''
    if (encoding === 'base64' && !/^[A-Za-z0-9+/=\s]*$/.test(raw)) {
      throw new GithubError('bad-request', 'The uploaded content is not valid base64.')
    }
    const buffer = Buffer.from(raw, encoding)
    if (buffer.length > maxFileBytes) {
      throw new GithubError('too-large', `The file is ${buffer.length} bytes; the configured limit is ${maxFileBytes} bytes.`)
    }
    if (buffer.length === 0) throw new GithubError('bad-request', 'The uploaded file is empty.')
    const ref = typeof input.branch === 'string' && input.branch.trim() !== '' ? input.branch.trim() : branch
    let sha
    try {
      const existing = await requestJson('GET', contentsPath(owner, repo, path, ref), { token: token.value })
      if (Array.isArray(existing)) throw new GithubError('bad-request', 'The target path is a directory.')
      sha = typeof existing?.sha === 'string' ? existing.sha : undefined
    } catch (error) {
      if (!(error instanceof GithubError) || error.code !== 'not-found') throw error
    }
    const message = typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message.trim()
      : `Upload ${basename(path)}`
    const result = await requestJson('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`, {
      token: token.value,
      body: {
        message,
        content: buffer.toString('base64'),
        ...(ref !== '' ? { branch: ref } : {}),
        ...(sha !== undefined ? { sha } : {}),
      },
    })
    return {
      path,
      branch: ref === '' ? null : ref,
      size: buffer.length,
      sha: result?.content?.sha ?? null,
      commitSha: result?.commit?.sha ?? null,
      htmlUrl: result?.content?.html_url ?? null,
    }
  }

  /**
   * Search repositories, code, or issues.
   * @param {{ scope?: unknown, query?: unknown }} input - search request.
   * @returns {Promise<Record<string, any>>} mapped results.
   */
  async function search(input = {}) {
    const { owner, repo, token } = await contextOf()
    const scope = input.scope === 'code' || input.scope === 'issues' ? input.scope : 'repositories'
    let query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query === '') throw new GithubError('bad-request', 'A search query is required.')
    let apiPath
    if (scope === 'repositories') {
      apiPath = `/search/repositories?per_page=30&q=${encodeURIComponent(query)}`
    } else if (scope === 'code') {
      if (!/(^|\s)repo:/.test(query)) query = `${query} repo:${owner}/${repo}`
      apiPath = `/search/code?per_page=30&q=${encodeURIComponent(query)}`
    } else {
      apiPath = `/search/issues?per_page=30&sort=updated&order=desc&q=${encodeURIComponent(query)}`
    }
    const result = await requestJson('GET', apiPath, { token: token.value })
    const rows = Array.isArray(result?.items) ? result.items : []
    return {
      scope,
      query,
      total: typeof result?.total_count === 'number' ? result.total_count : rows.length,
      items: rows.map((item) => scope === 'repositories'
        ? {
            title: item.full_name,
            subtitle: item.description ?? '',
            meta: `${item.private === true ? 'Private' : 'Public'}${item.language ? ` · ${item.language}` : ''} · ★ ${item.stargazers_count ?? 0}`,
            url: item.html_url,
          }
        : scope === 'code'
          ? {
              title: item.path,
              subtitle: item.repository?.full_name ?? '',
              meta: '',
              url: item.html_url,
            }
          : {
              title: item.title,
              subtitle: `${item.state ?? ''} · #${item.number ?? ''} · ${item.repository_url?.split('/').slice(-2).join('/') ?? ''}`,
              meta: item.updated_at ?? '',
              url: item.html_url,
            }),
    }
  }

  /**
   * List repositories the bound account can reach.
   * @param {{ query?: unknown }} input - optional search text.
   * @returns {Promise<Record<string, any>>} repositories.
   */
  async function listRepos(input = {}) {
    const binding = await readBinding()
    const token = await tokenInfo(binding)
    if (token === undefined) throw new GithubError('unauthenticated', 'Bind a GitHub account in Settings > GitHub first.')
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    const apiPath = query !== ''
      ? `/search/repositories?per_page=30&q=${encodeURIComponent(query)}`
      : '/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator,organization_member'
    const result = await requestJson('GET', apiPath, { token: token.value })
    const rows = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    return {
      total: typeof result?.total_count === 'number' ? result.total_count : rows.length,
      repos: rows.map((entry) => ({
        fullName: entry.full_name,
        private: entry.private === true,
        description: entry.description ?? '',
        defaultBranch: entry.default_branch ?? '',
        updatedAt: entry.updated_at ?? '',
        htmlUrl: entry.html_url,
      })),
    }
  }

  /** One operation table shared by the route and the Tool. */
  const operations = {
    status,
    bind,
    unbind,
    list_repos: listRepos,
    branches,
    list_files: listFiles,
    download,
    upload,
    search,
  }

  ctx.inject(['webServer', 'connection'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        const rejection = routeCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: 'content-type must be application/json' } })
          return
        }
        let text
        try {
          text = await readBoundedBody(req)
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body unreadable' } })
          return
        }
        if (text === null) {
          sendJson(res, 413, { ok: false, error: { code: 'payload-too-large', message: 'request body is too large' } })
          return
        }
        let body
        try {
          body = JSON.parse(text)
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body must be JSON' } })
          return
        }
        const op = body?.op
        const handler = typeof op === 'string' ? operations[op] : undefined
        if (handler === undefined) {
          sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `unknown operation: ${String(op)}` } })
          return
        }
        try {
          const params = body?.params !== null && typeof body?.params === 'object' ? body.params : {}
          sendJson(res, 200, { ok: true, data: await handler(params) })
        } catch (error) {
          const failure = error instanceof GithubError
            ? { code: error.code, message: error.message, status: error.status }
            : { code: 'internal', message: error instanceof Error ? error.message : String(error), status: 0 }
          sendJson(res, 200, { ok: false, error: failure })
        }
      },
    }), `github-integration: POST ${RPC_PATH}`)
  })

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'github-integration',
      order: 1900,
      text: 'GitHub operations use the account and repository bound in Settings > GitHub. When the `github` tool is available, use it for GitHub status, repository/branch/file reads, download, upload, search, branch creation, multi-file commits, clone, and push before `bash`, `git`, or `gh`. On the first push, upload, or commit in a session, the tool asks the user to choose an existing branch or type a new branch, then reuses that choice for later writes in the same session. Before writing, it scans the files for private keys, tokens, environment files, and temporary files, and asks the user to confirm any finding. Do not pass `branch` or `confirm` to skip these interactions unless the user explicitly chose the branch or approved the findings. If the tool reports branchSelectionRequired or requiresConfirmation, ask the user with ask_user_question and retry. Never ask for a token in chat.',
    }), 'github-integration: routing section')
  }

  /**
   * Render a tool result as bounded pretty JSON.
   * @param {unknown} value - canonical value.
   * @returns {string} model-facing text.
   */
  function renderValue(value) {
    const text = JSON.stringify(value, null, 2) ?? 'null'
    return text.length > TOOL_RENDER_LIMIT ? `${text.slice(0, TOOL_RENDER_LIMIT)}\n… (truncated)` : text
  }

  ctx.effect(() => ctx.tools.register({
    name: 'github',
    description: 'Use this tool for GitHub operations before shell git/gh. The account and repository are bound in Settings > GitHub; never ask the user for a token in chat. On the first push, upload, or commit in a session it asks the user to choose a branch and remembers it for later writes; before writing it scans for keys, secrets, environment files, and temporary files and asks for confirmation when needed. Actions: status, list_repos, search, branches, list_files, download, upload (one file to a branch), create_branch, commit_files (a local folder as one commit; creates the branch when missing), clone (git clone into the workspace), push (commit and push the whole workspace directory with git).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'status', 'list_repos', 'search', 'branches', 'list_files', 'download', 'upload',
          'create_branch', 'commit_files', 'clone', 'push',
        ],
        description: 'The operation to run.',
      },
      query: { type: 'string', description: 'Search text, or a filter for list_repos.' },
      scope: { type: 'string', enum: ['repositories', 'code', 'issues'], description: 'Search scope; defaults to repositories.' },
      path: { type: 'string', description: 'Repository-relative file path for download, or directory path for list_files.' },
      ref: { type: 'string', description: 'Branch, tag, or commit for download and list_files; defaults to the bound branch.' },
      localPath: { type: 'string', description: 'Workspace-local file to upload; required for upload.' },
      remotePath: { type: 'string', description: 'Target repository path for upload; defaults to the local file name.' },
      message: { type: 'string', description: 'Commit message for upload, commit_files, and push.' },
      branch: { type: 'string', description: 'Explicit branch for this write; when omitted the session branch is reused, or the user is asked on the first write.' },
      base: { type: 'string', description: 'Base branch for create_branch, and for a new branch created by commit_files, upload, or push.' },
      sourceDir: { type: 'string', description: 'Workspace-relative or absolute folder committed by commit_files; required for that action.' },
      repoDir: { type: 'string', description: 'Target folder inside the repository for commit_files; defaults to the repository root.' },
      target: { type: 'string', description: 'Workspace-relative clone target for clone; defaults to the repository name.' },
      cwd: { type: 'string', description: 'Workspace-relative directory pushed by push; defaults to the workspace root.' },
      init: { type: 'boolean', description: 'For push: initialize a git repository when the directory has none.' },
      setRemote: { type: 'boolean', description: 'For push: replace an existing origin that points at another repository.' },
      confirm: { type: 'boolean', description: 'For upload, commit_files, and push: proceed after the user explicitly approved the scan findings. Do not set without that approval.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args, exec) {
      switch (args.action) {
        case 'status':
          return await status({ verify: true })
        case 'list_repos':
          return await listRepos({ query: args.query })
        case 'search':
          return await search({ scope: args.scope, query: args.query })
        case 'branches':
          return await branches()
        case 'list_files':
          return await listFiles({ path: args.path, ref: args.ref })
        case 'download': {
          if (typeof args.path !== 'string' || args.path.trim() === '') {
            throw new GithubError('bad-request', '`path` is required for download.')
          }
          const result = await download({ path: args.path, ref: args.ref })
          if (result.size > TOOL_TEXT_LIMIT) {
            return {
              ...result,
              content: undefined,
              truncated: true,
              note: 'The file is larger than the tool text limit. Download it from Settings > GitHub for the full bytes.',
            }
          }
          if (result.encoding === 'utf8' && result.content.length > TOOL_TEXT_LIMIT) {
            return { ...result, content: result.content.slice(0, TOOL_TEXT_LIMIT), truncated: true }
          }
          return result
        }
        case 'upload': {
          if (typeof args.localPath !== 'string' || args.localPath.trim() === '') {
            throw new GithubError('bad-request', '`localPath` is required for upload.')
          }
          const fs = ctx.get('fs')
          if (fs === undefined) throw new GithubError('unavailable', 'File access is unavailable in this profile.')
          let cwd = process.cwd()
          const workingDirectory = ctx.get('workingDirectory')
          if (exec.agent !== undefined && workingDirectory !== undefined) {
            try {
              cwd = workingDirectory.get(exec.agent.session) ?? cwd
            } catch {
              // Keep the process directory when the Session directory cannot be resolved.
            }
          }
          const target = await fs.resolve(args.localPath, { cwd, signal: exec.signal })
          const bytes = await fs.readBytes(target, exec.signal, maxFileBytes)
          const remotePath = typeof args.remotePath === 'string' && args.remotePath.trim() !== ''
            ? args.remotePath.trim()
            : basename(target.displayPath ?? args.localPath)
          const context = await contextOf()
          const resolved = await resolveSessionBranch(exec, context.binding, { branch: args.branch })
          if (resolved.kind === 'cancelled') return { cancelled: true, reason: 'branch-selection-cancelled' }
          if (resolved.kind === 'select') {
            return {
              branchSelectionRequired: true,
              repository: `${context.owner}/${context.repo}`,
              branches: resolved.branches,
              instructions: 'Ask the user which branch to upload to (an existing branch or a new name); then call upload again with branch set.',
            }
          }
          const buffer = Buffer.from(bytes)
          const scan = { findings: scanBuffer(remotePath, buffer), checked: 1, truncated: false }
          const decision = await decideScan(exec, scan, args.confirm)
          if (decision.kind === 'cancel') {
            return { cancelled: true, reason: 'confirmation-declined', scan: scanSummary(scan) }
          }
          if (decision.kind === 'needs-confirmation') {
            return {
              requiresConfirmation: true,
              scan: scanSummary(scan),
              instructions: 'Show the scan findings to the user; after explicit approval, call upload again with confirm=true.',
            }
          }
          await ensureBranch(
            context.owner,
            context.repo,
            context.token.value,
            resolved.branch,
            args.base ?? context.binding.defaultBranch,
          )
          const result = await upload({
            path: remotePath,
            content: buffer.toString('base64'),
            encoding: 'base64',
            message: args.message,
            branch: resolved.branch,
          })
          return { ...result, branch: resolved.branch, scan: scanSummary(scan) }
        }
        case 'create_branch':
          return await createBranch({ branch: args.branch, base: args.base }, exec)
        case 'commit_files':
          return await commitFiles({
            sourceDir: args.sourceDir,
            branch: args.branch,
            base: args.base,
            repoDir: args.repoDir,
            message: args.message,
            confirm: args.confirm,
          }, exec)
        case 'clone':
          return await cloneRepository({ target: args.target, branch: args.branch }, exec)
        case 'push':
          return await pushWorkspace({
            cwd: args.cwd,
            branch: args.branch,
            message: args.message,
            init: args.init,
            setRemote: args.setRemote,
            confirm: args.confirm,
          }, exec)
        default:
          throw new GithubError('bad-request', `Unknown action: ${String(args.action)}`)
      }
    },
  }), 'github-integration: github tool')
}
