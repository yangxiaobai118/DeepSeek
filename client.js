window.__ModuleLoader__.load({
  id: '@local/github-integration',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'github-integration'
    const TAB_ORDER = ['files', 'upload', 'search']

    const EN = {
      nav: 'GitHub',
      title: 'GitHub',
      intro: 'Bind a personal access token, then browse, download, upload, and search repositories. The token stays in the local credential store, never in configuration. Binding also lets the github agent tool read and write that repository.',
      connectedAs: 'Connected as {login}',
      connected: 'Connected',
      notConnected: 'Not connected',
      repoLine: '{repo} · branch {branch}',
      defaultBranch: 'default branch',
      tokenStored: 'Token stored locally',
      tokenEnv: 'Using {ref}',
      noToken: 'No token configured',
      bindingTitle: 'Binding',
      bindingHint: 'Create a fine-grained or classic token with repository contents read and write. Leave the token blank to keep the current one, or to use GITHUB_TOKEN from the environment.',
      tokenLabel: 'Personal access token',
      showToken: 'Show token',
      hideToken: 'Hide token',
      tokenPlaceholder: 'github_pat_… or ghp_…',
      keepTokenPlaceholder: 'Leave blank to keep the current token',
      ownerLabel: 'Owner',
      repoLabel: 'Repository',
      branchLabel: 'Branch',
      branchOptional: 'Optional; defaults to the repository default branch',
      connect: 'Bind repository',
      disconnect: 'Disconnect',
      filesTab: 'Files',
      uploadTab: 'Upload',
      searchTab: 'Search',
      filesTitle: 'Repository files',
      refresh: 'Refresh',
      root: 'root',
      dir: 'folder',
      file: 'file',
      emptyDir: 'This folder is empty.',
      noBinding: 'Bind a repository above to browse and upload files.',
      download: 'Download',
      save: 'Save file',
      close: 'Close',
      previewTitle: 'Preview',
      binaryPreview: 'Binary file. Save it to keep the full bytes.',
      previewTruncated: 'Preview truncated; saving keeps the full file.',
      uploadTitle: 'Upload a file',
      chooseFile: 'Choose a file',
      noFile: 'No file selected',
      remotePath: 'Repository path',
      remotePathRequired: 'Enter a repository path for the upload.',
      commitMessage: 'Commit message',
      upload: 'Upload',
      uploadDone: 'Uploaded {path}.',
      sizeHint: 'Files up to {size} are accepted.',
      uploadReplaceHint: 'A file at the same path is replaced.',
      overwriteConfirm: 'A file already exists at {path}. Replace it?',
      searchTitle: 'Search GitHub',
      searchPlaceholder: 'Search repositories, code, or issues',
      search: 'Search',
      searchResults: 'Showing {shown} of {total} results',
      noResults: 'No results.',
      openOnGithub: 'Open on GitHub',
      scopeRepos: 'Repositories',
      scopeCode: 'Code in bound repository',
      scopeIssues: 'Issues and pull requests',
      scopeLabel: 'Scope',
      queryLabel: 'Query',
      statusLabel: 'Connection status',
      statusUnavailable: 'Status unavailable',
      statusUnavailableHint: 'The plugin route could not be read. Retry, or reload the page.',
      tokenCheckFailed: 'Connected, but the token check failed',
      tokenCheckFailedHint: 'The stored token was rejected. Bind again with a valid token.',
      errorNoBinding: 'Bind a repository first.',
      boundNotice: 'Repository bound.',
      unboundNotice: 'Binding removed.',
      unbindConfirm: 'Remove the locally stored binding and token? The token stays valid on GitHub until you revoke it at github.com/settings/tokens. A GITHUB_TOKEN from the environment is not removed.',
      loading: 'Working…',
      loadingFiles: 'Loading files…',
      filesUnavailable: 'Files could not be loaded.',
      retry: 'Retry',
      required: 'Owner and repository are required.',
      codeHint: 'Code search runs inside the bound repository.',
      branchPlaceholder: 'main',
      pathPlaceholder: 'docs/guide.md',
      messagePlaceholder: 'Update docs/guide.md',
      defaultCommit: 'Upload {name}',
      fileTooLarge: 'This file exceeds the configured size limit.',
      errUnauthenticated: 'The GitHub token is missing or rejected. Bind again in Settings > GitHub.',
      errNotFound: 'GitHub did not find that resource, or the token cannot access it.',
      errRateLimited: 'GitHub rate limit reached. Wait and try again.',
      errTimeout: 'GitHub did not answer in time.',
      errNotBound: 'Bind a repository first.',
      errTooLarge: 'The file exceeds the size limit.',
      errValidation: 'GitHub rejected the request.',
      errNetwork: 'Cannot reach GitHub. Check the network or proxy.',
      errCancelled: 'The request was cancelled.',
      errInternal: 'The plugin failed to complete the request.',
      errSession: 'The browser session expired. Reload the page.',
      errUnknown: 'The request failed.',
    }

    const ZH = {
      nav: 'GitHub',
      title: 'GitHub',
      intro: '绑定个人访问令牌后，即可浏览、下载、上传和搜索仓库。令牌保存在本地凭据库中，不会写入配置文件。绑定后，github 智能体工具也可以读写该仓库。',
      connectedAs: '已连接为 {login}',
      connected: '已连接',
      notConnected: '未连接',
      repoLine: '{repo} · 分支 {branch}',
      defaultBranch: '默认分支',
      tokenStored: '令牌已保存在本地',
      tokenEnv: '正在使用 {ref}',
      noToken: '未配置令牌',
      bindingTitle: '仓库绑定',
      bindingHint: '请创建一个具有仓库内容读写权限的细粒度或经典令牌。令牌留空表示沿用当前令牌，或使用环境变量 GITHUB_TOKEN。',
      tokenLabel: '个人访问令牌',
      showToken: '显示令牌',
      hideToken: '隐藏令牌',
      tokenPlaceholder: 'github_pat_… 或 ghp_…',
      keepTokenPlaceholder: '留空以沿用当前令牌',
      ownerLabel: '所有者',
      repoLabel: '仓库',
      branchLabel: '分支',
      branchOptional: '可选，默认使用仓库默认分支',
      connect: '绑定仓库',
      disconnect: '断开连接',
      filesTab: '文件',
      uploadTab: '上传',
      searchTab: '搜索',
      filesTitle: '仓库文件',
      refresh: '刷新',
      root: '根目录',
      dir: '目录',
      file: '文件',
      emptyDir: '此文件夹为空。',
      noBinding: '请在上方绑定仓库后再浏览或上传文件。',
      download: '下载',
      save: '保存文件',
      close: '关闭',
      previewTitle: '预览',
      binaryPreview: '二进制文件，保存后可获得完整内容。',
      previewTruncated: '预览已截断，保存时会写入完整文件。',
      uploadTitle: '上传文件',
      chooseFile: '选择文件',
      noFile: '尚未选择文件',
      remotePath: '仓库内路径',
      remotePathRequired: '请输入上传到仓库的路径。',
      commitMessage: '提交说明',
      upload: '上传',
      uploadDone: '已上传 {path}。',
      sizeHint: '支持不超过 {size} 的文件。',
      uploadReplaceHint: '同一路径的已有文件会被替换。',
      overwriteConfirm: '{path} 已存在，要替换它吗？',
      searchTitle: '搜索 GitHub',
      searchPlaceholder: '搜索仓库、代码或议题',
      search: '搜索',
      searchResults: '显示 {shown} / {total} 条结果',
      noResults: '没有结果。',
      openOnGithub: '在 GitHub 中打开',
      scopeRepos: '仓库',
      scopeCode: '已绑定仓库中的代码',
      scopeIssues: '议题与合并请求',
      scopeLabel: '范围',
      queryLabel: '关键词',
      statusLabel: '连接状态',
      statusUnavailable: '无法读取状态',
      statusUnavailableHint: '无法访问插件路由。请重试，或刷新页面。',
      tokenCheckFailed: '已连接，但令牌校验失败',
      tokenCheckFailedHint: '保存的令牌被拒绝，请使用有效令牌重新绑定。',
      errorNoBinding: '请先绑定仓库。',
      boundNotice: '仓库已绑定。',
      unboundNotice: '已移除绑定。',
      unbindConfirm: '要移除本地保存的绑定和令牌吗？令牌在 GitHub 上仍然有效，直到你在 github.com/settings/tokens 撤销它。环境变量中的 GITHUB_TOKEN 不会被移除。',
      loading: '处理中…',
      loadingFiles: '正在加载文件…',
      filesUnavailable: '无法加载文件。',
      retry: '重试',
      required: '所有者与仓库名不能为空。',
      codeHint: '代码搜索范围限定在已绑定的仓库内。',
      branchPlaceholder: 'main',
      pathPlaceholder: 'docs/guide.md',
      messagePlaceholder: '更新 docs/guide.md',
      defaultCommit: '上传 {name}',
      fileTooLarge: '文件超过了配置的大小限制。',
      errUnauthenticated: 'GitHub 令牌缺失或被拒绝，请在「设置 > GitHub」中重新绑定。',
      errNotFound: 'GitHub 未找到该资源，或令牌无权访问。',
      errRateLimited: '已触发 GitHub 频率限制，请稍后再试。',
      errTimeout: 'GitHub 响应超时。',
      errNotBound: '请先绑定仓库。',
      errTooLarge: '文件超过大小限制。',
      errValidation: 'GitHub 拒绝了该请求。',
      errNetwork: '无法连接 GitHub，请检查网络或代理。',
      errCancelled: '请求已取消。',
      errInternal: '插件执行请求失败。',
      errSession: '浏览器会话已过期，请刷新页面。',
      errUnknown: '请求失败。',
    }

    const CSS = `
.ghp-root { display: flex; flex-direction: column; gap: 12px; max-width: 760px; color: var(--dsw-alias-label-primary); }
.ghp-heading { margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; }
.ghp-intro { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.ghp-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-settings-card-fill); }
.ghp-cardTitle { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.ghp-statusRow { display: flex; align-items: center; gap: 12px; }
.ghp-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.ghp-dot-on { background: var(--dsw-alias-state-success-primary); }
.ghp-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.ghp-statusText { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ghp-statusTitle { font-size: 13px; font-weight: 600; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-statusMeta { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ghp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.ghp-full { grid-column: 1 / -1; }
.ghp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ghp-label { font-size: 12px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.ghp-input, .ghp-select { height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); min-width: 0; }
.ghp-input:disabled, .ghp-select:disabled { opacity: 0.6; }
.ghp-input:focus-visible, .ghp-select:focus-visible, .ghp-btn:focus-visible, .ghp-tab:focus-visible, .ghp-crumb:focus-visible, .ghp-result:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.ghp-row:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.ghp-secret { position: relative; display: flex; min-width: 0; }
.ghp-secretInput { width: 100%; padding-right: 38px; font-family: var(--dsw-font-mono); }
.ghp-secretInput.ghp-secretHidden { color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--dsw-alias-label-primary); }
.ghp-secretMask { position: absolute; top: 0; left: 11px; right: 38px; height: 32px; line-height: 32px; overflow: hidden; white-space: nowrap; font-family: var(--dsw-font-mono); font-size: 13px; color: var(--dsw-alias-label-primary); pointer-events: none; user-select: none; }
.ghp-secretToggle { position: absolute; top: 4px; right: 4px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.ghp-secretToggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ghp-secretToggle:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.ghp-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ghp-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ghp-btn { display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 12px; border: 0.5px solid transparent; border-radius: var(--dsw-radius-sm); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
.ghp-btn:disabled { opacity: 0.55; cursor: default; }
.ghp-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-on-color); }
.ghp-btn-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); }
.ghp-btn-ghost { background: transparent; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.ghp-btn-ghost:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghp-btn-link { height: auto; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-link); }
.ghp-btn-link:not(:disabled):hover { text-decoration: underline; }
.ghp-tabs { display: flex; align-items: flex-end; gap: 22px; margin-top: 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.ghp-tab { position: relative; border: 0; padding: 7px 1px 9px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.ghp-tab[data-active='true'] { color: var(--dsw-alias-label-primary); }
.ghp-tab[data-active='true']::after, .ghp-tab:focus-visible::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary); content: ''; }
.ghp-tab:disabled { opacity: 0.6; cursor: default; }
.ghp-panel { display: flex; flex-direction: column; gap: 12px; }
.ghp-panel[hidden] { display: none; }
.ghp-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ghp-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ghp-crumb { border: 0; background: transparent; padding: 2px 4px; border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.ghp-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghp-crumbSep { opacity: 0.6; }
.ghp-list { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); overflow: hidden; }
.ghp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 8px 12px; border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: transparent; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); text-align: start; cursor: pointer; }
.ghp-row:last-child { border-bottom: 0; }
.ghp-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghp-rowName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-rowNameDir { font-weight: 500; }
.ghp-rowMeta { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ghp-empty { margin: 0; padding: 10px 12px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.ghp-preview { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.ghp-previewHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ghp-previewName { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-pre { margin: 0; max-height: 320px; overflow: auto; padding: 10px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-markdown-code-block); font-family: var(--dsw-font-mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.ghp-fileInput { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.ghp-results { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); overflow: hidden; }
.ghp-result { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); text-decoration: none; color: inherit; }
.ghp-result:last-child { border-bottom: 0; }
.ghp-result:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghp-resultTitle { font-size: 13px; font-weight: 500; color: var(--dsw-alias-link); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-resultSub { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.ghp-resultMeta { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ghp-link { font-size: 12px; color: var(--dsw-alias-link); text-decoration: none; }
.ghp-link:hover { text-decoration: underline; }
.ghp-error { margin: 0; padding: 9px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
.ghp-notice { margin: 0; padding: 9px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 1.5; }
@media (max-width: 560px) { .ghp-grid { grid-template-columns: 1fr; } }
`

    /** Stable failure codes mapped to localized copy. */
    const ERROR_KEYS = {
      unauthenticated: 'errUnauthenticated',
      'not-found': 'errNotFound',
      'rate-limited': 'errRateLimited',
      timeout: 'errTimeout',
      'not-bound': 'errNotBound',
      'too-large': 'errTooLarge',
      'payload-too-large': 'errTooLarge',
      validation: 'errValidation',
      network: 'errNetwork',
      cancelled: 'errCancelled',
      internal: 'errInternal',
      session: 'errSession',
    }

    /**
     * Format a byte count for compact metadata.
     * @param {number | null | undefined} value - bytes.
     * @returns {string} readable size, or an empty string when unknown.
     */
    function formatSize(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Eye glyph for the token visibility toggle.
     * @param {boolean} visible - whether the token text is visible.
     * @returns {import('react').ReactElement} inline SVG icon.
     */
    function eyeIcon(visible) {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'eye', d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z' }),
        h('circle', { key: 'pupil', cx: 12, cy: 12, r: 2.5 }),
        visible ? null : h('path', { key: 'slash', d: 'M4 4 20 20' }),
      ])
    }

    /**
     * Decode standard base64 into bytes.
     * @param {string} base64 - encoded text.
     * @returns {Uint8Array} decoded bytes.
     */
    function base64ToBytes(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /**
     * Encode a browser File as standard base64.
     * @param {File} file - chosen file.
     * @returns {Promise<string>} base64 text.
     */
    async function fileToBase64(file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const chunk = 0x8000
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
      }
      return btoa(binary)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'github-integration: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'github-integration: zh dictionary')

        /**
         * Call the plugin's Host route.
         * @param {string} op - operation name.
         * @param {Record<string, unknown>} params - operation parameters.
         * @returns {Promise<any>} operation result.
         */
        async function call(op, params) {
          let response
          try {
            response = await fetch(new URL('github-integration/rpc', document.baseURI), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op, params }),
              signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(90_000) : undefined,
            })
          } catch (failure) {
            const error = new Error(t('errNetwork'))
            error.code = failure?.name === 'TimeoutError' ? 'timeout' : 'network'
            throw error
          }
          let body
          try {
            body = await response.json()
          } catch {
            body = undefined
          }
          if (body === undefined) {
            const error = new Error(response.status === 401 ? t('errSession') : `HTTP ${response.status}`)
            error.code = response.status === 401 ? 'session' : 'http'
            throw error
          }
          if (body.ok !== true) {
            const error = new Error(typeof body.error?.message === 'string' ? body.error.message : t('errUnknown'))
            error.code = body.error?.code
            throw error
          }
          return body.data
        }

        /**
         * The Settings > GitHub page.
         * @returns {import('react').ReactElement} the page.
         */
        function GithubSection() {
          React.useSyncExternalStore(
            (listener) => ctx.locale.subscribe(listener),
            () => ctx.locale.getSnapshot().revision,
            () => 0,
          )
          const [status, setStatus] = React.useState(null)
          const [statusState, setStatusState] = React.useState('loading')
          const [busy, setBusy] = React.useState(false)
          const [message, setMessage] = React.useState(null)
          const [tab, setTab] = React.useState('files')
          const [form, setForm] = React.useState({ token: '', owner: '', repo: '', branch: '' })
          const [tokenVisible, setTokenVisible] = React.useState(false)
          const [files, setFiles] = React.useState(null)
          const [path, setPath] = React.useState('')
          const [refInput, setRefInput] = React.useState('')
          const [uploadRef, setUploadRef] = React.useState('')
          const [preview, setPreview] = React.useState(null)
          const [uploadFile, setUploadFile] = React.useState(null)
          const [uploadPath, setUploadPath] = React.useState('')
          const [uploadMessage, setUploadMessage] = React.useState('')
          const [searchScope, setSearchScope] = React.useState('repositories')
          const [searchQuery, setSearchQuery] = React.useState('')
          const [searchResult, setSearchResult] = React.useState(null)
          const fileInput = React.useRef(null)
          const previewRef = React.useRef(null)
          const tabRefs = React.useRef({})
          const inFlight = React.useRef(0)

          /**
           * Turn one failure into localized, user-facing text.
           * @param {any} failure - thrown value.
           * @returns {string} display text.
           */
          function describeFailure(failure) {
            const key = ERROR_KEYS[failure?.code]
            if (key === undefined) {
              return failure instanceof Error ? failure.message : String(failure)
            }
            const base = t(key)
            if ((failure.code === 'validation' || failure.code === 'internal') && typeof failure.message === 'string' && failure.message !== '') {
              return `${base} ${failure.message}`
            }
            return base
          }

          /**
           * Run one interaction with busy and message bookkeeping.
           * @param {() => Promise<void>} task - the interaction.
           * @param {'bind'|'files'|'upload'|'search'} area - where failures appear.
           * @returns {Promise<void>} when it settles.
           */
          async function run(task, area = 'bind') {
            inFlight.current += 1
            setBusy(true)
            setMessage(null)
            try {
              await task()
            } catch (failure) {
              setMessage({ kind: 'error', text: describeFailure(failure), area })
            } finally {
              inFlight.current -= 1
              if (inFlight.current === 0) setBusy(false)
            }
          }

          /**
           * Show a success line in one area.
           * @param {string} text - message.
           * @param {'bind'|'files'|'upload'|'search'} area - target area.
           * @returns {void}
           */
          function notify(text, area) {
            setMessage({ kind: 'notice', text, area })
          }

          /**
           * Apply a status view to the page and both ref inputs.
           * @param {any} view - status returned by the Host.
           * @returns {void}
           */
          function applyStatus(view) {
            setStatus(view)
            setStatusState('ready')
            setTokenVisible(false)
            setForm((current) => ({
              token: '',
              owner: view.owner ?? current.owner,
              repo: view.repo ?? current.repo,
              branch: view.branch ?? current.branch,
            }))
            setRefInput(view.branch ?? '')
            setUploadRef((current) => view.branch ?? current)
          }

          /**
           * Load one repository directory.
           * @param {string} nextPath - repository path.
           * @param {string} [nextRef] - branch for this read.
           * @returns {Promise<any>} the listing view.
           */
          async function loadFiles(nextPath, nextRef = refInput) {
            const view = await call('list_files', { path: nextPath, ref: nextRef })
            setFiles(view)
            setPath(view.path ?? '')
            setPreview(null)
            return view
          }

          /**
           * Read status and, for a bound repository, its root listing.
           * @returns {Promise<void>} when the page has its baseline.
           */
          async function refreshStatus() {
            setStatusState('loading')
            let view
            try {
              view = await call('status', { verify: true })
            } catch (failure) {
              setStatusState('failed')
              throw failure
            }
            applyStatus(view)
            if (view.bound === true) {
              setFiles(null)
              setPreview(null)
              setPath('')
              setSearchResult(null)
              await loadFiles('', view.branch ?? '')
            }
          }

          React.useEffect(() => {
            void run(refreshStatus, 'bind')
            // The baseline read runs once per mounted page.
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [])

          React.useEffect(() => {
            if (preview !== null) previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }, [preview])

          const bind = () => run(async () => {
            if (form.owner.trim() === '' || form.repo.trim() === '') {
              throw new Error(t('required'))
            }
            const submittedToken = form.token.trim()
            const view = await call('bind', {
              token: submittedToken === '' ? undefined : submittedToken,
              owner: form.owner,
              repo: form.repo,
              branch: form.branch,
            })
            applyStatus(view)
            if (submittedToken !== '') {
              setForm((current) => ({ ...current, token: submittedToken }))
              setTokenVisible(false)
            }
            setFiles(null)
            setPreview(null)
            setPath('')
            setSearchResult(null)
            try {
              await loadFiles('', view.branch ?? '')
            } catch (failure) {
              throw new Error(`${t('boundNotice')} ${t('filesUnavailable')} ${describeFailure(failure)}`)
            }
            notify(t('boundNotice'), 'bind')
          }, 'bind')

          const unbind = () => run(async () => {
            if (typeof window.confirm === 'function' && !window.confirm(t('unbindConfirm'))) return
            const view = await call('unbind', {})
            applyStatus(view)
            setFiles(null)
            setPreview(null)
            setPath('')
            setSearchResult(null)
            notify(t('unboundNotice'), 'bind')
          }, 'bind')

          const openDirectory = (nextPath) => run(async () => {
            await loadFiles(nextPath)
          }, 'files')

          const openFile = (entry) => run(async () => {
            const view = await call('download', { path: entry.path, ref: refInput })
            setPreview(view)
          }, 'files')

          const savePreview = () => {
            if (preview === null) return
            const bytes = preview.encoding === 'base64'
              ? base64ToBytes(preview.content)
              : new TextEncoder().encode(preview.content)
            const url = URL.createObjectURL(new Blob([bytes]))
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = preview.name
            anchor.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
          }

          const chooseFile = (event) => {
            const file = event.target.files?.[0] ?? null
            setUploadFile(file)
            if (file === null) return
            setUploadPath((current) => (current.trim() === '' ? file.name : current))
            setUploadMessage(t('defaultCommit', { name: file.name }))
          }

          const upload = () => run(async () => {
            if (uploadFile === null) return
            if (uploadFile.size > (status?.maxFileBytes ?? 0)) throw new Error(t('fileTooLarge'))
            if (uploadPath.trim() === '') throw new Error(t('remotePathRequired'))
            const cleanPath = uploadPath.trim().replace(/^\/+/, '')
            const slash = cleanPath.lastIndexOf('/')
            const directory = slash === -1 ? '' : cleanPath.slice(0, slash)
            const name = slash === -1 ? cleanPath : cleanPath.slice(slash + 1)
            let exists = false
            try {
              const listing = await call('list_files', { path: directory, ref: uploadRef })
              exists = listing.entries.some((entry) => entry.type !== 'directory' && entry.name === name)
            } catch {
              // A listing failure must not block the upload; the Host reports the real write failure.
            }
            if (exists && typeof window.confirm === 'function' && !window.confirm(t('overwriteConfirm', { path: cleanPath }))) {
              return
            }
            const content = await fileToBase64(uploadFile)
            const view = await call('upload', {
              path: cleanPath,
              content,
              encoding: 'base64',
              message: uploadMessage,
              branch: uploadRef,
            })
            setUploadFile(null)
            setUploadPath('')
            setUploadMessage('')
            if (fileInput.current !== null) fileInput.current.value = ''
            notify(t('uploadDone', { path: view.path ?? cleanPath }), 'upload')
            if (files !== null) await loadFiles(path, refInput)
          }, 'upload')

          const search = () => run(async () => {
            if (searchQuery.trim() === '') return
            const view = await call('search', { scope: searchScope, query: searchQuery })
            setSearchResult(view)
          }, 'search')

          const selectTab = (next) => {
            setTab(next)
            if (next === 'files' && status?.bound === true && files === null) {
              void run(async () => { await loadFiles('') }, 'files')
            }
          }

          const activateTab = (next) => {
            selectTab(next)
            const button = tabRefs.current[next]
            if (button !== undefined && button !== null) button.focus()
          }

          const onTabKeyDown = (id, event) => {
            const index = TAB_ORDER.indexOf(id)
            let next
            switch (event.key) {
              case 'ArrowRight': next = TAB_ORDER[(index + 1) % TAB_ORDER.length]; break
              case 'ArrowLeft': next = TAB_ORDER[(index + TAB_ORDER.length - 1) % TAB_ORDER.length]; break
              case 'Home': next = TAB_ORDER[0]; break
              case 'End': next = TAB_ORDER[TAB_ORDER.length - 1]; break
              default: return
            }
            event.preventDefault()
            activateTab(next)
          }

          const messageFor = (area) => {
            if (message === null || message.area !== area) return null
            return h('p', {
              className: message.kind === 'error' ? 'ghp-error' : 'ghp-notice',
              role: message.kind === 'error' ? 'alert' : 'status',
            }, message.text)
          }

          const repoFull = status?.owner !== undefined && status?.owner !== null && status?.repo !== undefined && status?.repo !== null
            ? `${status.owner}/${status.repo}`
            : ''

          const tokenLine = status === null
            ? ''
            : status.tokenConfigured !== true
              ? t('noToken')
              : status.tokenSource === 'stored'
                ? t('tokenStored')
                : t('tokenEnv', { ref: String(status.tokenSource ?? '').replace(/^environment:/, '') })

          const statusTitle = statusState === 'loading'
            ? t('loading')
            : statusState === 'failed'
              ? t('statusUnavailable')
              : status?.identityError !== undefined
                ? t('tokenCheckFailed')
                : status?.bound === true
                  ? (status.login !== null && status.login !== undefined ? t('connectedAs', { login: status.login }) : t('connected'))
                  : t('notConnected')

          const statusMeta = statusState === 'failed'
            ? t('statusUnavailableHint')
            : status === null
              ? ''
              : [
                  repoFull === '' ? '' : t('repoLine', { repo: repoFull, branch: status.branch || t('defaultBranch') }),
                  tokenLine,
                  status.identityError !== undefined ? `${t('tokenCheckFailedHint')} ${status.identityError}` : '',
                ].filter(Boolean).join(' · ')

          const dotClass = 'ghp-dot'
            + (status?.bound === true && status?.identityError === undefined && statusState === 'ready' ? ' ghp-dot-on' : '')
            + (statusState === 'failed' || (statusState === 'ready' && status?.identityError !== undefined) ? ' ghp-dot-warn' : '')

          const statusCard = h('div', { className: 'ghp-card' },
            h('div', { className: 'ghp-statusRow' },
              h('span', { className: dotClass, 'aria-hidden': true }),
              h('div', { className: 'ghp-statusText', role: 'status', 'aria-live': 'polite' },
                h('span', { className: 'ghp-statusTitle' }, statusTitle),
                statusMeta === '' ? null : h('span', { className: 'ghp-statusMeta' }, statusMeta),
              ),
              statusState === 'failed'
                ? h('button', {
                    type: 'button',
                    className: 'ghp-btn ghp-btn-ghost',
                    disabled: busy,
                    onClick: () => { void run(refreshStatus, 'bind') },
                  }, t('retry'))
                : status?.bound === true
                  ? h('button', {
                      type: 'button',
                      className: 'ghp-btn ghp-btn-ghost',
                      disabled: busy,
                      onClick: () => { void unbind() },
                    }, t('disconnect'))
                  : null,
            ),
          )

          const field = (label, input, key) => h('label', { className: 'ghp-field', key }, h('span', { className: 'ghp-label' }, label), input)

          const namespaceHint = status !== null && typeof status.maxFileBytes === 'number'
            ? t('sizeHint', { size: formatSize(status.maxFileBytes) })
            : ''

          const storedTokenMask = !tokenVisible && form.token === '' && (status?.tokenLength ?? 0) > 0
          const tokenMask = !tokenVisible
            ? (form.token !== ''
                ? '*'.repeat(form.token.length)
                : storedTokenMask ? '*'.repeat(status.tokenLength) : '')
            : ''
          const tokenRevealable = form.token !== '' || (status?.tokenLength ?? 0) > 0

          const toggleToken = () => {
            if (busy) return
            if (form.token === '' && (status?.tokenLength ?? 0) > 0) {
              if (tokenVisible) {
                setTokenVisible(false)
                return
              }
              void run(async () => {
                const data = await call('reveal_token', {})
                if (typeof data?.token !== 'string' || data.token === '') throw new Error(t('errUnknown'))
                setForm((current) => ({ ...current, token: data.token }))
                setTokenVisible(true)
              }, 'bind')
              return
            }
            setTokenVisible((visible) => !visible)
          }

          const bindingCard = h('div', { className: 'ghp-card' },
            h('h3', { className: 'ghp-cardTitle' }, t('bindingTitle')),
            h('p', { className: 'ghp-hint' }, t('bindingHint')),
            h('div', { className: 'ghp-grid' },
              h('div', { className: 'ghp-full' },
                h('div', { className: 'ghp-field' },
                  h('label', { className: 'ghp-label', htmlFor: 'ghp-token' }, t('tokenLabel')),
                  h('div', { className: 'ghp-secret' },
                    h('input', {
                      id: 'ghp-token',
                      className: 'ghp-input ghp-secretInput' + (tokenVisible || form.token === '' ? '' : ' ghp-secretHidden'),
                      type: 'text',
                      autoComplete: 'new-password',
                      spellCheck: false,
                      placeholder: storedTokenMask ? '' : (status?.tokenConfigured === true ? t('keepTokenPlaceholder') : t('tokenPlaceholder')),
                      value: form.token,
                      disabled: busy,
                      onChange: (event) => { setForm((current) => ({ ...current, token: event.target.value })) },
                    }),
                    tokenMask !== ''
                      ? h('span', { className: 'ghp-secretMask', 'aria-hidden': true }, tokenMask)
                      : null,
                    h('button', {
                      type: 'button',
                      className: 'ghp-secretToggle',
                      disabled: busy || !tokenRevealable,
                      'aria-label': tokenVisible ? t('hideToken') : t('showToken'),
                      'aria-pressed': tokenVisible,
                      title: tokenVisible ? t('hideToken') : t('showToken'),
                      onClick: toggleToken,
                    }, eyeIcon(tokenVisible)),
                  ),
                ),
              ),
              field(t('ownerLabel'), h('input', {
                className: 'ghp-input',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: 'octocat',
                value: form.owner,
                disabled: busy,
                onChange: (event) => { setForm((current) => ({ ...current, owner: event.target.value })) },
              }), 'owner'),
              field(t('repoLabel'), h('input', {
                className: 'ghp-input',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: 'hello-world',
                value: form.repo,
                disabled: busy,
                onChange: (event) => { setForm((current) => ({ ...current, repo: event.target.value })) },
              }), 'repo'),
              h('div', { className: 'ghp-full' },
                field(t('branchLabel'), h('input', {
                  className: 'ghp-input',
                  type: 'text',
                  autoComplete: 'off',
                  spellCheck: false,
                  placeholder: t('branchPlaceholder'),
                  value: form.branch,
                  disabled: busy,
                  onChange: (event) => { setForm((current) => ({ ...current, branch: event.target.value })) },
                }), 'branch'),
              ),
            ),
            h('p', { className: 'ghp-hint' }, t('branchOptional')),
            h('div', { className: 'ghp-actions' },
              h('button', {
                type: 'button',
                className: 'ghp-btn ghp-btn-primary',
                disabled: busy || form.owner.trim() === '' || form.repo.trim() === '',
                onClick: () => { void bind() },
              }, t('connect')),
              busy ? h('span', { className: 'ghp-hint' }, t('loading')) : null,
              namespaceHint === '' ? null : h('span', { className: 'ghp-hint' }, namespaceHint),
            ),
          )

          const tabButton = (id, label) => h('button', {
            key: id,
            ref: (element) => { tabRefs.current[id] = element },
            type: 'button',
            role: 'tab',
            id: `ghp-tab-${id}`,
            'aria-selected': tab === id,
            'aria-controls': `ghp-panel-${id}`,
            tabIndex: tab === id ? 0 : -1,
            disabled: busy,
            className: 'ghp-tab',
            'data-active': tab === id ? 'true' : undefined,
            onClick: () => { selectTab(id) },
            onKeyDown: (event) => { onTabKeyDown(id, event) },
          }, label)

          const tabs = h('div', { className: 'ghp-tabs', role: 'tablist', 'aria-label': t('title') },
            tabButton('files', t('filesTab')),
            tabButton('upload', t('uploadTab')),
            tabButton('search', t('searchTab')),
          )

          const crumbs = []
          crumbs.push(h('button', {
            key: 'root',
            type: 'button',
            className: 'ghp-crumb',
            disabled: busy,
            onClick: () => { void openDirectory('') },
          }, t('root')))
          const parts = path === '' ? [] : path.split('/')
          parts.forEach((part, index) => {
            const target = parts.slice(0, index + 1).join('/')
            crumbs.push(h('span', { key: `sep-${target}`, className: 'ghp-crumbSep', 'aria-hidden': true }, '/'))
            crumbs.push(h('button', {
              key: `crumb-${target}`,
              type: 'button',
              className: 'ghp-crumb',
              disabled: busy,
              'aria-current': index === parts.length - 1 ? 'location' : undefined,
              onClick: () => { void openDirectory(target) },
            }, part))
          })

          const fileRows = files === null
            ? [h('div', { key: 'state', className: 'ghp-empty' },
                busy
                  ? t('loadingFiles')
                  : h('button', {
                      type: 'button',
                      className: 'ghp-btn ghp-btn-link',
                      onClick: () => { void run(async () => { await loadFiles(path, refInput) }, 'files') },
                    }, `${t('filesUnavailable')} ${t('retry')}`),
              )]
            : files.entries.length === 0
              ? [h('p', { key: 'empty', className: 'ghp-empty' }, t('emptyDir'))]
              : files.entries.map((entry) => h('button', {
                  key: entry.path,
                  type: 'button',
                  className: 'ghp-row',
                  disabled: busy,
                  onClick: () => {
                    if (entry.type === 'directory') void openDirectory(entry.path)
                    else void openFile(entry)
                  },
                },
                h('span', { className: 'ghp-rowName' + (entry.type === 'directory' ? ' ghp-rowNameDir' : '') }, entry.name + (entry.type === 'directory' ? '/' : '')),
                h('span', { className: 'ghp-rowMeta' }, entry.type === 'directory' ? t('dir') : formatSize(entry.size)),
              ))

          const previewCard = preview === null ? null : h('div', {
            ref: previewRef,
            className: 'ghp-preview',
            role: 'region',
            'aria-label': t('previewTitle'),
          },
            h('div', { className: 'ghp-previewHead' },
              h('span', { className: 'ghp-previewName' }, preview.name),
              h('div', { className: 'ghp-actions' },
                h('button', { type: 'button', className: 'ghp-btn ghp-btn-primary', onClick: savePreview }, t('save')),
                preview.htmlUrl === undefined ? null : h('a', {
                  className: 'ghp-link',
                  href: preview.htmlUrl,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                }, t('openOnGithub')),
                h('button', { type: 'button', className: 'ghp-btn ghp-btn-ghost', onClick: () => { setPreview(null) } }, t('close')),
              ),
            ),
            h('span', { className: 'ghp-hint' }, `${formatSize(preview.size)}${preview.ref === null ? '' : ` · ${preview.ref}`}`),
            preview.encoding === 'utf8'
              ? h('pre', { className: 'ghp-pre' }, preview.content.length > 200_000 ? preview.content.slice(0, 200_000) : preview.content)
              : h('p', { className: 'ghp-hint' }, t('binaryPreview')),
            preview.encoding === 'utf8' && preview.content.length > 200_000
              ? h('p', { className: 'ghp-hint' }, t('previewTruncated'))
              : null,
          )

          const filesPanel = h('div', { className: 'ghp-panel', role: 'tabpanel', id: 'ghp-panel-files', 'aria-labelledby': 'ghp-tab-files', hidden: tab !== 'files', 'aria-busy': busy },
            messageFor('files'),
            h('div', { className: 'ghp-toolbar' },
              h('span', { className: 'ghp-hint' }, t('filesTitle')),
              h('label', { className: 'ghp-field', style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
                h('span', { className: 'ghp-label' }, t('branchLabel')),
                h('input', {
                  className: 'ghp-input',
                  style: { width: '160px' },
                  type: 'text',
                  spellCheck: false,
                  value: refInput,
                  disabled: busy,
                  placeholder: t('branchPlaceholder'),
                  onChange: (event) => { setRefInput(event.target.value) },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void run(async () => { await loadFiles(path, refInput) }, 'files')
                  },
                }),
              ),
              h('button', {
                type: 'button',
                className: 'ghp-btn ghp-btn-ghost',
                disabled: busy,
                onClick: () => { void run(async () => { await loadFiles(path, refInput) }, 'files') },
              }, t('refresh')),
            ),
            h('nav', { className: 'ghp-crumbs', 'aria-label': t('filesTitle') }, crumbs),
            previewCard,
            h('div', { className: 'ghp-list' }, fileRows),
          )

          const uploadPanel = h('div', { className: 'ghp-panel', role: 'tabpanel', id: 'ghp-panel-upload', 'aria-labelledby': 'ghp-tab-upload', hidden: tab !== 'upload', 'aria-busy': busy },
            messageFor('upload'),
            h('div', { className: 'ghp-card' },
              h('h3', { className: 'ghp-cardTitle' }, t('uploadTitle')),
              h('input', {
                ref: fileInput,
                className: 'ghp-fileInput',
                type: 'file',
                tabIndex: -1,
                'aria-hidden': true,
                disabled: busy,
                onChange: chooseFile,
              }),
              h('div', { className: 'ghp-actions' },
                h('button', {
                  type: 'button',
                  className: 'ghp-btn ghp-btn-ghost',
                  disabled: busy,
                  onClick: () => { fileInput.current?.click() },
                }, t('chooseFile')),
                h('span', { className: 'ghp-hint' }, uploadFile === null ? t('noFile') : `${uploadFile.name} · ${formatSize(uploadFile.size)}`),
              ),
              h('div', { className: 'ghp-grid' },
                h('div', { className: 'ghp-full' },
                  field(t('remotePath'), h('input', {
                    className: 'ghp-input',
                    type: 'text',
                    spellCheck: false,
                    placeholder: t('pathPlaceholder'),
                    value: uploadPath,
                    disabled: busy,
                    onChange: (event) => { setUploadPath(event.target.value) },
                  }), 'upload-path'),
                ),
                field(t('branchLabel'), h('input', {
                  className: 'ghp-input',
                  type: 'text',
                  spellCheck: false,
                  placeholder: t('branchPlaceholder'),
                  value: uploadRef,
                  disabled: busy,
                  onChange: (event) => { setUploadRef(event.target.value) },
                }), 'upload-branch'),
                field(t('commitMessage'), h('input', {
                  className: 'ghp-input',
                  type: 'text',
                  placeholder: t('messagePlaceholder'),
                  value: uploadMessage,
                  disabled: busy,
                  onChange: (event) => { setUploadMessage(event.target.value) },
                }), 'upload-message'),
              ),
              h('p', { className: 'ghp-hint' }, [
                namespaceHint,
                t('uploadReplaceHint'),
              ].filter(Boolean).join(' ')),
              h('div', { className: 'ghp-actions' },
                h('button', {
                  type: 'button',
                  className: 'ghp-btn ghp-btn-primary',
                  disabled: busy || uploadFile === null,
                  onClick: () => { void upload() },
                }, t('upload')),
              ),
            ),
          )

          const results = searchResult === null
            ? null
            : h('div', { className: 'ghp-results' },
                searchResult.items.length === 0
                  ? h('p', { className: 'ghp-empty' }, t('noResults'))
                  : searchResult.items.map((item, index) => h('a', {
                      key: `${item.url}-${index}`,
                      className: 'ghp-result',
                      href: item.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    },
                    h('span', { className: 'ghp-resultTitle' }, item.title),
                    item.subtitle === '' ? null : h('span', { className: 'ghp-resultSub' }, item.subtitle),
                    item.meta === '' ? null : h('span', { className: 'ghp-resultMeta' }, item.meta),
                  )),
              )

          const searchPanel = h('div', { className: 'ghp-panel', role: 'tabpanel', id: 'ghp-panel-search', 'aria-labelledby': 'ghp-tab-search', hidden: tab !== 'search', 'aria-busy': busy },
            messageFor('search'),
            h('div', { className: 'ghp-card' },
              h('h3', { className: 'ghp-cardTitle' }, t('searchTitle')),
              h('div', { className: 'ghp-grid' },
                field(t('scopeLabel'), h('select', {
                  className: 'ghp-select',
                  value: searchScope,
                  disabled: busy,
                  onChange: (event) => { setSearchScope(event.target.value) },
                },
                  h('option', { value: 'repositories' }, t('scopeRepos')),
                  h('option', { value: 'code' }, t('scopeCode')),
                  h('option', { value: 'issues' }, t('scopeIssues')),
                ), 'search-scope'),
                field(t('queryLabel'), h('input', {
                  className: 'ghp-input',
                  type: 'search',
                  placeholder: t('searchPlaceholder'),
                  value: searchQuery,
                  disabled: busy,
                  onChange: (event) => { setSearchQuery(event.target.value) },
                  onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void search() } },
                }), 'search-query'),
              ),
              searchScope === 'code' ? h('p', { className: 'ghp-hint' }, t('codeHint')) : null,
              h('div', { className: 'ghp-actions' },
                h('button', {
                  type: 'button',
                  className: 'ghp-btn ghp-btn-primary',
                  disabled: busy || searchQuery.trim() === '',
                  onClick: () => { void search() },
                }, t('search')),
                searchResult === null ? null : h('span', { className: 'ghp-hint' }, t('searchResults', {
                  shown: searchResult.items.length,
                  total: searchResult.total,
                })),
              ),
            ),
            results,
          )

          return h('div', { className: 'ghp-root' },
            h('style', { key: 'styles' }, CSS),
            h('h2', { className: 'ghp-heading' }, t('title')),
            h('p', { className: 'ghp-intro' }, t('intro')),
            statusCard,
            bindingCard,
            messageFor('bind'),
            statusState === 'ready' && status?.bound === true
              ? h('div', null,
                  tabs,
                  busy ? h('p', { className: 'ghp-hint' }, t('loading')) : null,
                  filesPanel,
                  uploadPanel,
                  searchPanel,
                )
              : statusState === 'ready'
                ? h('p', { className: 'ghp-empty' }, t('noBinding'))
                : null,
          )
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'github',
          order: 30,
          label: () => t('nav'),
          locale: NS,
        }, GithubSection))
      },
    }
  },
})
