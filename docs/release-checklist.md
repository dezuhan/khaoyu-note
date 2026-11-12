# Release checklist

Run before tagging a release.

## Verification

- [ ] `npm run test:service` passes.
- [ ] `npm run test:sync` passes.
- [ ] UI suite passes against the static preview: `node tools/test-ui.mjs http://127.0.0.1:1430/`.
- [ ] Migration from the previous release is applied against a copy of the previous data.
- [ ] Backup, restore and `/readyz` are checked on the upgrade copy.
- [ ] Restore drill repeats on a clean directory and confirms project, asset and audit rows.
- [ ] Version is bumped in root, app, Tauri, Cargo, service, Compose and documentation.
- [ ] CHANGELOG entry exists.
- [ ] `git diff --check` and `git status` are clean.
- [x] Installers are rebuilt after the final web changes and `dist/` contains only the current version.

## Security

- [ ] `KHAOYU_SERVICE_SECRET` and admin token are rotated for the release environment.
- [ ] Session invalidation is run when authentication or session behavior changed.
- [ ] CORS origins contain only expected desktop origins.
- [ ] Public sharing is off unless explicitly enabled by the owner.
- [ ] Dependency audit and container scan pass.
- [ ] Threat model, audit and incident runbook are reviewed.
- [ ] Security advisory policy and contact path are current.

## External gates

- [ ] Windows code signing certificate and installer signature.
- [ ] macOS notarization and iOS signing on a macOS runner.
- [ ] Android signing and store listing.
- [ ] External penetration test completed before production advertising.
