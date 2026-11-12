// Operation protocol helpers for project boards. Operations are validated before the transaction and
// applied to the JSON document inside the same transaction that allocates their sequence numbers.
export const MAX_OPS_PER_BATCH = 200;
export const MAX_OP_BYTES = 256 * 1024;
// A whole-document replacement or the connection list can legitimately be larger than one card
// patch; the request body already caps the batch at 8 MB.
export const MAX_BULK_OP_BYTES = 4 * 1024 * 1024;
const BULK_OP_TYPES = new Set(["doc.replace", "connections.set"]);
export const OP_TYPES = new Set([
  "doc.replace",
  "doc.title",
  "card.add",
  "card.update",
  "card.delete",
  "card.move",
  "connections.set",
]);

export class OpError extends Error {
  constructor(message, code = "op_invalid") {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpError(`${name} must be an object`);
  }
}

function safePatch(patch) {
  assertObject(patch, "patch");
  const copy = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id" || key === "type" || key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

function findCard(doc, id) {
  const card = (doc.cards || []).find((entry) => entry.id === id);
  if (!card) throw new OpError(`card ${id} not found`, "op_invalid");
  return card;
}

export function applyOperation(doc, operation) {
  if (!operation || typeof operation !== "object") throw new OpError("operation must be an object");
  const type = String(operation.type || "");
  if (!OP_TYPES.has(type)) throw new OpError(`unsupported operation type ${type}`, "op_invalid");
  const payload = operation.payload;
  assertObject(payload, "payload");
  if (!Array.isArray(doc.cards)) doc.cards = [];
  if (!Array.isArray(doc.connections)) doc.connections = [];
  if (!Array.isArray(doc.trash)) doc.trash = [];

  switch (type) {
    case "doc.replace": {
      const next = payload.doc;
      assertObject(next, "payload.doc");
      if (!Array.isArray(next.cards)) throw new OpError("payload.doc.cards must be an array");
      doc.id = next.id ?? doc.id;
      doc.title = next.title ?? doc.title;
      doc.cards = next.cards;
      doc.connections = Array.isArray(next.connections) ? next.connections : [];
      doc.trash = Array.isArray(next.trash) ? next.trash : [];
      break;
    }
    case "connections.set": {
      if (!Array.isArray(payload.connections)) throw new OpError("payload.connections must be an array");
      if (payload.connections.length > 5000) throw new OpError("too many connections", "op_too_large");
      doc.connections = payload.connections.map((connection) => {
        if (!connection || typeof connection !== "object") throw new OpError("connection must be an object");
        return connection;
      });
      break;
    }
    case "doc.title": {
      if (typeof payload.title !== "string") throw new OpError("payload.title must be a string");
      doc.title = payload.title.slice(0, 200);
      break;
    }
    case "card.add": {
      const card = payload.card;
      assertObject(card, "payload.card");
      if (!card.id || !card.type) throw new OpError("card must have id and type");
      if ((doc.cards || []).some((entry) => entry.id === card.id)) {
        throw new OpError(`card ${card.id} already exists`, "op_invalid");
      }
      doc.cards.push(card);
      break;
    }
    case "card.update": {
      const id = String(payload.id || "");
      const card = findCard(doc, id);
      Object.assign(card, safePatch(payload.patch));
      break;
    }
    case "card.delete": {
      const id = String(payload.id || "");
      findCard(doc, id);
      const removed = new Set([id]);
      const queue = [id];
      while (queue.length) {
        const current = queue.shift();
        for (const card of doc.cards) {
          if (card.parentId === current && !removed.has(card.id)) {
            removed.add(card.id);
            queue.push(card.id);
          }
        }
      }
      doc.cards = doc.cards.filter((card) => !removed.has(card.id));
      doc.connections = (doc.connections || []).filter(
        (connection) => !removed.has(connection.from) && !removed.has(connection.to)
      );
      break;
    }
    case "card.move": {
      const id = String(payload.id || "");
      const card = findCard(doc, id);
      for (const key of ["x", "y", "order"]) {
        if (payload[key] !== undefined) {
          if (!Number.isFinite(Number(payload[key]))) throw new OpError(`${key} must be a number`);
          card[key] = Number(payload[key]);
        }
      }
      if (payload.parentId !== undefined) {
        card.parentId = payload.parentId === null ? null : String(payload.parentId);
      }
      break;
    }
    default:
      throw new OpError("unsupported operation");
  }
  return doc;
}

export function validateOperations(ops) {
  if (!Array.isArray(ops) || ops.length < 1) throw new OpError("ops must be a non-empty array");
  if (ops.length > MAX_OPS_PER_BATCH) throw new OpError(`at most ${MAX_OPS_PER_BATCH} operations per batch`, "op_too_large");
  const seen = new Set();
  for (const op of ops) {
    assertObject(op, "operation");
    const opId = String(op.opId || "").trim();
    if (!opId || opId.length > 120) throw new OpError("opId must be 1 to 120 characters");
    if (seen.has(opId)) throw new OpError(`duplicate opId ${opId}`, "op_invalid");
    seen.add(opId);
    const type = String(op.type || "");
    if (!OP_TYPES.has(type)) throw new OpError(`unsupported operation type ${type}`, "op_invalid");
    assertObject(op.payload, "payload");
    const limit = BULK_OP_TYPES.has(type) ? MAX_BULK_OP_BYTES : MAX_OP_BYTES;
    if (Buffer.byteLength(JSON.stringify(op.payload), "utf8") > limit) {
      throw new OpError("operation payload is too large", "op_too_large");
    }
  }
  return ops;
}
