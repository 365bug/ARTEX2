"use client";

import { create } from "zustand";

import { getLocalStorageValue, setLocalStorageValue } from "@/lib/local-storage.client";

import type { RepeaterInitial } from "./repeater-http";
import {
  addTab,
  DEFAULT_GROUP_ID,
  defaultWorkspace,
  deserializeWorkspace,
  emptyTab,
  MAX_HISTORY,
  newId,
  type RepeaterHistoryEntry,
  type RepeaterTab,
  type RepeaterWorkspace,
  STORAGE_KEY,
  seedWorkspace,
  serializeWorkspace,
  type TabOptions,
  type TabSeed,
} from "./repeater-state";

export type TabPatch = Partial<
  Pick<RepeaterTab, "method" | "url" | "headersText" | "body" | "useProxy" | "insecure" | "response">
>;
type Store = {
  workspace: RepeaterWorkspace | null;
  hydrate: () => void;
  createTab: (seed?: TabSeed, opts?: TabOptions) => string;
  closeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: TabPatch) => void;
  recordSend: (id: string, entry: RepeaterHistoryEntry) => void;
  createGroup: (name?: string) => void;
  renameGroup: (id: string, name: string) => void;
  setTabGroup: (tabId: string, groupId: string) => void;
  toggleGroupCollapsed: (id: string) => void;
  clearWorkspace: () => void;
  seedFromEvidence: (initial: RepeaterInitial, meta?: RepeaterTab["source"], opts?: TabOptions) => string;
};

let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const workspace = useRepeaterStore.getState().workspace;
  if (workspace) setLocalStorageValue(STORAGE_KEY, serializeWorkspace(workspace));
}

export const useRepeaterStore = create<Store>((set, get) => {
  function current() {
    get().hydrate();
    return get().workspace as RepeaterWorkspace;
  }
  function change(workspace: RepeaterWorkspace) {
    set({ workspace });
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }
  function editTab(id: string, patch: Partial<RepeaterTab>) {
    const workspace = current();
    if (!workspace.tabs.some((tab) => tab.id === id)) return;
    change({
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.id === id ? { ...tab, ...patch, updatedAt: new Date().toISOString() } : tab,
      ),
    });
  }
  return {
    workspace: null,
    hydrate: () => {
      if (get().workspace || typeof window === "undefined") return;
      set({ workspace: deserializeWorkspace(getLocalStorageValue(STORAGE_KEY)) });
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    },
    createTab: (seed, opts) => {
      const workspace = addTab(current(), seed, opts);
      change(workspace);
      return workspace.tabs[workspace.tabs.length - 1].id;
    },
    closeTab: (id) => {
      const workspace = current();
      const index = workspace.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const tabs = workspace.tabs.filter((tab) => tab.id !== id);
      if (!tabs.length) tabs.push(emptyTab());
      change({
        ...workspace,
        tabs,
        groups: workspace.groups.map((group) =>
          group.id === tabs[Math.min(index, tabs.length - 1)].groupId && workspace.activeTabId === id
            ? { ...group, collapsed: false }
            : group,
        ),
        activeTabId: workspace.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)].id : workspace.activeTabId,
      });
      flush();
    },
    renameTab: (id, title) => {
      if (title.trim()) editTab(id, { title: title.trim() });
    },
    setActiveTab: (id) => {
      const workspace = current();
      const tab = workspace.tabs.find((item) => item.id === id);
      if (tab)
        change({
          ...workspace,
          activeTabId: id,
          groups: workspace.groups.map((group) => (group.id === tab.groupId ? { ...group, collapsed: false } : group)),
        });
    },
    updateTab: editTab,
    recordSend: (id, entry) => {
      const tab = current().tabs.find((item) => item.id === id);
      if (tab) editTab(id, { response: entry.response, history: [entry, ...tab.history].slice(0, MAX_HISTORY) });
    },
    createGroup: (name) => {
      const workspace = current();
      change({
        ...workspace,
        groups: [...workspace.groups, { id: newId(), name: name?.trim() || `分组 ${workspace.groups.length + 1}` }],
      });
    },
    renameGroup: (id, name) => {
      if (!name.trim()) return;
      const workspace = current();
      change({
        ...workspace,
        groups: workspace.groups.map((group) => (group.id === id ? { ...group, name: name.trim() } : group)),
      });
    },
    setTabGroup: (tabId, groupId) => {
      const workspace = current();
      if (!workspace.groups.some((group) => group.id === groupId)) return;
      editTab(tabId, { groupId });
      if (workspace.activeTabId === tabId) get().setActiveTab(tabId);
    },
    toggleGroupCollapsed: (id) => {
      const workspace = current();
      change({
        ...workspace,
        groups: workspace.groups.map((group) => (group.id === id ? { ...group, collapsed: !group.collapsed } : group)),
      });
    },
    clearWorkspace: () => {
      change(defaultWorkspace());
      flush();
    },
    seedFromEvidence: (initial, meta, opts) => {
      const workspace = seedWorkspace(current(), initial, meta, { groupId: DEFAULT_GROUP_ID, ...opts });
      change(workspace);
      flush();
      return workspace.tabs[workspace.tabs.length - 1].id;
    },
  };
});

export function seedFromEvidence(initial: RepeaterInitial, meta?: RepeaterTab["source"], opts?: TabOptions) {
  return useRepeaterStore.getState().seedFromEvidence(initial, meta, opts);
}
