// Guard the shared geometry contract for the app shell: index.html must link the shared component
// stylesheet, so the tokens in shared/theme/components.css are what the board chrome is built from.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(root, "app/web/index.html"), "utf8");

if (!index.includes("./vendor/components.css")) {
  console.error("FAIL  app/web/index.html does not link ./vendor/components.css");
  process.exit(1);
}
console.log("PASS  app shell links the shared components.css");
