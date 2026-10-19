"use client";

import * as React from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const MAX_REMARK_CHARS = 2000;

export function RemarkEditor({
  value = "",
  label,
  onSave,
}: {
  value?: string;
  label: string;
  onSave: (remark: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const cancelOnBlurRef = React.useRef(false);
  const savingRef = React.useRef(false);
  const errorID = React.useId();

  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  async function finishEditing() {
    if (savingRef.current) return;
    if (cancelOnBlurRef.current) {
      cancelOnBlurRef.current = false;
      setDraft(value);
      setError("");
      setEditing(false);
      return;
    }
    const next = draft.trim();
    if (next === value.trim()) {
      setEditing(false);
      return;
    }
    if (Array.from(next).length > MAX_REMARK_CHARS) {
      setError(`备注最多 ${MAX_REMARK_CHARS} 个字符`);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
      toast.success("备注已保存");
      setEditing(false);
    } catch (cause) {
      setError(`备注保存失败：${(cause as Error).message}`);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex w-32 min-w-28 flex-col gap-1 sm:w-48">
        <Textarea
          ref={inputRef}
          value={draft}
          rows={1}
          autoFocus
          disabled={saving}
          aria-busy={saving}
          aria-label={`${label}备注`}
          aria-invalid={error.length > 0}
          aria-describedby={error ? errorID : undefined}
          className="max-h-40 min-h-7 resize-none px-2 py-1 [overflow-wrap:anywhere]"
          title="Enter 保存，Shift+Enter 换行，Esc 取消；留空可清除备注"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onBlur={() => void finishEditing()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelOnBlurRef.current = true;
              event.currentTarget.blur();
            }
          }}
        />
        {error ? (
          <p id={errorID} role="alert" className="whitespace-normal text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-7 w-32 justify-start p-0 sm:w-48"
      aria-label={`编辑${label}的备注`}
      title={value.length > 0 ? value : "点击编辑备注"}
      onClick={() => {
        setDraft(value);
        setError("");
        setEditing(true);
      }}
    >
      {value.length > 0 ? (
        <span className="truncate">{value}</span>
      ) : (
        <span className="text-muted-foreground">添加备注</span>
      )}
    </Button>
  );
}
