"use client";

import * as React from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { auth } from "@/lib/auth";

function AuthenticatedImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [objectURL, setObjectURL] = React.useState<string | null>(null);
  const [captureTimestamp, setCaptureTimestamp] = React.useState<string | null>(null);
  const imageSrc = typeof src === "string" ? src : undefined;

  React.useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    if (!imageSrc || !imageSrc.startsWith("/api/workspace/preview")) {
      setObjectURL(null);
      setCaptureTimestamp(null);
      return () => {
        cancelled = true;
      };
    }

    const token = auth.getToken();
    setCaptureTimestamp(null);
    fetch(imageSrc, {
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
        setCaptureTimestamp(response.headers.get("X-Report-Screenshot-Timestamp"));
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectURL(url);
      })
      .catch(() => {
        if (!cancelled) setObjectURL(null);
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageSrc]);

  return (
    <span className="relative my-2 inline-block max-w-full">
      <img {...props} src={objectURL ?? imageSrc} alt={alt || "报告截图"} />
      {captureTimestamp && (
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-white shadow">
          {captureTimestamp}
        </span>
      )}
    </span>
  );
}

// Tailwind-styled element overrides (no typography plugin in this project, so we
// style each element). `node` is stripped — it's not a valid DOM attribute.
const components: Components = {
  h1: ({ node, ...p }) => <div className="mt-2.5 text-base font-semibold" {...p} />,
  h2: ({ node, ...p }) => <div className="mt-2 text-sm font-semibold" {...p} />,
  h3: ({ node, ...p }) => <div className="mt-1.5 text-sm font-medium text-foreground/90" {...p} />,
  h4: ({ node, ...p }) => <div className="mt-1.5 text-sm font-medium text-foreground/90" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...p} />,
  ol: ({ node, ...p }) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold" {...p} />,
  a: ({ node, ...p }) => (
    <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />
  ),
  img: ({ node, src, alt, ...p }) => {
    const resolvedSrc =
      typeof src === "string" && src.startsWith("workspace://")
        ? `/api/workspace/preview?path=${encodeURIComponent(src.slice("workspace://".length))}`
        : typeof src === "string" && src.startsWith("findings/screenshots/")
          ? `/api/workspace/preview?path=${encodeURIComponent(src)}`
        : src;
    return (
      <AuthenticatedImage
        {...p}
        className="my-2 max-h-[520px] max-w-full rounded-md border object-contain"
        src={resolvedSrc}
        alt={alt || "报告截图"}
        // Report screenshots are evidence and must be fetched while the report is
        // rendered; Edge may replace lazy images with placeholders indefinitely
        // when the markdown section is outside the initial viewport.
        loading="eager"
        decoding="async"
      />
    );
  },
  hr: () => <hr className="my-2 border-border" />,
  blockquote: ({ node, ...p }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2.5 text-muted-foreground" {...p} />
  ),
  pre: ({ node, ...p }) => (
    <pre className="my-1.5 overflow-auto rounded-md bg-muted/70 p-2.5 text-xs leading-relaxed" {...p} />
  ),
  code: ({ node, className, children, ...rest }) => {
    const block = /language-/.test(className || "");
    return block ? (
      <code className={"font-mono text-xs " + (className || "")} {...rest}>
        {children}
      </code>
    ) : (
      <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
        {children}
      </code>
    );
  },
  table: ({ node, ...p }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...p} />
    </div>
  ),
  th: ({ node, ...p }) => <th className="border border-border bg-muted/60 px-2 py-1 text-left font-medium" {...p} />,
  td: ({ node, ...p }) => <td className="border border-border px-2 py-1 align-top" {...p} />,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-1.5 text-sm [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) =>
          url.startsWith("workspace://") || url.startsWith("findings/screenshots/") ? url : defaultUrlTransform(url)
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
