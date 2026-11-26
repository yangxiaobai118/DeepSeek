**Disclaimer:** This project is only for personal learning and communication, please do not use it for illegal purposes, please do not use it in a production environment.

**免责声明：** 本项目仅供个人学习与交流使用，请勿用于非法用途，请勿在生产环境中使用。

---

# GitHub integration / GitHub 集成

English | [中文](#中文)

## English

Binds a GitHub account and repository to DeepSeek Harness, then browses,
downloads, uploads, and searches from **Settings > GitHub** and from the
`github` agent tool. The token is kept in the local credential store, never in
`cordis.patch.yml`, and every operation uses the bound account's permissions.

### Install on another DSH client

The bundle is a dependency-free npm package. Build the tarball with
`npm run pack:release`, or download the `.tgz` from the repository's latest
GitHub Release. Install it into the target profile:

```sh
dsh plugin --profile <profile> add "/absolute/path/to/<tarball>.tgz"
```

In the Web GUI, open **Plugins > Add plugin** and enter the same tarball path;
if that surface accepts only a directory, extract the tarball and select the
`package/` directory. A copied source directory can be added the same way.

Restart or reload that client, then bind the token and repository again in
**Settings > GitHub**. The credential record and the per-session branch memory
live in that client's profile and are not shared with this machine.

### Bind

1. Create a personal access token (classic `repo` scope, or a fine-grained
   token with `Contents: Read and write` for the target repository).
2. Open **Settings > GitHub**, paste the token, and enter `owner` and
   `repository`; leave `branch` empty to use the repository default branch.
3. Press **Bind repository**. The page confirms the account, repository, and
   branch. **Disconnect** removes the locally stored token and binding; the
   personal access token stays valid on GitHub, so revoke it at
   `github.com/settings/tokens` when it should no longer exist. A token taken
   from `GITHUB_TOKEN` or `GH_TOKEN` is not removed by Disconnect.

A token already exported as `GITHUB_TOKEN` or `GH_TOKEN` can be used without
pasting it: leave the token field blank and press **Bind repository**.

The token field masks every character with `*` and has an eye toggle. For a
stored token, the field shows `*` for its length; clicking the eye asks the Host
for the token once and displays it for this page, and a page reload hides it
again. The token never enters the agent tool, the session log, or configuration.

### Files, upload, and search

- **Files** lists a directory at the current branch, navigates folders, and
  downloads a file. Text files preview in the page; binary files are saved from
  the preview card.
- **Upload** sends one local file to a repository path with a commit message.
  When a file already exists at that path, the page asks before replacing it
  (GitHub's content API puts the new commit on the selected branch).
- **Search** covers repositories, code inside the bound repository, and issues
  or pull requests, and links each result to GitHub.

### Session branch and safety scan

The first `push`, `upload`, or `commit_files` in a session asks the user to pick
an existing branch or type a new branch name, then stores that choice for the
session and repository. Later writes in the same session reuse it. Before
writing, the tool scans the files that would be committed for private keys,
tokens, environment files, credential files, and temporary or large files; when
it finds any, it asks the user to confirm before continuing. The session map
lives in the profile's `github-integration/session-branches.json` and holds no
secrets. The Settings page's single-file upload is a direct write and does not
run these interactions.

### Agent tool

The `github` tool accepts one `action`:

| Action | Purpose |
|---|---|
| `status` | Confirm the binding, account, and token layer. |
| `list_repos` | List or search repositories reachable by the bound account. |
| `search` | Search repositories, code, or issues. |
| `branches` | List branches with their head commit. |
| `list_files` | List one repository directory. |
| `download` | Read one repository file as UTF-8 text or base64. |
| `upload` | Upload a workspace-local file to a repository path. |
| `create_branch` | Create a branch from a base branch. |
| `commit_files` | Commit a local folder to a branch as one commit; creates the branch when missing. |
| `clone` | Clone the bound repository into the workspace with git. |
| `push` | Commit and push the whole workspace directory with git. |

The plugin also registers a profile-wide routing rule that tells the agent to use
this tool before `bash`, `git`, or `gh` for GitHub operations. `clone` and
`push` run the host's git with the bound token; `create_branch` and
`commit_files` use the GitHub API.

The tool never binds an account or accepts a token: binding is a user action in
**Settings > GitHub**, so a model cannot grant itself repository authority.

### Configuration

The bundle row accepts these optional fields:

| Field | Default | Meaning |
|---|---|---|
| `apiBase` | `https://api.github.com` | GitHub REST API base; set `https://<host>/api/v3` for GitHub Enterprise Server. |
| `tokenRef` | `GITHUB_TOKEN` | Credential reference tried after the stored token. |
| `maxFileBytes` | `8388608` | Upload and download size limit. |
| `timeoutMs` | `25000` | Per-request deadline. |

The plugin's Host-side actions load when DSH starts; after replacing the package, restart DSH before expecting new actions in a session.

### Limitations

- The upload body is bounded (12 MiB of JSON on the local route), so a single
  upload stays well below GitHub's own 100 MB content limit.
- Code search uses GitHub's legacy code search endpoint and only searches the
  bound repository when the query has no `repo:` qualifier.
- The browser route is served only where a Web carrier and the Connection trust
  fence are mounted; a headless profile still gets the agent tool.
- The token is stored locally in the profile's credential store. Turning the
  plugin off does not delete it; use **Disconnect** to remove it.

### Release

`npm run pack:release` builds `dist/local-github-integration-<version>.tgz` and
`dist/SHA256SUMS` after verifying the runtime files. The workflow at
`.github/workflows/release.yml` runs on a `v*` tag or manual dispatch, checks
that the package version matches the tag, packs the tarball, and creates or
updates the GitHub Release with both files.

Bump the version, commit the plugin branch, tag it, and push the tag:

```sh
npm version patch --no-git-tag-version
git add package.json
git commit -m "Release v1.3.1"
git tag v1.3.1
git push origin HEAD --tags
```

The repository package is named `@local/github-integration` and marked
`private`; it installs from a tarball or directory but cannot be published to
the public npm registry under that name. To publish to a registry, choose a
scope you own (for example `@your-name/dsh-github-integration`), remove
`private`, and change the name in `package.json`, `cordis.patch.yml`, and the
`window.__ModuleLoader__.load({ id })` value in `client.js`; then add an
`NPM_TOKEN` publish step. The included workflow intentionally produces an
installable tarball rather than publishing to npm.

---

## 中文

将 GitHub 账号与仓库绑定到 DeepSeek Harness，随后可在 **设置 > GitHub** 与
`github` 智能体工具中浏览、下载、上传和搜索。令牌保存在本地凭据库中，绝不写入
`cordis.patch.yml`；所有操作都使用绑定账号自身的权限。

### 在另一个 DSH 客户端安装

插件是零依赖的 npm 包。运行 `npm run pack:release` 生成 tarball，或从本仓库最新的
GitHub Release 下载 `.tgz`，然后安装到目标 profile：

```sh
dsh plugin --profile <profile> add "/绝对路径/<tarball>.tgz"
```

也可以在 Web GUI 中打开 **插件 > 添加插件**，填写同一个 tarball 路径；如果该入口只
接受目录，解压 tarball 后选择 `package/` 目录。直接复制源码目录也可以同样添加。

重启或刷新该客户端，然后在 **设置 > GitHub** 重新绑定令牌和仓库。凭据记录和会话
分支记忆保存在该客户端的 profile 中，不会与本机共享。

### 绑定

1. 创建个人访问令牌（经典令牌使用 `repo` 权限；细粒度令牌需为目标仓库授予
   `Contents: Read and write`）。
2. 打开 **设置 > GitHub**，粘贴令牌并填写 `owner` 与 `repository`；`branch`
   留空则使用仓库默认分支。
3. 点击 **绑定仓库**。页面会确认账号、仓库与分支。**断开连接** 会删除本地保存的
   令牌和绑定；个人访问令牌在 GitHub 上仍然有效，若不再使用请到
   `github.com/settings/tokens` 撤销。通过环境变量 `GITHUB_TOKEN` 或 `GH_TOKEN`
   提供的令牌不会因断开连接而被移除。

如果令牌已通过 `GITHUB_TOKEN` 或 `GH_TOKEN` 导出，也可以不粘贴：令牌留空，直接点击
**绑定仓库**。

令牌输入框会把每个字符显示为 `*`，右侧眼睛按钮可切换显示/隐藏。对于已保存的令牌，
输入框默认按长度显示 `*`；点击眼睛会向 Host 请求一次令牌并在当前页面显示，刷新页面
后重新隐藏。令牌不会进入智能体工具、会话日志或配置文件。

### 文件、上传与搜索

- **文件**：列出当前分支下的目录、切换文件夹并下载文件。文本文件在页面内预览；
  二进制文件从预览卡片保存。
- **上传**：把本地文件发送到仓库路径并附带提交说明。若目标路径已有同名文件，页面会
  先确认再替换（GitHub 内容 API 会把新提交写到所选分支）。
- **搜索**：覆盖仓库、已绑定仓库内的代码，以及议题或合并请求；每条结果都会链接到
  GitHub。

### 会话分支与安全检查

一个会话中第一次执行 `push`、`upload` 或 `commit_files` 时，工具会询问用户选择已有
分支或输入新分支名，并把该选择按“会话 + 仓库”记住；之后同一会话的写入直接复用，
不再询问。写入前，工具会扫描将要提交的文件，检查私钥、令牌、环境文件、凭据文件以及
临时/超大文件；发现可疑内容时先询问用户确认，确认后才继续。会话映射保存在 profile 的
`github-integration/session-branches.json` 中，不包含任何密钥。设置页的单文件上传是
直接写入，不经过上述会话分支与扫描流程。

### 智能体工具

`github` 工具接受一个 `action`：

| 动作 | 用途 |
|---|---|
| `status` | 确认绑定、账号和令牌来源。 |
| `list_repos` | 列出或搜索绑定账号可访问的仓库。 |
| `search` | 搜索仓库、代码或议题。 |
| `branches` | 列出分支及其最新提交。 |
| `list_files` | 列出一个仓库目录。 |
| `download` | 读取一个仓库文件（UTF-8 文本或 base64）。 |
| `upload` | 把工作区本地文件上传到仓库路径。 |
| `create_branch` | 从基础分支新建一个分支。 |
| `commit_files` | 把一个本地文件夹作为一次提交写入分支；分支不存在时自动创建。 |
| `clone` | 用 git 把绑定仓库克隆到工作区。 |
| `push` | 用 git 提交并推送整个工作区目录。 |

插件还会注册一条 profile 级路由规则，要求智能体处理 GitHub 操作时优先使用本工具，
而不是 `bash`、`git` 或 `gh`。`clone`/`push` 使用宿主机 git 和绑定的令牌；
`create_branch`/`commit_files` 使用 GitHub API。

该工具不会绑定账号，也不接受令牌：绑定是 **设置 > GitHub** 中的用户操作，因此模型
无法给自己授予仓库权限。

### 配置

插件配置行支持以下可选字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiBase` | `https://api.github.com` | GitHub REST API 基地址；GitHub Enterprise Server 设为 `https://<host>/api/v3`。 |
| `tokenRef` | `GITHUB_TOKEN` | 备用凭据引用：存储令牌不可用时尝试。 |
| `maxFileBytes` | `8388608` | 上传与下载大小上限。 |
| `timeoutMs` | `25000` | 单次请求超时。 |

插件的 Host 动作在 DSH 启动时加载；替换安装包后需重启 DSH，新的工具动作才会生效。

### 限制

- 上传请求体有上限（本地路由为 12 MiB JSON），因此单次上传仍远低于 GitHub 自身的
  100 MB 内容上限。
- 代码搜索使用 GitHub 的旧版代码搜索端点；查询中没有 `repo:` 限定符时，只搜索已
  绑定的仓库。
- 浏览器路由仅在挂载 Web 载体与 Connection 信任栅栏时提供；无头（headless）profile
  仍可使用智能体工具。
- 令牌保存在本 profile 的本地凭据库中。关闭插件不会删除它；请使用 **断开连接** 移除。

### 发布

`npm run pack:release` 会先校验运行时文件，再生成
`dist/local-github-integration-<version>.tgz` 和 `dist/SHA256SUMS`。
`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时运行：校验
`package.json` 版本与标签一致，打包 tarball，并创建或更新 GitHub Release，附带
tarball 与校验和。

发布新版本的常规流程：

```sh
npm version patch --no-git-tag-version
git add package.json
git commit -m "Release v1.3.1"
git tag v1.3.1
git push origin HEAD --tags
```

仓库里的包名是 `@local/github-integration` 且标记为 `private`，可以从 tarball 或
目录安装，但不能用这个名字发布到公共 npm registry。若要发布到 registry，请选择一个
你拥有的 scope（例如 `@your-name/dsh-github-integration`），移除 `private`，并同步
修改 `package.json`、`cordis.patch.yml` 以及 `client.js` 中
`window.__ModuleLoader__.load({ id })` 的包名；然后添加 `NPM_TOKEN` 发布步骤。
当前工作流有意只产出可安装的 tarball，不直接发布 npm。

