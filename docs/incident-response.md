# Incident response runbook

Use this for suspected secret exposure, account compromise, share link abuse, data loss or a
vulnerability report.

## 1. Triage

1. Record the time, reporter, affected component and current impact.
2. Preserve logs and audit rows before changing the service.
3. Do not delete a compromised share link or session until the initial evidence is captured.
4. If data is actively exposed, continue with containment immediately.

## 2. Containment

- Rotate `KHAOYU_SERVICE_SECRET` and restart the service, then run
  `node src/cli.mjs invalidate-sessions`.
- Rotate `KHAOYU_SERVICE_ADMIN_TOKEN` and restart the service.
- Rotate SMTP credentials and any API tokens used by sync clients.
- Disable public sharing with `KHAOYU_SERVICE_PUBLIC_SHARING=false` if links are being abused.
- Revoke the affected share links through the project share API.
- Revoke affected API tokens through `/api/v1/account/tokens/:id` or the account session.
- Remove a compromised member from the project and transfer ownership if the owner is compromised.

## 3. Eradication and recovery

1. Deploy the fixed release and run migrations.
2. Restore from a verified backup only after confirming the backup predates the compromise.
3. Verify `/readyz`, login, project access and one shared link.
4. Re-enable public sharing only after the abuse path is closed.
5. Reissue tokens to legitimate users through a controlled channel.

## 4. Communication

- Notify affected operators and users with the minimum necessary facts.
- Publish a security advisory after the fix.
- Do not speculate about cause or impact before evidence is reviewed.
- Record the timeline and decisions in the incident notes.

## 5. Post-incident

1. Add a regression test for the failure.
2. Update the threat model and audit.
3. Review the release checklist and secret rotation steps.
4. Schedule an external review if the impact warrants it.

## Secret rotation checklist

- `KHAOYU_SERVICE_SECRET`: invalidates sessions and IP hashes; old audit IP hashes remain historical.
- `KHAOYU_SERVICE_ADMIN_TOKEN`: admin API only.
- SMTP password: mail delivery only.
- Sync API tokens: per user, revoke and reissue.
- TLS private key: reverse proxy, not stored in this repository.
