import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const sourceFiles = (process.env.LEGATIO_ROUTE_FILES || "server.js").split(",").map(file => file.trim()).filter(Boolean);
const specPath = path.resolve(root, process.env.LEGATIO_OPENAPI_FILE || "openapi/users.yaml");
const checkOnly = process.argv.includes("--check");
const routePattern = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(["'`])([^"'`]+)\2/g;
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const generatedDescription = "Automatically discovered from the Express route source. Add contract metadata to enrich this operation.";

function openApiPath(expressPath) { return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}"); }
function title(value) { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase()); }
function operationId(method, routePath) { const suffix = routePath.split("/").filter(Boolean).map(part => title(part.replace(/[{}]/g, ""))).join("") || "Root"; return `${method.toLowerCase()}${suffix}`; }
function routeKey(method, routePath) { return `${method.toLowerCase()} ${routePath}`; }

function generatedOperation(method, routePath, source, matchEnd, sourceFile) {
  const remaining = source.slice(matchEnd);
  routePattern.lastIndex = 0;
  const nextMatch = routePattern.exec(remaining);
  const snippet = remaining.slice(0, nextMatch?.index ?? remaining.length);
  const statusCodes = [...snippet.matchAll(/\.status\(\s*(\d{3})\s*\)/g)].map(match => Number(match[1]));
  const successStatus = statusCodes.find(status => status >= 200 && status < 300) || 200;
  const errors = [...new Set(statusCodes.filter(status => status >= 400))];
  const pathParts = routePath.split("/").filter(Boolean);
  const tag = title(pathParts.find(part => !part.startsWith("{")) || "General");
  const parameters = [...routePath.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
  const responses = { [String(successStatus)]: { description: "Successful response" } };
  for (const status of errors) responses[String(status)] = { description: "Request failed" };
  return {
    summary: `${method.toUpperCase()} ${routePath}`,
    description: generatedDescription,
    operationId: operationId(method, routePath),
    tags: [tag],
    "x-feature-owner": "Unassigned",
    "x-rate-limit": "None",
    "x-legatio-generated": true,
    "x-legatio-source": sourceFile,
    ...(parameters.length ? { parameters } : {}),
    responses,
  };
}

function discoverRoutes() {
  const discovered = new Map();
  for (const relativeFile of sourceFiles) {
    const normalizedFile = relativeFile.replaceAll("\\", "/");
    const absoluteFile = path.resolve(root, relativeFile);
    if (!fs.existsSync(absoluteFile)) throw new Error(`Route source not found: ${relativeFile}`);
    const source = fs.readFileSync(absoluteFile, "utf8");
    routePattern.lastIndex = 0;
    for (const match of source.matchAll(routePattern)) {
      if (!match[3].startsWith("/")) continue;
      const method = match[1].toLowerCase();
      const routePath = openApiPath(match[3]);
      const key = routeKey(method, routePath);
      if (discovered.has(key)) throw new Error(`Duplicate Express route discovered: ${key}`);
      discovered.set(key, { method, routePath, operation: generatedOperation(method, routePath, source, match.index + match[0].length, normalizedFile), sourceFile: normalizedFile });
    }
  }
  return discovered;
}

if (!fs.existsSync(specPath)) throw new Error(`OpenAPI file not found: ${path.relative(root, specPath)}`);
const original = fs.readFileSync(specPath, "utf8");
const document = YAML.parse(original);
if (!document?.openapi || !document?.paths) throw new Error("OpenAPI document must contain openapi and paths fields");

const discovered = discoverRoutes();
const changes = { added: [], updated: [], removed: [] };

for (const route of discovered.values()) {
  document.paths[route.routePath] ||= {};
  const existing = document.paths[route.routePath][route.method];
  if (!existing) {
    document.paths[route.routePath][route.method] = route.operation;
    changes.added.push(routeKey(route.method, route.routePath));
    continue;
  }

  if (existing["x-legatio-generated"] === true && existing.description === generatedDescription) {
    const before = YAML.stringify(existing, { lineWidth: 0 });
    const after = YAML.stringify(route.operation, { lineWidth: 0 });
    document.paths[route.routePath][route.method] = route.operation;
    if (before !== after) changes.updated.push(routeKey(route.method, route.routePath));
  } else if (existing["x-legatio-source"] !== route.sourceFile) {
    existing["x-legatio-source"] = route.sourceFile;
    changes.updated.push(routeKey(route.method, route.routePath));
  }
}

for (const [routePath, pathItem] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(pathItem || {})) {
    if (!methods.has(method) || !operation || typeof operation !== "object") continue;
    const managed = operation["x-legatio-generated"] === true || sourceFiles.map(file => file.replaceAll("\\", "/")).includes(operation["x-legatio-source"]);
    if (managed && !discovered.has(routeKey(method, routePath))) {
      delete pathItem[method];
      changes.removed.push(routeKey(method, routePath));
    }
  }
  if (!Object.keys(pathItem || {}).some(key => methods.has(key))) delete document.paths[routePath];
}

const totalChanges = changes.added.length + changes.updated.length + changes.removed.length;
if (checkOnly) {
  if (totalChanges) {
    console.error("OpenAPI is out of sync with Express routes:");
    for (const key of changes.added) console.error(`+ ${key}`);
    for (const key of changes.updated) console.error(`~ ${key}`);
    for (const key of changes.removed) console.error(`- ${key}`);
    process.exitCode = 1;
  } else console.log("OpenAPI exactly matches the discovered Express routes.");
} else if (totalChanges) {
  fs.writeFileSync(specPath, YAML.stringify(document, { lineWidth: 0 }), "utf8");
  for (const key of changes.added) console.log(`Added ${key}`);
  for (const key of changes.updated) console.log(`Updated ${key}`);
  for (const key of changes.removed) console.log(`Removed ${key}`);
  console.log(`OpenAPI reconciled: ${changes.added.length} added, ${changes.updated.length} updated, ${changes.removed.length} removed.`);
} else console.log("OpenAPI is already synchronized with Express routes.");
