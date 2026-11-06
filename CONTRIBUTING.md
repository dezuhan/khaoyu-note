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

## Before committing

Run the checks that match the change:

```powershell
node --experimental-vm-modules scripts/check-web.cjs
node tools/test-ui.mjs http://127.0.0.1:1430/
node tools/test-card-features.mjs http://127.0.0.1:1430/
node tools/test-web-mode.mjs
```

Backend changes also run:

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Do not commit `dist/`, `target/`, `node_modules/` or editor backup files. They are ignored because
they are generated locally.

## Versioning

The project uses Semantic Versioning:

- `fix` or internal-only change: patch, for example `0.1.1`.
- New capability: minor, for example `0.2.0`.
- Breaking data or workflow change: major, for example `1.0.0`.

Every release gets a changelog entry and an annotated tag:

```powershell
git tag -a v0.1.0 -m "Khaoyu Note 0.1.0"
```

## Release checklist

1. All matching test suites pass.
2. Installer is rebuilt when the release includes desktop changes.
3. `CHANGELOG.md` describes user-visible changes.
4. Version in `package.json`, `app/package.json` and `app/src-tauri/tauri.conf.json` agrees.
5. Working tree is clean before tagging.
6. Tag points at the release commit.
