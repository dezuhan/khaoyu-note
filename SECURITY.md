# Security policy

## Supported versions

Security fixes are provided for the latest released minor version. Older desktop installers are not
patched in place; update to the newest release.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately through the repository's GitHub
Security Advisory form, including:

- affected version and component,
- reproduction steps or proof of concept,
- impact and any suggested fix,
- whether the report may be credited.

Do not include live secrets, other users' data or destructive payloads. Never test against a service
you do not own.

## Response

The maintainers aim to acknowledge a report within 7 days, assess severity, prepare a fix and publish
a coordinated disclosure after patches are available. There is no bug bounty program.

## Scope

In scope: authentication, session handling, share links, authorization, uploads, audit logging, the
service API and desktop sync.

Out of scope: denial of service against third-party infrastructure, social engineering, physical
access, and issues that require a compromised host or database file.

## Disclosure

The security advisory is published after a fix. Credit is given only with permission. This policy is
reviewed with every release checklist.
