# Agent instructions

This file is for automated coding agents working on this repository. Follow it together with
[CONTRIBUTING.md](CONTRIBUTING.md); the release rules below are mandatory.

## Version updates

- Every version update gets its **own branch**, named exactly after the new version (`0.36.2`,
  `0.37.0`). Branch from the current `stable` (or the release branch that owns that version).
  Never commit a version bump directly on `stable` or on a previous release branch.
- Bump every version field listed in [CONTRIBUTING.md](CONTRIBUTING.md#versioning) in one commit,
  together with the new `CHANGELOG.md` section and the README/landing artifact names.
- Run `node tools/test-version.mjs` after the bump; CI runs it too.
- Merge the version branch through a pull request into `stable`, then tag the merged commit as
  `vX.Y.Z`. The tag is what triggers `.github/workflows/desktop-release.yml`.

## MCP follows the app version

- `khaoyu-note-mcp` is built from the same Cargo package as the desktop app. It must always report
  the same version as the app, **even when MCP code did not change**.
- Never pin or bump an MCP version separately. Bumping `app/src-tauri/Cargo.toml` (and the other
  version fields) is what moves the MCP server version.
- Every release rebuilds and attaches the MCP binary (`khaoyu-note-mcp.exe` on Windows, the Linux
  binary and the macOS binary) at the new version. Do not ship an MCP binary older than the app.
- `node tools/test-mcp.mjs <binary>` fails when `initialize` reports a version different from the
  root `package.json`; run it against the built binary before tagging. `tools/test-version.mjs`
  covers the static version fields.

## Release flow (short)

1. `git switch -c X.Y.Z stable`
2. Bump the versions, changelog and README/landing versions; commit `chore(release): X.Y.Z`.
3. Run `node tools/test-version.mjs`, the MCP suite and the test suites that match the change.
4. Push the branch, open a pull request into `stable`, and merge it.
5. Tag the merge commit (`vX.Y.Z`) and push the tag. The release workflow builds the installers,
   `khaoyu-note-mcp` and `SHA256SUMS.txt`, then publishes them on the GitHub release.
6. Verify the release page: all expected artifacts are attached and the MCP `initialize` response
   reports the same version as the app.

## Other rules

- Follow the commit format and test matrix in [CONTRIBUTING.md](CONTRIBUTING.md); update the docs
  and the matching `ROADMAP.md` checkbox in the same change.
- Do not commit generated artifacts (`dist/`, `target/`, `node_modules/`, `.cargo-home/`).
- Keep a branch focused on exactly the requested work; unrelated changes go to their own branch.
