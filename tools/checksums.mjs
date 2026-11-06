// Generate SHA256SUMS.txt for a directory tree.
// node tools/checksums.mjs --dir dist
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = path.resolve(argument("--dir", "dist"));
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Directory not found: ${root}`);
  process.exit(2);
}

function files(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(full));
    else if (entry.isFile() && entry.name !== "SHA256SUMS.txt") output.push(full);
  }
  return output;
}

const lines = files(root)
  .sort()
  .map((file) => {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return `${hash}  ${path.relative(root, file).replace(/\\/g, "/")}`;
  });
const target = path.join(root, "SHA256SUMS.txt");
fs.writeFileSync(target, `${lines.join("\n")}\n`);
console.log(`${lines.length} files -> ${target}`);
