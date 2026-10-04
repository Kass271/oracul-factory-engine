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
