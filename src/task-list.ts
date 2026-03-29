/**
 * Notion DB の query 結果から LINE 向けタスク一覧テキストを組み立てる
 */

const LINE_TEXT_MAX = 4500;

/** グループで「@ボット名 タスク一覧」のように送られる前提で先頭の @〜 を除く */
export function normalizeLineUserText(text: string): string {
  return text
    .replace(/^@\S+\s*/u, "")
    .replace(/^\u200b+/, "")
    .trim();
}

/** トリガー文字列（カンマ区切り）に一致するか */
export function wantsTaskList(userText: string, triggersCsv: string): boolean {
  const t = normalizeLineUserText(userText);
  if (!t) return false;
  const triggers = triggersCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const phrase of triggers) {
    if (phrase && t.includes(phrase)) return true;
  }
  return /タスク一覧|task\s*list|todo\s*list|今のタスク|やること一覧/u.test(t);
}

function plainFromRich(
  blocks: Array<{ plain_text?: string }> | undefined
): string {
  if (!blocks?.length) return "";
  return blocks.map((b) => b.plain_text ?? "").join("");
}

function formatProp(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const p = prop as {
    type?: string;
    title?: Array<{ plain_text?: string }>;
    rich_text?: Array<{ plain_text?: string }>;
    select?: { name?: string } | null;
    status?: { name?: string } | null;
    multi_select?: Array<{ name?: string }>;
    date?: { start?: string; end?: string } | null;
    checkbox?: boolean;
    number?: number | null;
    url?: string | null;
  };
  switch (p.type) {
    case "title":
      return plainFromRich(p.title) || null;
    case "rich_text":
      return plainFromRich(p.rich_text) || null;
    case "select":
      return p.select?.name ?? null;
    case "status":
      return p.status?.name ?? null;
    case "multi_select":
      return p.multi_select?.map((m) => m.name).join(", ") || null;
    case "date":
      if (!p.date?.start) return null;
      return p.date.end
        ? `${p.date.start} 〜 ${p.date.end}`
        : p.date.start;
    case "checkbox":
      return p.checkbox ? "はい" : "いいえ";
    case "number":
      return p.number != null ? String(p.number) : null;
    case "url":
      return p.url ?? null;
    default:
      return null;
  }
}

function getTitle(properties: Record<string, unknown>): string {
  for (const prop of Object.values(properties)) {
    const p = prop as { type?: string; title?: Array<{ plain_text?: string }> };
    if (p.type === "title") {
      const s = plainFromRich(p.title);
      return s.trim() || "(無題)";
    }
  }
  return "(無題)";
}

/** タイトル以外から、表示に使う短いサマリ（最大 maxExtra プロパティ） */
function summarizeExtras(
  properties: Record<string, unknown>,
  maxExtra: number
): string {
  const parts: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (parts.length >= maxExtra) break;
    const p = prop as { type?: string };
    if (p.type === "title") continue;
    const v = formatProp(prop);
    if (v) parts.push(`${name}: ${v}`);
  }
  return parts.join(" / ");
}

export type NotionQueryBody = {
  results?: Array<{
    properties?: Record<string, unknown>;
  }>;
};

/**
 * query レスポンスから LINE 用テキストチャンクの配列（長さ制限で分割）
 */
export function buildTaskListMessages(body: unknown): string[] {
  const data = body as NotionQueryBody;
  const results = data.results ?? [];
  const n = results.length;

  if (n === 0) {
    return ["📋 タスクはまだありません（または取得できませんでした）。"];
  }

  const lines: string[] = [];
  lines.push(`📋 タスク一覧（${n}件）`);
  lines.push("");

  results.forEach((page, i) => {
    const props = page.properties ?? {};
    const title = getTitle(props);
    const extra = summarizeExtras(props, 4);
    lines.push(`${i + 1}. ${title}`);
    if (extra) {
      lines.push(`   ${extra}`);
    }
    lines.push("");
  });

  const full = lines.join("\n").trimEnd();
  return chunkText(full, LINE_TEXT_MAX);
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let offset = 0;
  const totalParts = Math.ceil(text.length / maxLen);
  let part = 1;
  while (offset < text.length) {
    const header = `（${part}/${totalParts}）\n`;
    const budget = maxLen - header.length;
    chunks.push(header + text.slice(offset, offset + budget));
    offset += budget;
    part += 1;
  }
  return chunks;
}
