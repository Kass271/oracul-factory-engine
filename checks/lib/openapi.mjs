// Small, dependency-free readers for api/openapi.yaml (the subset the factory's contracts use: components.schemas with
// block-style properties and required lists).

// Properties that are both required and nullable ("Schema.prop"). With Jackson's NON_NULL convention a null value is
// left out of the JSON — a required property would then be missing. nullable: true (3.0) and type: [x, 'null'] (3.1).
export function requiredNullable(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inComponents = false, inSchemas = false, schema = null, schemaIndent = 0;
  let required = new Set(), nullable = new Set(), mode = null, propIndent = 0, prop = null;
  const flush = () => { if (schema) for (const p of nullable) if (required.has(p)) out.push(`${schema}.${p}`); };
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (indent === 0) { flush(); schema = null; inComponents = line === 'components:'; inSchemas = false; continue; }
    if (!inComponents) continue;
    if (indent === 2) { flush(); schema = null; inSchemas = line === 'schemas:'; continue; }
    if (!inSchemas) continue;
    if (indent === 4 && /^[\w.-]+:\s*$/.test(line)) { flush(); schema = line.slice(0, -1); schemaIndent = 4; required = new Set(); nullable = new Set(); mode = null; prop = null; continue; }
    if (!schema) continue;
    if (indent === schemaIndent + 2) {
      prop = null;
      const req = line.match(/^required:\s*(\[.*\])?\s*$/);
      if (req) { mode = 'required'; if (req[1]) req[1].slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach((x) => required.add(x)); continue; }
      mode = line === 'properties:' ? 'properties' : null;
      propIndent = schemaIndent + 4;
      continue;
    }
    if (mode === 'required' && /^-\s*/.test(line)) { required.add(line.replace(/^-\s*/, '').replace(/^["']|["']$/g, '')); continue; }
    if (mode === 'properties') {
      if (indent === propIndent && /^[\w.-]+:/.test(line)) { prop = line.split(':')[0]; continue; }
      if (prop && indent > propIndent && (/^nullable:\s*true\b/.test(line) || /^type:\s*\[.*['"]?null['"]?.*\]/.test(line))) nullable.add(prop);
    }
  }
  flush();
  return out;
}

// Required properties per schema: Map "Schema" → Set(prop). Same subset as requiredNullable.
export function requiredBySchema(text) {
  const out = new Map();
  let inComponents = false, inSchemas = false, schema = null, mode = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (indent === 0) { inComponents = line === 'components:'; inSchemas = false; schema = null; continue; }
    if (!inComponents) continue;
    if (indent === 2) { inSchemas = line === 'schemas:'; schema = null; continue; }
    if (!inSchemas) continue;
    if (indent === 4 && /^[\w.-]+:\s*$/.test(line)) { schema = line.slice(0, -1); out.set(schema, new Set()); mode = null; continue; }
    if (!schema) continue;
    if (indent === 6) {
      const req = line.match(/^required:\s*(\[.*\])?\s*$/);
      mode = req ? 'required' : null;
      if (req?.[1]) req[1].slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach((x) => out.get(schema).add(x));
      continue;
    }
    if (mode === 'required' && /^-\s*/.test(line)) out.get(schema).add(line.replace(/^-\s*/, '').replace(/^["']|["']$/g, ''));
  }
  return out;
}
// Properties that were required in `before` and are not in `after`: Map "Schema" → Set(prop).
export function lostRequired(before, after) {
  const a = requiredBySchema(before), b = requiredBySchema(after);
  const out = new Map();
  for (const [schema, props] of a) {
    const lost = [...props].filter((p) => b.has(schema) && !b.get(schema).has(p));
    if (lost.length) out.set(schema, new Set(lost));
  }
  return out;
}
