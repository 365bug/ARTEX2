"use client";

import { SendIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

import { buildRawResponse, getHostHeader, parseHeadersText, setHostHeader } from "./repeater-http";
import { newId, type RepeaterTab } from "./repeater-state";
import { useRepeaterStore } from "./repeater-store";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function RepeaterEditor({ tab }: { tab: RepeaterTab }) {
  const { method, url, headersText, body, useProxy, insecure, response, history } = tab;
  const updateTab = useRepeaterStore((state) => state.updateTab);
  const busy = useRepeaterStore((state) => state.inflight[tab.id] !== undefined);
  const setMethod = (method: string) => updateTab(tab.id, { method });
  const setURL = (url: string) => updateTab(tab.id, { url });
  const setHeadersText = (headersText: string) => updateTab(tab.id, { headersText });
  const setBody = (body: string) => updateTab(tab.id, { body });
  const setUseProxy = (useProxy: boolean) => updateTab(tab.id, { useProxy });
  const setInsecure = (insecure: boolean) => updateTab(tab.id, { insecure });
  async function send() {
    const store = useRepeaterStore.getState();
    if (store.inflight[tab.id] !== undefined) return;
    const target = url.trim();
    if (!target) {
      toast.error("请填写 URL");
      return;
    }
    const requestGeneration = store.beginSend(tab.id);
    if (requestGeneration === undefined) return;
    try {
      const result = await api.repeaterSend({
        method,
        url: target,
        headers: parseHeadersText(headersText),
        body,
        use_recording_proxy: useProxy,
        insecure_skip_verify: insecure,
      });
      store.completeSend(tab.id, requestGeneration, {
        id: newId(),
        method,
        url: target,
        headersText,
        body,
        useProxy,
        insecure,
        response: result,
        at: new Date().toISOString(),
      });
    } catch (error) {
      if (store.isCurrentSend(tab.id, requestGeneration)) toast.error((error as Error).message);
    } finally {
      store.clearInflight(tab.id, requestGeneration);
    }
  }

  return (
    <section aria-label="请求编辑器" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <FieldGroup className="flex-row flex-wrap items-end gap-2">
        <Field className="w-28">
          <FieldLabel htmlFor="repeater-method" className="mb-1 block text-muted-foreground text-xs">
            方法
          </FieldLabel>
          <Select value={method} onValueChange={setMethod} disabled={busy}>
            <SelectTrigger id="repeater-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[...new Set([...METHODS, method])].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="min-w-[240px] flex-1">
          <FieldLabel htmlFor="repeater-url" className="mb-1 block text-muted-foreground text-xs">
            URL
          </FieldLabel>
          <Input
            disabled={busy}
            id="repeater-url"
            value={url}
            onChange={(event) => setURL(event.target.value)}
            placeholder="https://target.example/path"
            spellCheck={false}
          />
        </Field>
        <Field className="min-w-[180px] flex-1">
          <FieldLabel htmlFor="repeater-host" className="mb-1 block text-muted-foreground text-xs">
            Host 请求头
          </FieldLabel>
          <Input
            id="repeater-host"
            disabled={busy}
            value={getHostHeader(headersText)}
            onChange={(event) => setHeadersText(setHostHeader(headersText, event.target.value))}
            placeholder="可选，留空使用 URL 主机"
            spellCheck={false}
          />
        </Field>
        <Button disabled={busy} onClick={() => void send()}>
          <SendIcon data-icon="inline-start" />
          {busy ? "发送中…" : "发送"}
        </Button>
      </FieldGroup>
      <FieldSet className="flex-row flex-wrap items-center gap-4 text-sm">
        <FieldLegend className="sr-only">发送选项</FieldLegend>
        <FieldLabel className="flex items-center gap-2" htmlFor="repeater-use-proxy">
          <Checkbox
            id="repeater-use-proxy"
            disabled={busy}
            checked={useProxy}
            onCheckedChange={(value) => setUseProxy(value === true)}
          />
          经流量代理
        </FieldLabel>
        <FieldLabel className="flex items-center gap-2" htmlFor="repeater-insecure">
          <Checkbox
            id="repeater-insecure"
            disabled={busy}
            checked={insecure}
            onCheckedChange={(value) => setInsecure(value === true)}
          />
          跳过 TLS 校验
        </FieldLabel>
        {response ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            {response.status ? <Badge variant="secondary">{response.status_text || response.status}</Badge> : null}
            <span>{response.elapsed_ms} ms</span>
            <span>{response.body_bytes.toLocaleString()} 字节</span>
            {response.body_truncated ? <Badge variant="outline">正文已截断</Badge> : null}
          </div>
        ) : null}
      </FieldSet>
      <div className="grid min-h-0 flex-1 auto-rows-max gap-3 overflow-y-auto xl:auto-rows-auto xl:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border p-2">
          <div className="font-medium text-muted-foreground text-xs">标签历史</div>
          <div className="flex max-h-40 min-h-0 flex-1 flex-col gap-1 overflow-y-auto xl:max-h-none">
            {history.length === 0 ? (
              <p className="text-muted-foreground text-xs">发送后会出现在这里</p>
            ) : (
              history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={busy}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    updateTab(tab.id, {
                      method: entry.method,
                      url: entry.url,
                      headersText: entry.headersText,
                      body: entry.body,
                      useProxy: entry.useProxy,
                      insecure: entry.insecure,
                      response: entry.response,
                    });
                  }}
                >
                  <div className="truncate font-mono text-xs">
                    {entry.method} {entry.response.status || "ERR"}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">{entry.url}</div>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex min-h-[300px] flex-col gap-2 overflow-hidden xl:min-h-0">
          <div className="font-medium text-xs">请求</div>
          <FieldGroup className="min-h-0 flex-1 gap-2">
            <Field className="min-h-0 flex-1 gap-1">
              <FieldLabel htmlFor="repeater-headers" className="text-muted-foreground text-xs">
                请求头
              </FieldLabel>
              <Textarea
                className="min-h-[120px] flex-1 font-mono text-xs"
                disabled={busy}
                id="repeater-headers"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder="Header: value"
                spellCheck={false}
              />
            </Field>
            <Field className="min-h-0 flex-1 gap-1">
              <FieldLabel htmlFor="repeater-body" className="text-muted-foreground text-xs">
                请求体
              </FieldLabel>
              <Textarea
                className="min-h-[120px] flex-1 font-mono text-xs"
                disabled={busy}
                id="repeater-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="请求正文（可选）"
                spellCheck={false}
              />
            </Field>
          </FieldGroup>
        </div>
        <div className="flex min-h-[300px] flex-col gap-2 overflow-hidden xl:min-h-0">
          <div className="font-medium text-xs">响应</div>
          {response?.error ? (
            <Alert variant={response.status ? "default" : "destructive"}>
              <AlertDescription className="break-all font-mono text-xs">{response.error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="min-h-[240px] flex-1 overflow-auto rounded-md border">
            {response ? (
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs">{buildRawResponse(response)}</pre>
            ) : (
              <p className="p-3 text-muted-foreground text-xs">发送后显示原始响应</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
