// Synchronize shared/theme into the app and service copies. Use --check in CI to detect drift.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = path.join(root, "shared", "theme");
const check = process.argv.includes("--check");

const files = [
  ["ky.css", ["app/web/vendor/ky.css", "service/public/ky.css"]],
  ["ky.js", ["app/web/vendor/ky.js"]],
  ["fonts.css", ["app/web/css/fonts.css", "service/public/fonts.css"]],
  ["icons.js", ["app/web/js/icons.js", "service/public/icons.js"]],
  ["theme.js", ["app/web/js/theme.js", "service/public/theme.js"]],
  ["theme-init.js", ["service/public/theme-init.js"]],
  ["khaoyu-note.svg", ["app/web/assets/khaoyu-note.svg", "service/public/khaoyu-note.svg"]],
  ["favicon-32.png", ["app/web/assets/favicon-32.png", "service/public/favicon-32.png"]],
  ["favicon-180.png", ["app/web/assets/favicon-180.png", "service/public/favicon-180.png"]],
  [
    "fonts/DMSans-400.woff2",
    ["app/web/fonts/DMSans-400.woff2", "service/public/fonts/DMSans-400.woff2"],
  ],
  [
    "fonts/PlayfairDisplay-400.woff2",
    ["app/web/fonts/PlayfairDisplay-400.woff2", "service/public/fonts/PlayfairDisplay-400.woff2"],
  ],
  [
    "fonts/PlusJakartaSans-400.woff2",
    ["app/web/fonts/PlusJakartaSans-400.woff2", "service/public/fonts/PlusJakartaSans-400.woff2"],
  ],
  [
    "fonts/SpaceMono-400.woff2",
    ["app/web/fonts/SpaceMono-400.woff2", "service/public/fonts/SpaceMono-400.woff2"],
  ],
  [
    "fonts/SpaceMono-700.woff2",
    ["app/web/fonts/SpaceMono-700.woff2", "service/public/fonts/SpaceMono-700.woff2"],
  ],
];

let drift = 0;
for (const [sourceName, targets] of files) {
  const source = path.join(shared, sourceName);
  if (!fs.existsSync(source)) {
    console.error(`missing shared source: ${sourceName}`);
    process.exit(1);
  }
  const sourceBytes = fs.readFileSync(source);
  for (const targetName of targets) {
    const target = path.join(root, targetName);
    if (check) {
      if (!fs.existsSync(target) || !sourceBytes.equals(fs.readFileSync(target))) {
        console.error(`theme drift: ${targetName}`);
        drift += 1;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sourceBytes);
    console.log(`synced ${targetName}`);
  }
}

if (check) {
  if (drift) {
    console.error(`theme drift detected in ${drift} file(s); run npm run theme:sync`);
    process.exit(1);
  }
  console.log(`theme copies match shared/theme (${files.length} sources)`);
}
