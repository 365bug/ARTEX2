"use client";

import * as React from "react";

import Link from "next/link";

import { CopyIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { IntelligenceKind, IntelligencePage, TaskIntelligence } from "@/lib/types";

const KINDS: { value: IntelligenceKind; label: string }[] = [
  { value: "credential", label: "凭据" },
  { value: "lead", label: "重要线索" },
  { value: "sensitive_data", label: "敏感数据" },
];
const STATUS: Record<IntelligenceKind, Record<string, string>> = {
  credential: { unverified: "未验证", verified: "已验证", invalid: "已失效" },
  lead: { pending: "待跟进", in_progress: "跟进中", dismissed: "已排除", converted: "已转漏洞" },
  sensitive_data: { suspected: "疑似", confirmed: "已确认", dismissed: "已排除" },
};
function prettyContent(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
function time(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}

export function IntelligencePanel({ scope, scopeId }: { scope: "tasks" | "assets"; scopeId: string }) {
  const [kind, setKind] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [data, setData] = React.useState<IntelligencePage | null>(null);
  const [error, setError] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [selected, setSelected] = React.useState<TaskIntelligence | null>(null);
  const [detail, setDetail] = React.useState<TaskIntelligence | null>(null);
  const [revealing, setRevealing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const detailRequest = React.useRef(0);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads this resource after a user action.
  React.useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const params = new URLSearchParams({ limit: "25", offset: String(page * 25) });
        if (kind !== "all") params.set("kind", kind);
        if (status !== "all") params.set("status", status);
        if (query) params.set("q", query);
        const result = await api.intelligence(scope, scopeId, params);
        if (alive) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scope, scopeId, kind, status, query, page, refresh]);
  const open = (item: TaskIntelligence) => {
    detailRequest.current++;
    setSelected(item);
    setDetail(item.redacted ? null : item);
    setRevealing(false);
  };
  const close = () => {
    detailRequest.current++;
    setSelected(null);
    setDetail(null);
    setRevealing(false);
  };
  const reveal = async () => {
    if (!selected) return;
    const request = ++detailRequest.current;
    setRevealing(true);
    try {
      const result = await api.intelligenceDetail(scope, scopeId, selected.id);
      if (request === detailRequest.current) setDetail(result);
    } catch (e) {
      if (request === detailRequest.current) toast.error("读取失败：" + (e as Error).message);
    } finally {
      if (request === detailRequest.current) setRevealing(false);
    }
  };
  const update = async (value: string) => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.updateIntelligence(selected.task_id, selected.id, value);
      setSelected((item) => (item ? { ...item, status: value } : null));
      setDetail((item) => (item ? { ...item, status: value } : null));
      setRefresh((n) => n + 1);
      toast.success("情报状态已更新");
    } catch (e) {
      toast.error("更新失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const statusOptions = kind === "all" ? {} : STATUS[kind as IntelligenceKind];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {data && !data.enabled && scope === "tasks" ? (
        <Alert>
          <AlertTitle>自动记录已关闭</AlertTitle>
          <AlertDescription>
            已有情报仍可查看。前往{" "}
            <Link href="/system/settings" className="underline">
              系统设置
            </Link>{" "}
            开启后，Agent 将在执行中记录新增情报，并产生额外 Token 消耗。
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{scope === "tasks" ? "任务情报" : "资产关联情报"}</CardTitle>
          <CardDescription>
            {scope === "tasks" ? "集中查看本次获取与直接关联任务继承的情报。" : "按来源任务查看此资产关联的情报。"}{" "}
            凭据与敏感数据按需显示，发现凭据不代表验证成功。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <Tabs
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              setStatus("all");
              setPage(0);
            }}
          >
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger value="all">
                全部 {data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : ""}
              </TabsTrigger>
              {KINDS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label} {data?.counts[item.value] ?? 0}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="搜索情报标题或上报者"
              placeholder="搜索标题或上报者"
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-40 flex-1"
            />
            {kind !== "all" ? (
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="筛选情报状态">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部状态</SelectItem>
                    {Object.entries(statusOptions).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              <RefreshCwIcon data-icon="inline-start" />
              刷新
            </Button>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>读取情报失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!data && !error ? (
            <Skeleton className="h-40 w-full" />
          ) : data?.items.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>类别 / 标题</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>资产</TableHead>
                  <TableHead>发现时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-80">
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="secondary">{KINDS.find((k) => k.value === item.kind)?.label}</Badge>
                        <span className="break-words">{item.title}</span>
                        {item.redacted ? (
                          <span className="text-xs text-muted-foreground">内容已隐藏 · 查看详情后显示</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="outline">{STATUS[item.kind][item.status] ?? item.status}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {item.confidence === "observed" ? "直接观察" : "推测"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Link href={`/function/tasks/detail?id=${item.task_id}&tab=intelligence`} className="underline">
                          任务 #{item.task_id}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {item.worker || "Agent"}
                          {item.node_id ? ` · 节点 #${item.node_id}` : ""}
                        </span>
                        {item.inherited ? <Badge variant="outline">继承 · 只读</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.asset_ids.length ? item.asset_ids.map((id) => `#${id}`).join("、") : "未关联"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{time(item.created_at)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => open(item)}>
                        详情
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : data ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无符合条件的情报</EmptyTitle>
                <EmptyDescription>
                  {query || kind !== "all" || status !== "all"
                    ? "尝试调整分类或筛选条件。"
                    : data.enabled
                      ? "Agent 在后续执行中发现有价值的信息后，会在此显示。"
                      : "开启自动记录后，新增情报会在此显示；历史会话不会自动补提取。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </CardContent>
        <CardFooter className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">共 {data?.total ?? 0} 条 · 每页 25 条</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!data || (page + 1) * 25 >= data.total}
              onClick={() => setPage((n) => n + 1)}
            >
              下一页
            </Button>
          </div>
        </CardFooter>
      </Card>
      <Dialog
        open={!!selected}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.title ?? "情报详情"}</DialogTitle>
            <DialogDescription>保留实际来源；凭据与敏感数据仅在点击显示后加载。</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{KINDS.find((k) => k.value === selected.kind)?.label}</Badge>
                <Badge variant="outline">{selected.confidence === "observed" ? "直接观察" : "推测"}</Badge>
                <span className="text-xs text-muted-foreground">
                  任务 #{selected.task_id}
                  {selected.node_id ? ` · 来源节点 #${selected.node_id}` : ""} · {selected.worker || "Agent"}
                </span>
              </div>
              {scope === "tasks" && !selected.inherited ? (
                <Select value={selected.status} disabled={saving} onValueChange={(value) => void update(value)}>
                  <SelectTrigger aria-label="更新情报状态">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Object.entries(STATUS[selected.kind]).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {STATUS[selected.kind][selected.status]} · 请到来源任务修改状态
                </p>
              )}
              {selected.kind !== "lead" ? (
                <Button
                  variant="outline"
                  disabled={revealing}
                  onClick={() => {
                    if (detail) {
                      detailRequest.current++;
                      setDetail(null);
                    } else void reveal();
                  }}
                >
                  {detail ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
                  {revealing ? "读取中…" : detail ? "隐藏敏感内容" : "显示敏感内容"}
                </Button>
              ) : null}
              {detail ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">内容</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(detail.content);
                          toast.success("已复制");
                        } catch {
                          toast.error("复制失败，请手动选择内容复制");
                        }
                      }}
                    >
                      <CopyIcon data-icon="inline-start" />
                      复制
                    </Button>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                    {prettyContent(detail.content)}
                  </pre>
                  <p className="text-sm">来源证据</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                    {detail.evidence}
                  </pre>
                </>
              ) : (
                <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">敏感内容和来源证据已隐藏</p>
              )}
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>关联资产：{selected.asset_ids.map((id) => `#${id}`).join("、") || "未关联"}</span>
                <span>发现于 {time(selected.created_at)}</span>
              </div>
              <Link href={`/function/tasks/detail?id=${selected.task_id}&tab=sessions`} className="text-sm underline">
                查看来源任务会话
              </Link>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
