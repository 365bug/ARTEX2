import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Keep the tests runnable on Node 20 as well as versions with native TS support.
const require = createRequire(import.meta.url);
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node10" },
});
const {
  addTab,
  defaultWorkspace,
  deserializeWorkspace,
  MAX_HISTORY,
  MAX_RESPONSE_CHARS,
  MAX_STORAGE_BYTES,
  seedWorkspace,
  serializeWorkspace,
  truncateResponse,
} = require("./repeater-state.ts");
const {
  buildRawResponse,
  getHostHeader,
  headersFromReqHead,
  parseHeadersText,
  setHostHeader,
} = require("./repeater-http.ts");

const response = (body = "ok") => ({
  status: 200,
  status_text: "200 OK",
  proto: "HTTP/1.1",
  headers: { "Content-Type": ["text/plain"] },
  body,
  body_truncated: false,
  body_bytes: body.length,
  elapsed_ms: 12,
  url: "https://example.test/",
});
const entry = (id, body = "ok") => ({
  id: String(id),
  method: "POST",
  url: "https://example.test/",
  headersText: "Host: example.test",
  body: "draft",
  useProxy: true,
  insecure: false,
  response: response(body),
  at: new Date(id * 1000).toISOString(),
});

test("response body is capped at 256 Ki characters without mutating the live response", () => {
  const original = response("x".repeat(MAX_RESPONSE_CHARS + 1));
  const truncated = truncateResponse(original);
  assert.equal(truncated.body.length, MAX_RESPONSE_CHARS);
  assert.equal(truncated.body_truncated, true);
  assert.equal(truncated.body_bytes, MAX_RESPONSE_CHARS + 1);
  assert.equal(original.body.length, MAX_RESPONSE_CHARS + 1);
  assert.equal(original.body_truncated, false);
  assert.equal(truncateResponse(response()).body_truncated, false);
});

test("persisted response bodies and histories are capped; live state is unchanged", () => {
  const workspace = defaultWorkspace();
  const tab = workspace.tabs[0];
  tab.response = response("x".repeat(MAX_RESPONSE_CHARS + 1));
  tab.history = Array.from({ length: 25 }, (_, index) => entry(25 - index));
  tab.history[0].response = tab.response;
  const saved = JSON.parse(serializeWorkspace(workspace));
  assert.equal(saved.tabs[0].history.length, MAX_HISTORY);
  assert.equal(saved.tabs[0].history[0].id, "25");
  assert.equal(saved.tabs[0].response.body.length, MAX_RESPONSE_CHARS);
  assert.equal(saved.tabs[0].history[0].response.body.length, MAX_RESPONSE_CHARS);
  assert.equal(tab.history.length, 25);
});

test("serialize/deserialize preserves drafts, groups, active tab, source and response", () => {
  let workspace = defaultWorkspace();
  workspace.groups.push({ id: "other", name: "验证", collapsed: true });
  workspace = seedWorkspace(
    workspace,
    { method: "post", url: "https://example.test/path", body: "payload", headersText: "Host: override" },
    { findingId: "42", bindingId: "2", label: "proof" },
    { groupId: "other" },
  );
  workspace.tabs[1].response = response();
  workspace.tabs[1].history = [entry(1)];
  assert.deepEqual(JSON.parse(JSON.stringify(deserializeWorkspace(serializeWorkspace(workspace)))), workspace);
});

test("missing, corrupt and malformed storage recover a default group and empty tab", () => {
  const malformed = defaultWorkspace();
  malformed.tabs[0].response = { body: "bad" };
  for (const raw of [
    null,
    "",
    "{",
    "null",
    "[]",
    '{"version":2}',
    '{"version":1,"groups":[],"tabs":[{}]}',
    JSON.stringify(malformed),
  ]) {
    const recovered = deserializeWorkspace(raw);
    assert.equal(recovered.version, 1);
    assert.equal(recovered.groups[0].name, "默认");
    assert.equal(recovered.tabs.length, 1);
    assert.equal(recovered.tabs[0].title, "Tab 1");
    assert.equal(recovered.tabs[0].url, "");
    assert.equal(recovered.activeTabId, recovered.tabs[0].id);
  }
});

test("seeding always creates a new active tab in default or specified group", () => {
  const initial = defaultWorkspace();
  const seeded = seedWorkspace(initial, { method: "post", url: "https://example.test:8443/path" });
  assert.equal(initial.tabs.length, 1);
  assert.equal(seeded.tabs.length, 2);
  assert.equal(seeded.tabs[1].groupId, "default");
  assert.equal(seeded.tabs[1].title, "POST example.test:8443");
  assert.equal(seeded.activeTabId, seeded.tabs[1].id);
  seeded.groups.push({ id: "custom", name: "验证", collapsed: true });
  const custom = seedWorkspace(seeded, {}, { label: "证据" }, { groupId: "custom" });
  assert.equal(custom.tabs[2].groupId, "custom");
  assert.equal(custom.tabs[2].title, "证据");
  assert.equal(custom.groups[1].collapsed, false);
  const background = addTab(custom, {}, { activate: false, groupId: "missing" });
  assert.equal(background.activeTabId, custom.activeTabId);
  assert.equal(background.tabs[3].groupId, "default");
});

test("budget removes globally oldest history first then strips responses, preserving drafts", () => {
  const workspace = addTab(defaultWorkspace());
  workspace.tabs[0].history = [entry(3), entry(1)];
  workspace.tabs[1].history = [entry(4), entry(2)];
  const limit = Buffer.byteLength(serializeWorkspace(workspace)) - Buffer.byteLength(JSON.stringify(entry(1))) - 1;
  const saved = JSON.parse(serializeWorkspace(workspace, limit));
  assert.deepEqual(
    saved.tabs.map((tab) => tab.history.map((item) => item.id)),
    [["3"], ["4", "2"]],
  );
  workspace.tabs[0].response = response("中".repeat(MAX_RESPONSE_CHARS));
  workspace.tabs[1].response = response("x".repeat(MAX_RESPONSE_CHARS));
  workspace.tabs[0].body = "keep this request";
  const stripped = JSON.parse(serializeWorkspace(workspace, 3000));
  assert.equal(stripped.tabs[0].body, "keep this request");
  assert.equal(stripped.tabs[0].response.body, "");
  assert.equal(stripped.tabs[0].response.body_truncated, true);
  assert.equal(workspace.tabs[0].history.length, 2);
  let large = defaultWorkspace();
  for (let id = 0; id < 5; id++) large = addTab(large);
  for (const tab of large.tabs) {
    tab.response = response("中".repeat(MAX_RESPONSE_CHARS));
    tab.history = [entry(1, "中".repeat(MAX_RESPONSE_CHARS))];
  }
  assert.ok(Buffer.byteLength(serializeWorkspace(large)) <= MAX_STORAGE_BYTES);
});

test("Host shortcut replaces case-insensitive duplicates and preserves other header lines", () => {
  const headers = "X-Test: one\r\nhOsT: old.test\r\nCookie: a=1\r\nHost: duplicate.test\r\nX-Test: two";
  const updated = setHostHeader(headers, "new.test:8080");
  assert.equal(updated, "X-Test: one\nHost: new.test:8080\nCookie: a=1\nX-Test: two");
  assert.equal(getHostHeader(updated), "new.test:8080");
  assert.equal(getHostHeader("HOST: manual.test"), "manual.test");
  assert.equal(setHostHeader(updated, ""), "X-Test: one\nCookie: a=1\nX-Test: two");
  assert.equal(setHostHeader("Accept: */*", "new.test"), "Host: new.test\nAccept: */*");
  assert.equal(getHostHeader(setHostHeader("", "evil\r\nHeader: injected")), "evilHeader: injected");
  assert.deepEqual(parseHeadersText(updated), { "X-Test": "one, two", Host: "new.test:8080", Cookie: "a=1" });
});

test("migrated HTTP helpers retain raw request and response formatting", () => {
  assert.equal(headersFromReqHead("\r\nGET / HTTP/1.1\r\nHost: example.test\r\n"), "Host: example.test");
  assert.equal(buildRawResponse(response()), "HTTP/1.1 200 OK\nContent-Type: text/plain\n\nok");
});
