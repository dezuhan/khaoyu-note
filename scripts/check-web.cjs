// Static sanity check for the web frontend: syntax + resolved imports/exports.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "app", "web");
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
}
walk(path.join(root, "js"));

let failures = 0;
const exportsByFile = new Map();

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  exportsByFile.set(file, exportedNames(source));
  try {
    new vm.SourceTextModule(source, { identifier: file });
  } catch (error) {
    failures += 1;
    console.log("SYNTAX FAIL", path.relative(root, file), "::", error.message);
  }
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const [, defaultName, named, spec] = match;
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      failures += 1;
      console.log("MISSING FILE", path.relative(root, file), "->", spec);
      continue;
    }
    const targetExports = exportsByFile.get(target) || new Set();
    if (defaultName && !targetExports.has("default")) {
      failures += 1;
      console.log("MISSING DEFAULT", path.relative(root, file), "->", spec);
    }
    if (named) {
      for (const part of named.split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!targetExports.has(name)) {
          failures += 1;
          console.log("MISSING EXPORT", path.relative(root, file), "->", spec, "::", name);
        }
      }
    }
  }
}

console.log(failures ? `FAILURES: ${failures}` : "OK: " + files.length + " modules clean");
process.exit(failures ? 1 : 0);
