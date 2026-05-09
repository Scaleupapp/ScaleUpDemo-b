#!/usr/bin/env node
/**
 * Walk src/routes/*.js, find every router.<method>('/path') declaration,
 * cross-reference src/app.js for the mount path, and print OpenAPI stubs
 * for any operation NOT already documented in openapi.yaml.
 *
 * Output is YAML printed to stdout — pipe into a file, then merge into
 * openapi.yaml under `paths:`. Stubs use permissive schemas so the
 * validator doesn't reject existing valid traffic.
 *
 * Usage:
 *   node scripts/stub-undocumented-routes.js > /tmp/stubs.yaml
 *
 * Re-running is safe — it just re-emits the diff between the routes
 * directory and openapi.yaml.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'src', 'app.js');
const ROUTES_DIR = path.join(ROOT, 'src', 'routes');
const SPEC_PATH = path.join(ROOT, 'openapi.yaml');

// 1. Build mountBase map from app.js: routes/diagnostic -> /api/v1/diagnostic
function loadMountBases() {
  const text = fs.readFileSync(APP_JS, 'utf8');
  const mounts = {};
  const re = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(['"]\.\/routes\/([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    mounts[m[2]] = m[1];
  }
  return mounts;
}

// 2. Parse routes file to extract { method, subPath } pairs.
function loadRouteOps(routeFile) {
  const text = fs.readFileSync(routeFile, 'utf8');
  const ops = [];
  // router.METHOD('/path', ...). Allow chained routers via routerVar names too.
  const re = /\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ops.push({ method: m[1].toLowerCase(), subPath: m[2] });
  }
  return ops;
}

// 3. Convert express ":param" to OpenAPI "{param}".
function toOpenApiPath(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// 4. Build the set of operations already documented in openapi.yaml.
function loadDocumented() {
  if (!fs.existsSync(SPEC_PATH)) return new Set();
  const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
  const documented = new Set();
  for (const [p, ops] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        documented.add(`${method.toUpperCase()} ${p}`);
      }
    }
  }
  return documented;
}

// 5. Path parameters: extract {param} from a path and emit parameter objects.
function pathParams(p) {
  const matches = [...p.matchAll(/\{([A-Za-z0-9_]+)\}/g)];
  if (!matches.length) return null;
  return matches.map(m => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function tagFromMount(base) {
  // /api/v1/notes -> Notes ; /api/v1/learning-paths -> LearningPaths
  const last = base.split('/').filter(Boolean).pop() || base;
  return last
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function operationId(method, fullPath) {
  // Make a stable identifier from the path + method.
  const slug = fullPath
    .replace(/^\/api\/v1\//, '')
    .replace(/\{([A-Za-z0-9_]+)\}/g, 'By$1')
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s.toLowerCase() : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()))
    .join('');
  return `${method}${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
}

// ---- Main ----
const mounts = loadMountBases();
const documented = loadDocumented();
const pathsByPath = {};

for (const file of fs.readdirSync(ROUTES_DIR).sort()) {
  if (!file.endsWith('.js')) continue;
  const baseName = file.replace(/\.js$/, '');
  // Express mount uses dot- and dash-aware names; check the routes/<basename> key
  const mountBase = mounts[baseName];
  if (!mountBase) continue;
  // Skip non-/api/v1 mounts (admin static + admin/diagnostic-questions). The
  // validator middleware skips them at runtime anyway, so they shouldn't be
  // in the spec.
  if (!mountBase.startsWith('/api/v1')) continue;
  const ops = loadRouteOps(path.join(ROUTES_DIR, file));
  if (!ops.length) continue;

  const tag = tagFromMount(mountBase);

  for (const { method, subPath } of ops) {
    const fullExpress = (mountBase + (subPath === '/' ? '' : subPath))
      .replace(/\/$/, '') || '/';
    const full = toOpenApiPath(fullExpress);
    // Strip the /api/v1 prefix to match openapi.yaml's `servers` base.
    const apiPath = full.replace(/^\/api\/v1/, '') || '/';
    const key = `${method.toUpperCase()} ${apiPath}`;
    if (documented.has(key)) continue;

    pathsByPath[apiPath] ||= {};
    if (pathsByPath[apiPath][method]) continue; // already added in this run

    const op = {
      operationId: operationId(method, full),
      summary: `Auto-stubbed: ${method.toUpperCase()} ${full} (extend with real schema when touched)`,
      tags: [tag],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiSuccessEnvelope' },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    };

    if (method !== 'get' && method !== 'delete') {
      op.requestBody = {
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true },
          },
        },
      };
    }

    pathsByPath[apiPath][method] = op;

    // Path params
    const params = pathParams(apiPath);
    if (params) {
      pathsByPath[apiPath].parameters ||= params;
    }
  }
}

const out = { paths: pathsByPath };
process.stdout.write(yaml.dump(out, { noRefs: true, lineWidth: 120 }));
