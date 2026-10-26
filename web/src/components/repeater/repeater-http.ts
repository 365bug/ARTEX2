import type { RepeaterSendResponse } from "@/lib/types";

export type RepeaterInitial = {
  method?: string;
  url?: string;
  headersText?: string;
  body?: string;
};

export function parseHeadersText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!name) continue;
    // The API accepts one value per name. Cookies use semicolon separators;
    // other duplicate headers preserve the common comma-separated semantics.
    const existingName = Object.keys(result).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!existingName) {
      result[name] = value;
    } else {
      const separator = existingName.toLowerCase() === "cookie" ? "; " : ", ";
      result[existingName] = `${result[existingName]}${separator}${value}`;
    }
  }
  return result;
}

export function formatHeaders(headers: Record<string, string[]> | Record<string, string>): string {
  return Object.entries(headers)
    .flatMap(([name, value]) =>
      Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`],
    )
    .join("\n");
}

export function buildRawResponse(response: RepeaterSendResponse): string {
  if (!response.status) return "";
  const statusLine = `${response.proto || "HTTP/1.1"} ${response.status_text || response.status}`.trim();
  const headers = formatHeaders(response.headers);
  return `${statusLine}\n${headers}\n\n${response.body}`;
}

export function headersFromReqHead(reqHead?: string): string {
  if (!reqHead) return "";
  const lines = reqHead.replace(/\r\n?/g, "\n").split("\n");
  // Evidence heads normally start with `METHOD path HTTP/x.y`, but tolerate
  // leading blank lines and CR-only captures from older traffic records.
  let requestLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate) continue;
    if (/^(?:[A-Z]+)\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(candidate)) requestLine = index;
    break;
  }
  const start = requestLine >= 0 ? requestLine + 1 : 0;
  return lines.slice(start).join("\n").replace(/\n+$/, "");
}

export function getHostHeader(headersText: string): string {
  const headers = parseHeadersText(headersText);
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "host");
  return name ? headers[name] : "";
}

export function setHostHeader(headersText: string, host: string): string {
  const lines = headersText.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => /^\s*host\s*:/i.test(line));
  const value = host.replace(/[\r\n]/g, "").trim();
  const result = lines.flatMap((line, index) => {
    if (!/^\s*host\s*:/i.test(line)) return [line];
    return index === first && value ? [`Host: ${value}`] : [];
  });
  if (first < 0 && value) result.unshift(`Host: ${value}`);
  return result.join("\n");
}

// Split only the HTTP separator; preserve all body bytes represented by the text.
export function splitRequestText(text: string): { headersText: string; body: string } {
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) return { headersText: text, body: "" };
  return { headersText: text.slice(0, separator.index), body: text.slice(separator.index + separator[0].length) };
}

export function joinRequestText(headersText: string, body: string): string {
  if (!headersText && !body) return "";
  return `${headersText.replace(/(?:\r?\n)+$/, "")}\n\n${body}`;
}

export function requestFromTraffic(
  raw: string,
  exchange: { method: string; url: string; host: string },
): RepeaterInitial {
  const firstLine = /^[^\r\n]+(?:\r?\n|$)/.exec(raw);
  if (!firstLine || !/^[A-Z]+\s+\S+\s+HTTP\/\d(?:\.\d)?\r?\n?$/i.test(firstLine[0])) {
    throw new Error("请求报文不完整，无法送入请求重发");
  }
  const request = splitRequestText(raw.slice(firstLine[0].length));
  if (/…\[truncated\] @blob sha256:[a-f0-9]{64}/.test(request.body)) {
    throw new Error("请求正文为截断预览，请下载完整正文后再导入");
  }
  let host = exchange.host;
  try {
    host = new URL(exchange.url).host || host;
  } catch {
    /* Legacy URL uses the indexed host. */
  }
  return {
    method: exchange.method,
    url: exchange.url,
    headersText: getHostHeader(request.headersText) ? request.headersText : setHostHeader(request.headersText, host),
    body: request.body,
  };
}
