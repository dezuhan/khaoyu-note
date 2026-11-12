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
- `service`: self-hosted service foundation.
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

## Before committing

Run the checks that match the change:

```powershell
node --experimental-vm-modules scripts/check-web.cjs
node tools/test-ui.mjs http://127.0.0.1:1430/
npm run theme:check
npm run test:theme-css
node tools/test-card-features.mjs http://127.0.0.1:1430/
node tools/test-web-mode.mjs
node --test --test-concurrency=1 service/test/service.test.mjs service/test/auth.test.mjs
```

Backend changes also run:

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

Bump all version fields together: root `package.json`, `package-lock.json`, `service/package.json`,
`service/package-lock.json`, `app/package.json`, `app/package-lock.json`, `app/src-tauri/tauri.conf.json`,
`app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`, the Compose image tag, the changelog and the README
artifact table. Run `node tools/test-version.mjs`; CI runs it too.
Add the changelog entry in the same change, then tag the verified release:

```powershell
git tag -a v0.2.0 -m "Khaoyu Note 0.2.0"
```

## Release checklist

1. All matching test suites pass.
2. Installer is rebuilt when the release includes desktop changes.
3. `CHANGELOG.md` describes user-visible changes.
4. Every version field agrees with the full list above; `node tools/test-version.mjs` checks them.
5. Working tree is clean before tagging.
6. Tag points at the release commit.

## License

By contributing, you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). The Khaoyu Note name and logo remain subject to
[TRADEMARK.md](TRADEMARK.md).
