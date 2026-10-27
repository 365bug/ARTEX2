"use client";

import * as React from "react";

import { Globe2Icon, Loader2Icon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { EgressCheck, EgressReport } from "@/lib/types";
import { cn } from "@/lib/utils";

const DISMISSED_STORAGE_KEY = "artex-egress-ip-banner-dismissed";
const REPORT_STORAGE_KEY = "artex-egress-ip-banner-report";

type ProbeOptions = {
  globalProxy: string;
  probeUrl?: string;
};

type EgressIpBannerContextValue = {
  probeEgress: (options: ProbeOptions) => Promise<EgressReport>;
  isLoading: boolean;
  report: EgressReport | null;
  error: string | null;
  dismissed: boolean;
  dismiss: () => void;
};

const EgressIpBannerContext = React.createContext<EgressIpBannerContextValue | null>(null);

function readDismissed() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function setDismissedStorage(dismissed: boolean) {
  try {
    if (dismissed) window.sessionStorage.setItem(DISMISSED_STORAGE_KEY, "true");
    else window.sessionStorage.removeItem(DISMISSED_STORAGE_KEY);
  } catch {
    // sessionStorage can be unavailable in privacy-restricted browsers.
  }
}

function readStoredReport(): EgressReport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(REPORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { checks?: unknown }).checks)) {
      return null;
    }
    return parsed as EgressReport;
  } catch {
    return null;
  }
}

function setStoredReport(report: EgressReport | null) {
  try {
    if (report) window.sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
    else window.sessionStorage.removeItem(REPORT_STORAGE_KEY);
  } catch {
    // sessionStorage can be unavailable in privacy-restricted browsers.
  }
}

export function EgressIpBannerProvider({ children }: { children: React.ReactNode }) {
  const [report, setReport] = React.useState<EgressReport | null>(readStoredReport);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(readDismissed);

  const probeEgress = React.useCallback(async ({ globalProxy, probeUrl }: ProbeOptions) => {
    setDismissed(false);
    setDismissedStorage(false);
    setError(null);
    setIsLoading(true);
    try {
      const nextReport = await api.testEgressProxy({
        global_proxy: globalProxy,
        ...(probeUrl ? { probe_url: probeUrl } : {}),
      });
      setReport(nextReport);
      setStoredReport(nextReport);
      return nextReport;
    } catch (cause) {
      setReport(null);
      setStoredReport(null);
      const message = cause instanceof Error ? cause.message : "未知错误";
      setError(message);
      throw cause;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const dismiss = React.useCallback(() => {
    setDismissed(true);
    setDismissedStorage(true);
  }, []);

  const value = React.useMemo(
    () => ({ probeEgress, isLoading, report, error, dismissed, dismiss }),
    [dismiss, dismissed, error, isLoading, probeEgress, report],
  );

  return <EgressIpBannerContext.Provider value={value}>{children}</EgressIpBannerContext.Provider>;
}

export function useEgressIpBanner() {
  const context = React.useContext(EgressIpBannerContext);
  if (!context) throw new Error("useEgressIpBanner must be used within EgressIpBannerProvider");
  return context;
}

function checkMessage(check: EgressCheck | undefined) {
  if (!check) return "未返回结果";
  if (check.skipped) return "未配置 / 已跳过";
  if (check.result.ok) return check.result.exit_ip || "已连通，但未返回 IP";
  return `探测失败：${check.result.probes.find((probe) => probe.error)?.error || check.result.error || "未知错误"}`;
}

function IpRow({ label, check }: { label: string; check: EgressCheck | undefined }) {
  const failed = !!check && !check.skipped && !check.result.ok;
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate font-mono", failed && "text-destructive")}>{checkMessage(check)}</span>
    </div>
  );
}

export function EgressIpBanner() {
  const { report, error, isLoading, dismissed, dismiss } = useEgressIpBanner();
  if (dismissed) return null;
  if (!isLoading && !report && !error) return null;

  const direct = report?.checks.find((check) => check.key === "direct");
  const global = report?.checks.find((check) => check.key === "global");
  let statusContent: React.ReactNode;
  if (isLoading) {
    statusContent = (
      <div className="mt-1 flex items-center gap-2 text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
        正在探测直连和全局代理出口 IP…
      </div>
    );
  } else if (error) {
    statusContent = <div className="mt-1 text-destructive">探测失败：{error}</div>;
  } else {
    statusContent = (
      <div className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <IpRow label="直连 IP" check={direct} />
        <IpRow label="全局代理 IP" check={global} />
      </div>
    );
  }

  return (
    <div className="border-b bg-primary/5 px-4 py-2.5 md:px-6" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <Globe2Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">出口 IP</div>
          {statusContent}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label="关闭出口 IP 提示">
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
