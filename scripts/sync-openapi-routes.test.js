import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const generator = path.resolve("scripts/sync-openapi-routes.js");

function run(cwd) { return execFileSync(process.execPath, [generator], { cwd, encoding: "utf8" }); }
function readSpec(cwd) { return YAML.parse(fs.readFileSync(path.join(cwd, "openapi/users.yaml"), "utf8")); }

test("reconciles added, changed, and removed Express routes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "legatio-route-sync-"));
  fs.mkdirSync(path.join(cwd, "openapi"));
  fs.writeFileSync(path.join(cwd, "openapi/users.yaml"), "openapi: 3.0.3\ninfo: {title: Test, version: 1.0.0}\npaths: {}\n");

  fs.writeFileSync(path.join(cwd, "server.js"), 'app.get("/users", (_req, res) => res.status(200).json({users: []}));\n');
  assert.match(run(cwd), /1 added/);
  assert.equal(readSpec(cwd).paths["/users"].get.responses["200"].description, "Successful response");

  fs.writeFileSync(path.join(cwd, "server.js"), 'app.get("/users", (_req, res) => res.status(201).json({users: []}));\napp.post("/sessions", (_req, res) => res.status(201).json({ok: true}));\n');
  assert.match(run(cwd), /1 added, 1 updated/);
  let spec = readSpec(cwd);
  assert.ok(spec.paths["/users"].get.responses["201"]);
  assert.ok(spec.paths["/sessions"].post);

  fs.writeFileSync(path.join(cwd, "server.js"), 'app.post("/sessions", (_req, res) => res.status(201).json({ok: true}));\n');
  assert.match(run(cwd), /1 removed/);
  spec = readSpec(cwd);
  assert.equal(spec.paths["/users"], undefined);
  assert.ok(spec.paths["/sessions"].post);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("preserves enriched documentation while tracking its source", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "legatio-route-sync-"));
  fs.mkdirSync(path.join(cwd, "openapi"));
  fs.writeFileSync(path.join(cwd, "server.js"), 'app.get("/users", (_req, res) => res.json({users: []}));\n');
  fs.writeFileSync(path.join(cwd, "openapi/users.yaml"), "openapi: 3.0.3\ninfo: {title: Test, version: 1.0.0}\npaths:\n  /users:\n    get:\n      summary: Rich user documentation\n      description: Kept by reconciliation\n      responses:\n        '200': {description: Users returned}\n");
  run(cwd);
  const operation = readSpec(cwd).paths["/users"].get;
  assert.equal(operation.summary, "Rich user documentation");
  assert.equal(operation["x-legatio-source"], "server.js");
  fs.rmSync(cwd, { recursive: true, force: true });
});
