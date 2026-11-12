// Guard the shared geometry contract: service stylesheets must not reintroduce literal spacing,
// type sizes or radii that bypass the ky.css token scale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["service/public/admin.css", "service/public/auth.css", "service/public/ui.css"];
const properties = /^\s*(padding|margin|gap|row-gap|column-gap|font-size|border-radius)(-[a-z]+)?:\s*([^;]+);/gm;
const literal = /\b\d*\.?\d+px\b/;
let failed = 0;

for (const name of files) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  for (const match of text.matchAll(properties)) {
    if (literal.test(match[3])) {
      console.log(`FAIL  ${name}: ${match[1]}${match[2] || ""}: ${match[3].trim()}`);
      failed += 1;
    }
  }
}

const admin = fs.readFileSync(path.join(root, "service/public/admin.js"), "utf8");
for (const [legacy, shared] of [
  ['class="admin-section"', 'class="ky-section admin-section"'],
  ['class="admin-card"', 'class="ky-card admin-card"'],
  ['class="admin-table"', 'class="ky-table admin-table"'],
]) {
  if (admin.includes(legacy) && !admin.includes(shared)) {
    console.log(`FAIL  service/public/admin.js: ${legacy} does not include the shared component class`);
    failed += 1;
  }
}

for (const name of ["app/web/index.html", ...fs.readdirSync(path.join(root, "service/public")).filter((file) => file.endsWith(".html")).map((file) => `service/public/${file}`)]) {
  if (!fs.readFileSync(path.join(root, name), "utf8").includes(name.startsWith("app/") ? "./vendor/components.css" : "/components.css")) {
    console.log(`FAIL  ${name}: shared components.css is not linked`);
    failed += 1;
  }
}

if (failed) {
  console.error(`theme css check failed (${failed})`);
  process.exit(1);
}
console.log("PASS  service spacing/type/radii use ky tokens and shared component classes");
