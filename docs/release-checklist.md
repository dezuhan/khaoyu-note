# Release checklist

Run before tagging a release.

## Verification

- [ ] UI suite passes against the static preview: `node tools/test-ui.mjs http://127.0.0.1:1430/`.
- [ ] Migration from the previous release is applied against a copy of the previous data.
- [ ] Backup and restore are checked on the upgrade copy.
- [ ] Version is bumped in root, app, Tauri, Cargo and the documentation.
- [ ] CHANGELOG entry exists.
- [ ] `git diff --check` and `git status` are clean.
- [x] Installers are rebuilt after the final web changes and `dist/` contains only the current version.

## Security

- [ ] Dependency audit passes.
- [ ] Security advisory policy and contact path are current.

## Publish gate

- [ ] Version branch is merged into `stable` and the merge commit is the release commit.
- [ ] Maintainer answered the confirmation question before pushing the version branch and merging it.
- [ ] Maintainer answered the confirmation question before creating the **draft** GitHub release
      targeting `stable`.
- [ ] Maintainer answered the confirmation question to upload/publish.
- [ ] Draft is published (or the tag is pushed) only after that confirmation.

## External gates

- [ ] Windows code signing certificate and installer signature.
- [ ] macOS notarization and iOS signing on a macOS runner.
- [ ] Android signing and store listing.
