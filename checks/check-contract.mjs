#!/usr/bin/env node
// Rule: api/openapi.yaml is the single contract. Both sides are generated from it, so drift becomes impossible:
//   1. openapi.yaml is structurally valid (version 3.x, info.title/version, paths, unique operationIds)
//   2. backend generates Spring interfaces from it before compiling
//   3. frontend generates the Angular client from it before build/test
//   4. --require-generated: generated code exists and is newer than openapi.yaml (verify passes this after building)
//   5. no property is both required and nullable when the app leaves null fields out of the JSON
//      (spring.jackson.default-property-inclusion=non_null) — it would vanish from responses. Other apps: WARN only.
import fs from 'node:fs';
import path from 'node:path';
import { Report, context, parseArgs, readJson, readText } from './lib/core.mjs';
import { requiredNullable } from './lib/openapi.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report('contract');
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }
const at = (p) => path.join(ctx.appDir, p);

const spec = readText(at('api/openapi.yaml'));
if (spec === null) r.missing('api/openapi.yaml');
else {
  if (!/^openapi:\s*["']?3\.\d+\.\d+/m.test(spec)) r.invalid('openapi.yaml: "openapi: 3.x.y" line missing');
  else if (!/^info:\s*$[\s\S]*?^\s+title:\s*\S/m.test(spec) || !/^\s+version:\s*\S/m.test(spec)) r.invalid('openapi.yaml: info.title / info.version missing');
  else if (!/^paths:\s*$/m.test(spec)) r.invalid('openapi.yaml: "paths:" section missing');
  else if (/\t/.test(spec)) r.invalid('openapi.yaml: contains tab characters (YAML forbids tabs for indentation)');
  else {
    const ops = [...spec.matchAll(/^\s+operationId:\s*(\S+)/gm)].map((m) => m[1]);
    const dup = ops.filter((o, i) => ops.indexOf(o) !== i);
    const methods = [...spec.matchAll(/^\s{4}(get|post|put|patch|delete):\s*$/gm)].length;
    if (dup.length) r.invalid(`openapi.yaml: duplicate operationId ${[...new Set(dup)].join(', ')}`);
    else if (ops.length < methods) r.invalid(`openapi.yaml: ${methods - ops.length} operation(s) without operationId`);
    else r.pass(`openapi.yaml valid (${ops.length} operations)`);
  }
}

if (spec !== null) {
  const both = requiredNullable(spec);
  const nonNull = /^\s*spring\.jackson\.default-property-inclusion\s*[=:]\s*non_null\s*$/im.test(readText(at('backend/src/main/resources/application.properties')) || '');
  if (!both.length) r.pass('no property is both required and nullable');
  else if (nonNull) r.invalid(`required + nullable: ${both.join(', ')} — with NON_NULL a null value disappears from the JSON; make it optional (absent = null) or non-null`);
  else r.warn(`required + nullable: ${both.join(', ')} (allowed here: this app writes null fields)`);
}

const gradle = readText(at('backend/build.gradle.kts'));
if (gradle === null) r.missing('backend/build.gradle.kts');
else if (!/openApiGenerate/.test(gradle) || !/api\/openapi\.yaml/.test(gradle)) r.invalid('backend does not generate from api/openapi.yaml (openApiGenerate task missing)');
else if (!/compileJava[\s\S]{0,80}dependsOn\(.*openApiGenerate/.test(gradle)) r.invalid('backend: compileJava must dependsOn(openApiGenerate)');
else r.pass('backend generates interfaces from openapi.yaml before compile');

const genCfg = readJson(at('frontend/ng-openapi-gen.json'));
const pkg = readJson(at('frontend/package.json'));
if (!genCfg) r.missing('frontend/ng-openapi-gen.json');
else if (!/api\/openapi\.yaml$/.test(genCfg.input || '')) r.invalid('frontend/ng-openapi-gen.json input must point to ../api/openapi.yaml');
else if (!pkg) r.missing('frontend/package.json');
else {
  const s = pkg.scripts || {};
  const hooked = ['prebuild', 'pretest', 'prestart'].filter((k) => /generate:api/.test(s[k] || ''));
  if (!s['generate:api'] || hooked.length < 3) r.invalid('frontend: generate:api must run in prebuild, pretest and prestart');
  else r.pass('frontend generates the client from openapi.yaml before build/test/start');
}

if (args['require-generated'] && spec !== null) {
  const specTime = fs.statSync(at('api/openapi.yaml')).mtimeMs;
  for (const [layer, dir] of [['backend', 'backend/build/generated/openapi'], ['frontend', genCfg?.output ? path.join('frontend', genCfg.output) : 'frontend/src/app/api']]) {
    const p = at(dir);
    if (!fs.existsSync(p)) { r.missing(`${layer} generated code (${dir}) — build has not run`); continue; }
    const newest = newestMtime(p);
    if (newest + 1000 < specTime) r.invalid(`${layer} generated code is older than openapi.yaml — regenerate`);
    else r.pass(`${layer} generated code is up to date`);
  }
}

function newestMtime(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

process.exit(r.finish());
