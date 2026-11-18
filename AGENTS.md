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

## Remote-write gate (mandatory)

Remote changes are only made after an explicit confirmation from the maintainer in the current
conversation.

- Before `git push` of any branch or tag, ask with the interactive question box
  (`ask_user_question`) whether to push. "The work is finished" or an earlier approval of a different
  step is not permission to push.
- Before creating or updating a GitHub release, **including a draft release**, ask the same way.
- Before merging a pull request into `stable`, ask the same way as well.
- An explicit instruction in the maintainer's current message for that exact operation ("push this
  branch", "create the draft release") counts as the confirmation for that operation only. Anything
  else needs the question box.
- When the answer is no or is skipped, keep the work local, report what is ready, and wait.

## Publishing gate (mandatory)

Never publish a GitHub release or push a release tag for a fixed version without an explicit
confirmation from the maintainer in the current conversation.

- Ask whether to create the draft release first. Only after an explicit yes, **create a draft
  release** targeting `stable`. Do not publish it and do not push the tag yet:

  ```bash
  gh release create vX.Y.Z --draft --target stable \
    --title "Khaoyu Note X.Y.Z" --notes-file .release-notes-X.Y.Z.md
  ```

- Then **ask the maintainer with a confirmation question box** (the interactive
  `ask_user_question` tool, not plain prose) whether to upload/publish. The question must offer at
  least a publish/upload choice and a keep-draft/do-not-upload choice. Never treat earlier
  conversational agreement as approval for publishing.
- Wait for the answer. If the maintainer declines or skips the question, leave the draft unpublished,
  report the draft URL, and do not create or push the tag.
- Only after an explicit "publish/upload" answer: publish the draft
  (`gh release edit vX.Y.Z --draft=false`). Publishing creates the tag and triggers the desktop
  release workflow. Pushing the tag manually is only allowed after the same confirmation.

## Release flow (short)

1. `git switch -c X.Y.Z stable`
2. Bump the versions, changelog and README/landing versions; commit `chore(release): X.Y.Z`.
3. Run `node tools/test-version.mjs`, the MCP suite and the test suites that match the change.
4. Ask before pushing; on yes push the branch, open a pull request into `stable`, and ask again
   before merging it.
5. Ask whether to create the draft GitHub release targeting `stable`; on yes create it (still
   unpublished, no tag).
6. Ask again before publishing the draft/tag; only on an explicit yes publish it. The release
   workflow builds the installers, `khaoyu-note-mcp` and `SHA256SUMS.txt`, then attaches them to the
   release.
7. Verify the release page: all expected artifacts are attached and the MCP `initialize` response
   reports the same version as the app.

## Other rules

- Follow the commit format and test matrix in [CONTRIBUTING.md](CONTRIBUTING.md); update the docs
  and the matching `ROADMAP.md` checkbox in the same change.
- Do not commit generated artifacts (`dist/`, `target/`, `node_modules/`, `.cargo-home/`).
- Keep a branch focused on exactly the requested work; unrelated changes go to their own branch.
