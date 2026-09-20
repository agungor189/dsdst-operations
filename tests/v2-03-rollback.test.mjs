import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runbookPath = path.join(root, "docs", "v2-03-session-rollback.md");

test("pre-V2-03 rollback is gated by secret rotation and forced re-login", () => {
  assert.equal(fs.existsSync(runbookPath), true, "V2-03 rollback runbook must exist");
  const runbook = fs.readFileSync(runbookPath, "utf8");
  assert.match(runbook, /JWT secret rotation is mandatory/i);
  assert.match(runbook, /revoke all current `user_sessions`/i);
  assert.match(runbook, /increment every user's `session_epoch`/i);
  assert.match(runbook, /old direct and service-bound tokens.*401/i);
  assert.match(runbook, /do not expose pre-V2-03 code/i);
  assert.match(runbook, /rollback abort/i);
});
