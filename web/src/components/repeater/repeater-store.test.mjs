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
const { flush, useRepeaterStore } = require("./repeater-store.ts");
const { toast } = require("sonner");

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
  const limit = (serializeWorkspace(workspace).length - JSON.stringify(entry(1)).length - 1) * 2;
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
  assert.ok(serializeWorkspace(large).length * 2 <= MAX_STORAGE_BYTES);
});

test("storage cap counts UTF-16 bytes for ASCII, Chinese and surrogate pairs", () => {
  for (const text of ["x", "中", "😀"]) {
    let workspace = defaultWorkspace();
    for (let index = 0; index < 5; index++) workspace = addTab(workspace);
    for (const tab of workspace.tabs) {
      const body = text.repeat(MAX_RESPONSE_CHARS).slice(0, MAX_RESPONSE_CHARS);
      tab.response = response(body);
      tab.history = [entry(1, body)];
      tab.body = `保留草稿 ${text}`;
    }
    assert.ok(JSON.stringify(workspace).length * 2 > MAX_STORAGE_BYTES);
    const json = serializeWorkspace(workspace);
    assert.ok(json.length * 2 <= MAX_STORAGE_BYTES);
    assert.deepEqual(
      JSON.parse(json).tabs.map((tab) => tab.body),
      workspace.tabs.map((tab) => tab.body),
    );
  }
});

test("drafts exceeding the soft UTF-16 budget are never discarded", () => {
  const workspace = defaultWorkspace();
  workspace.tabs[0].body = "x".repeat(MAX_STORAGE_BYTES / 2);
  workspace.tabs[0].response = response("previous");
  workspace.tabs[0].history = [entry(1)];
  const json = serializeWorkspace(workspace);
  const saved = JSON.parse(json);
  assert.ok(json.length * 2 > MAX_STORAGE_BYTES);
  assert.equal(saved.tabs[0].body, workspace.tabs[0].body);
  assert.deepEqual(saved.tabs[0].history, []);
  assert.equal(saved.tabs[0].response.body, "");
});

function setupStore(t) {
  const previousWindow = globalThis.window;
  const writes = [];
  globalThis.window = {
    localStorage: {
      setItem: (key, value) => writes.push({ key, value }),
    },
  };
  useRepeaterStore.setState({ workspace: addTab(defaultWorkspace()), inflight: {} });
  t.after(() => {
    useRepeaterStore.setState({ workspace: null, inflight: {} });
    flush(); // Cancel pending persistence without writing to another test's storage.
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return { store: useRepeaterStore.getState(), writes };
}

test("a second send invalidates only that tab's first send and stale cleanup cannot clear it", (t) => {
  const { store } = setupStore(t);
  const [first, other] = store.workspace.tabs;
  store.recordSend(first.id, entry(1, "previous"));
  const generation1 = store.beginSend(first.id);
  const otherGeneration = store.beginSend(other.id);
  const generation2 = store.beginSend(first.id);
  assert.notEqual(generation1, generation2);
  assert.equal(store.isCurrentSend(first.id, generation1), false);
  assert.equal(store.isCurrentSend(first.id, generation2), true);
  assert.equal(store.isCurrentSend(other.id, otherGeneration), true);
  store.completeSend(first.id, generation1, entry(2, "stale"));
  store.clearInflight(first.id, generation1);
  assert.equal(useRepeaterStore.getState().inflight[first.id], generation2);
  assert.equal(useRepeaterStore.getState().workspace.tabs[0].response.body, "previous");
  store.completeSend(first.id, generation2, entry(3, "newest"));
  const state = useRepeaterStore.getState();
  assert.equal(state.workspace.tabs[0].response.body, "newest");
  assert.deepEqual(
    state.workspace.tabs[0].history.map((item) => item.id),
    ["3", "1"],
  );
  assert.equal(state.inflight[first.id], undefined);
  assert.equal(state.inflight[other.id], otherGeneration);
});

test("closing a tab or clearing the workspace drops pending results and history", (t) => {
  const { store } = setupStore(t);
  const [closed, other] = store.workspace.tabs;
  const generation = store.beginSend(closed.id);
  const otherGeneration = store.beginSend(other.id);
  store.closeTab(closed.id);
  assert.equal(store.isCurrentSend(closed.id, generation), false);
  assert.equal(store.beginSend(closed.id), undefined);
  store.completeSend(closed.id, generation, entry(1));
  assert.equal(useRepeaterStore.getState().inflight[closed.id], undefined);
  assert.equal(useRepeaterStore.getState().workspace.tabs.length, 1);
  assert.deepEqual(useRepeaterStore.getState().workspace.tabs[0].history, []);
  assert.equal(store.isCurrentSend(other.id, otherGeneration), true);
  store.clearWorkspace();
  store.completeSend(other.id, otherGeneration, entry(2));
  assert.deepEqual(useRepeaterStore.getState().inflight, {});
  assert.deepEqual(useRepeaterStore.getState().workspace.tabs[0].history, []);
});

test("busy state survives remount and successful completion records without an editor mounted", async (t) => {
  const { store, writes } = setupStore(t);
  const [tab, other] = store.workspace.tabs;
  store.recordSend(tab.id, entry(1, "previous"));
  const observedBusy = [];
  const unmount = useRepeaterStore.subscribe((state) => observedBusy.push(state.inflight[tab.id] !== undefined));
  const generation = store.beginSend(tab.id);
  let resolveResponse;
  const pending = new Promise((resolve) => {
    resolveResponse = resolve;
  }).then((result) => store.completeSend(tab.id, generation, result));
  unmount();
  store.setActiveTab(other.id);
  store.setActiveTab(tab.id);
  // A remounted editor reads the same store selector to disable duplicate sends.
  assert.equal(useRepeaterStore.getState().inflight[tab.id] !== undefined, true);
  assert.equal(useRepeaterStore.getState().workspace.tabs[0].response.body, "previous");
  store.setActiveTab(other.id);
  resolveResponse(entry(2, "completed offscreen"));
  await pending;
  const state = useRepeaterStore.getState();
  assert.deepEqual(observedBusy, [true]);
  assert.equal(state.inflight[tab.id], undefined);
  assert.equal(state.workspace.activeTabId, other.id);
  assert.equal(state.workspace.tabs[0].response.body, "completed offscreen");
  assert.deepEqual(
    state.workspace.tabs[0].history.map((item) => item.id),
    ["2", "1"],
  );
  assert.equal(JSON.parse(writes.at(-1).value).tabs[0].history[0].id, "2");
});

test("failed send cleanup preserves the previous response and history", (t) => {
  const { store } = setupStore(t);
  const tab = store.workspace.tabs[0];
  store.recordSend(tab.id, entry(1, "previous"));
  const generation = store.beginSend(tab.id);
  store.clearInflight(tab.id, generation);
  const state = useRepeaterStore.getState();
  assert.equal(state.inflight[tab.id], undefined);
  assert.equal(state.workspace.tabs[0].response.body, "previous");
  assert.deepEqual(
    state.workspace.tabs[0].history.map((item) => item.id),
    ["1"],
  );
});

test("failed storage write retries with histories and response bodies removed, preserving live data and drafts", (t) => {
  const { store } = setupStore(t);
  const tab = store.workspace.tabs[0];
  store.updateTab(tab.id, { body: "keep this draft" });
  store.recordSend(tab.id, entry(1, "previous response"));
  const attempts = [];
  t.mock.method(globalThis.window.localStorage, "setItem", (_key, value) => {
    attempts.push(value);
    if (attempts.length === 1) throw new DOMException("full", "QuotaExceededError");
  });
  const error = t.mock.method(toast, "error", () => "test-toast");
  flush();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].length < attempts[0].length);
  const saved = JSON.parse(attempts[1]).tabs[0];
  assert.equal(saved.body, "keep this draft");
  assert.deepEqual(saved.history, []);
  assert.equal(saved.response.body, "");
  assert.equal(saved.response.body_truncated, true);
  assert.equal(useRepeaterStore.getState().workspace.tabs[0].response.body, "previous response");
  assert.equal(useRepeaterStore.getState().workspace.tabs[0].history.length, 1);
  assert.equal(error.mock.callCount(), 0);
});

test("two failed storage writes report save failure through a Chinese error toast", (t) => {
  const { store } = setupStore(t);
  const tab = store.workspace.tabs[0];
  store.updateTab(tab.id, { body: "unsaved draft" });
  const setItem = t.mock.method(globalThis.window.localStorage, "setItem", () => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const error = t.mock.method(toast, "error", () => "test-toast");
  flush();
  assert.equal(setItem.mock.callCount(), 2);
  assert.equal(error.mock.callCount(), 1);
  assert.match(error.mock.calls[0].arguments[0], /工作区保存失败/);
  assert.equal(useRepeaterStore.getState().workspace.tabs[0].body, "unsaved draft");
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
