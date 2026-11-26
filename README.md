# GitHub integration

Binds a GitHub account and repository to DeepSeek Harness, then browses,
downloads, uploads, and searches from **Settings > GitHub** and from the
`github` agent tool. The token is kept in the local credential store, never in
`cordis.patch.yml`, and every operation uses the bound account's permissions.

## Bind

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

## Files, upload, and search

- **Files** lists a directory at the current branch, navigates folders, and
  downloads a file. Text files preview in the page; binary files are saved from
  the preview card.
- **Upload** sends one local file to a repository path with a commit message.
  When a file already exists at that path, the page asks before replacing it
  (GitHub's content API puts the new commit on the selected branch).
- **Search** covers repositories, code inside the bound repository, and issues
  or pull requests, and links each result to GitHub.

## Agent tool

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

The tool never binds an account or accepts a token: binding is a user action in
**Settings > GitHub**, so a model cannot grant itself repository authority.

## Configuration

The bundle row accepts these optional fields:

| Field | Default | Meaning |
|---|---|---|
| `apiBase` | `https://api.github.com` | GitHub REST API base; set `https://<host>/api/v3` for GitHub Enterprise Server. |
| `tokenRef` | `GITHUB_TOKEN` | Credential reference tried after the stored token. |
| `maxFileBytes` | `8388608` | Upload and download size limit. |
| `timeoutMs` | `25000` | Per-request deadline. |

## Limitations

- The upload body is bounded (12 MiB of JSON on the local route), so a single
  upload stays well below GitHub's own 100 MB content limit.
- Code search uses GitHub's legacy code search endpoint and only searches the
  bound repository when the query has no `repo:` qualifier.
- The browser route is served only where a Web carrier and the Connection trust
  fence are mounted; a headless profile still gets the agent tool.
- The token is stored locally in the profile's credential store. Turning the
  plugin off does not delete it; use **Disconnect** to remove it.
