const SECRET_KEYS = /(secret|token|password|key|authorization)/i;

function redact(value, depth = 0) {
  if (depth > 4) return "[depth limit]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(stream = process.stdout) {
  function write(level, event, fields = {}) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...redact(fields),
    });
    stream.write(`${line}\n`);
  }

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
