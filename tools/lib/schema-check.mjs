// Minimal JSON Schema (2020-12 subset) validator for the Phase 0 contract tests. It intentionally
// supports only the keywords the contracts use, so the repository does not need a full validator
// dependency. Unsupported keywords are ignored.
export function validateSchema(value, schema, root = schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validateSchema(value, target, root, path);
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${valueType(value)}`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path}: expected >= ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items, root, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!(required in value)) errors.push(`${path}: missing required ${required}`);
    }
    for (const [key, subschema] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateSchema(value[key], subschema, root, `${path}.${key}`));
    }
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) return null;
  return ref.slice(2).split("/").reduce((node, key) => (node ? node[key] : null), root);
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return Number.isInteger(value) ? "integer" : typeof value;
}
