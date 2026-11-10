// Check translation coverage for every shipped language. This is intentionally a source-level
// audit: it verifies the keys wired through i18n.js, not arbitrary paragraph translations.
import { LANGUAGES, hasTranslation, translationKeys } from "../app/web/js/i18n.js";

const keys = translationKeys();
let failed = false;
console.log(`keys: ${keys.length}`);
console.log(`languages: ${LANGUAGES.map((language) => language.id).join(", ")}`);
for (const language of LANGUAGES) {
  const missing = keys.filter((key) => !hasTranslation(language.id, key));
  const covered = keys.length - missing.length;
  const percent = ((covered / keys.length) * 100).toFixed(1);
  console.log(`${language.id.padEnd(6)} ${String(covered).padStart(3)}/${keys.length} ${percent}%`);
  if (missing.length) {
    failed = true;
    console.log(`  missing: ${missing.join(", ")}`);
  }
}
if (failed) process.exitCode = 1;
