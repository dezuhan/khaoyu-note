# Contributing and releases

## Commit format

Use Conventional Commits:

```text
type(scope): short imperative summary
```

Keep one logical change per commit. A commit should be reviewable without opening unrelated files.

Types:

- `feat`: user-visible capability.
- `fix`: bug fix.
- `perf`: performance change without new behavior.
- `refactor`: internal change without behavior change.
- `test`: tests only.
- `docs`: documentation only.
- `build`: packaging, dependencies or build configuration.
- `chore`: repository maintenance.
- `ci`: workflow changes.

Scopes:

- `web`: `app/web` frontend.
- `db`: SQLite, persistence and migrations.
- `mcp`: MCP server and tool schemas.
- `ui`: visual design, layout and interaction styling.
- `packaging`: installers and platform distribution.
- `docs`: README, docs and roadmap.
- `tests`: browser, database and MCP suites.
- `repo`: Git, ignore rules and repository tooling.

Examples:

```text
feat(web): add direct tool drop into a column
fix(sheet): allow scrollbar drags inside a column
docs(roadmap): add AI chatbot milestone
test(mcp): cover stale write rejection
```

## Language

Every artifact committed to this repository is written in **English**: documentation, `CHANGELOG.md`
entries, commit messages, pull-request descriptions, release notes, code comments, test names and the
user-facing source strings. Code identifiers stay English too.

The only non-English text in the repository belongs to the app's multi-language feature: the locale
data in `app/web/js/i18n.js` and anything that feature owns (locale-specific documentation templates,
translated menus). Never hand-write a translated string for another purpose, and never leave a locale
value in English unless it is one of the shipped languages.

Conversation with the maintainer may happen in any language, including Indonesian. The rule applies to
what lands in the repository, not to the chat around it.

## Before committing

Run the checks that match the change:

```powershell
node --experimental-vm-modules scripts/check-web.cjs
node tools/test-ui.mjs http://127.0.0.1:1430/
npm run theme:check
npm run test:theme-css
node tools/test-card-features.mjs http://127.0.0.1:1430/
node tools/test-web-mode.mjs
```

Desktop changes also run:

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Do not commit `dist/`, `target/`, `node_modules/` or editor backup files. They are ignored because
they are generated locally.

Update the documentation in the same change: README feature tables, `docs/` pages and the
`ROADMAP.md` checkbox that the change verifies. A stale claim is a defect, not a separate cleanup.

## Toolbar tools

Every new tool added to the toolbar must also be added to **Settings > Tools**:

- add the key to `DEFAULT_TOOL_ORDER` in `app/web/js/settings.js`,
- add the label to `TOOL_LABELS`,
- provide an icon under the same key,
- verify the visibility toggle hides and restores the toolbar button.

The UI suite checks that every toolbar key is represented in Settings > Tools. A tool that exists only
in the toolbar or only in Settings is a failing change.

## Versioning

The project uses Semantic Versioning. Update the version for every user-visible feature or bug fix,
not only when a milestone or release is finished.

- `fix`, `perf` or security fix: patch, for example `0.2.1`.
- New capability: minor, for example `0.3.0`.
- Breaking data or workflow change: major, for example `1.0.0`.
- Documentation, tests and CI-only changes do not need a version bump.

Create a branch named after the new version before bumping it (`git switch -c 0.36.2 stable`);
never commit a version change directly on `stable`. Bump all version fields together: root
`package.json`, `package-lock.json`, `app/package.json`, `app/package-lock.json`,
`app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`, the changelog
and the README artifact table. Run `node tools/test-version.mjs`; CI runs it too.
`khaoyu-note-mcp` is built from the same Cargo package as the desktop app, so it must report the new
version even when the MCP code itself did not change. The release workflow rebuilds and attaches it on
every release; `node tools/test-mcp.mjs <binary>` fails if the server reports a different version.
Add the changelog entry in the same change, then tag the verified release:

```powershell
git tag -a v0.2.0 -m "Khaoyu Note 0.2.0"
```

## Release notes

Draft release notes are compact. Use the version's `CHANGELOG.md` section as the source, save the body
as `.release-notes-X.Y.Z.md`, and pass it with `--notes-file`. Keep it to:

- one short paragraph saying what the release is (for example "a **stabilisation release** on the 0.36
  line" plus the backend status), then
- a `## Highlights` list of **three to six bullets**, one user-visible outcome each, with a number only
  where it proves the point, then
- the usual `## Downloads` and `## Notes` blocks and a `## Changelog` pointer.

Do not paste the commit list, the pull-request "What's Changed" block or every removed quirk. A reader
should understand the release in under a minute, and the notes should still be accurate after the
installers are attached.

## Release checklist

1. All matching test suites pass.
2. Installer is rebuilt when the release includes desktop changes.
3. `CHANGELOG.md` describes user-visible changes, in the compact shape above.
4. Every version field agrees with the full list above; `node tools/test-version.mjs` checks them.
5. MCP binary rebuilt and reports the release version (`node tools/test-mcp.mjs <binary>`).
6. The maintainer explicitly confirmed pushing the version branch and merging its pull request.
7. The maintainer explicitly confirmed creating the **draft** GitHub release targeting `stable`, with
   compact notes (summary paragraph plus three to six highlight bullets).
8. The maintainer explicitly confirmed uploading/publishing; the draft is only then published.
9. Working tree is clean before tagging.
10. Tag points at the release commit.

## License

By contributing, you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). The Khaoyu Note name and logo remain subject to
[TRADEMARK.md](TRADEMARK.md).
