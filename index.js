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

import { basename } from 'node:path'

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
    const { body, token, signal, accept = 'application/vnd.github+json', raw = false } = options
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

  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer !== undefined && connection !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
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
    description: 'Read and change files in the GitHub repository bound in Settings > GitHub, and search GitHub. Requires the user to bind an account first; never ask the user for a token in chat. Actions: status (confirm the binding), list_repos, search (scope repositories|code|issues), branches, list_files (repository directory), download (repository file, returns UTF-8 text or base64), upload (local workspace file to a repository path).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'list_repos', 'search', 'branches', 'list_files', 'download', 'upload'],
        description: 'The operation to run.',
      },
      query: { type: 'string', description: 'Search text, or a filter for list_repos.' },
      scope: { type: 'string', enum: ['repositories', 'code', 'issues'], description: 'Search scope; defaults to repositories.' },
      path: { type: 'string', description: 'Repository-relative file path for download, or directory path for list_files.' },
      ref: { type: 'string', description: 'Branch, tag, or commit for download and list_files; defaults to the bound branch.' },
      localPath: { type: 'string', description: 'Workspace-local file to upload; required for upload.' },
      remotePath: { type: 'string', description: 'Target repository path for upload; defaults to the local file name.' },
      message: { type: 'string', description: 'Commit message for upload.' },
      branch: { type: 'string', description: 'Target branch for upload; defaults to the bound branch.' },
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
          return await upload({
            path: remotePath,
            content: Buffer.from(bytes).toString('base64'),
            encoding: 'base64',
            message: args.message,
            branch: args.branch,
          })
        }
        default:
          throw new GithubError('bad-request', `Unknown action: ${String(args.action)}`)
      }
    },
  }), 'github-integration: github tool')
}
