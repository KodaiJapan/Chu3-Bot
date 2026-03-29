import {
  HTTPError,
  middleware,
  messagingApi,
  type MiddlewareConfig,
  type WebhookEvent,
  type TextMessage,
  type MessageAPIResponseBase,
} from "@line/bot-sdk";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { load } from "ts-dotenv";
import {
  buildTaskListMessages,
  normalizeLineUserText,
  wantsTaskList,
} from "./task-list.js";

// 環境変数をロード
const env = load({
  CHANNEL_ACCESS_TOKEN: String,
  CHANNEL_SECRET: String,
  NOTION_API_KEY: String,
  /** Notion Webhook 検証後に保存する token（署名検証に使う） */
  NOTION_VERIFICATION_TOKEN: { type: String, optional: true },
  /** プッシュ通知先の LINE グループ ID（ボットをグループに入れたうえで取得） */
  LINE_GROUP_ID: { type: String, optional: true },
  /** 監視する DB（省略時は下の定数） */
  NOTION_DATABASE_ID: { type: String, optional: true },
  /**
   * true: DB が一致するか見ない（同一ワークスペースのイベントなら通知）
   * false: 監視中 NOTION_DATABASE_ID のみ。デフォルト true で「届かない」を防ぐ
   */
  NOTION_RELAX_DATABASE_FILTER: { type: Boolean, default: true },
  /** 設定時のみ POST /api/test-push でグループプッシュを試せる（Bearer と同じ値） */
  PUSH_TEST_SECRET: { type: String, optional: true },
  /**
   * true のとき Notion の署名検証をスキップ（署名不一致で 401 になる場合の切り分け用。本番では false）
   */
  NOTION_SKIP_SIGNATURE_VERIFY: { type: Boolean, optional: true },
  /** GET /api/cron/poll-notion の認証（未設定なら PUSH_TEST_SECRET を流用） */
  CRON_SECRET: { type: String, optional: true },
  /** タスク一覧を出すときのキーワード（カンマ区切り） */
  TASK_LIST_TRIGGERS: {
    type: String,
    default: "タスク一覧,タスク,一覧,リスト",
  },
  PORT: { type: Number, optional: true },
});

// ポートを設定（Vercel では .env が無く PORT 省略可）
const PORT = env.PORT ?? 3000;

// チャネルアクセストークンとチャネルシークレットのconfigインスタンスを作成
const config = {
  channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: env.CHANNEL_SECRET || "",
};
// ミドルウェアのconfigとして設定
const middlewareConfig: MiddlewareConfig = config;

// LINE Messaging APIクライアントを作成。これが応答役になる。
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
});

// Expressアプリケーションを作成
const app: Application = express();



// Notion のデータベース ID（URL の 32 文字の部分。ハイフン無しでも可なことが多い）
const databaseId = env.NOTION_DATABASE_ID ?? "3326d8a500c880e1b81ff3e186aef576";

/** この DB に関係するイベントか（ペイロードに DB ID が含まれるか） */
function isEventForTargetDatabase(body: unknown, targetId: string): boolean {
  const normalized = targetId.replace(/-/g, "");
  const s = JSON.stringify(body);
  return s.includes(normalized) || s.includes(targetId);
}

const normalizedDatabaseId = databaseId.replace(/-/g, "");

/** ページが監視対象 DB に属するか（Webhook に DB ID が無いケース用） */
async function pageBelongsToTargetDatabase(pageId: string): Promise<boolean> {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!r.ok) {
    console.error("[notion-webhook] retrieve page failed", r.status, await r.text());
    return false;
  }
  const page = (await r.json()) as {
    parent?: { type?: string; database_id?: string };
  };
  if (page.parent?.type !== "database_id" || !page.parent.database_id) {
    return false;
  }
  return (
    page.parent.database_id.replace(/-/g, "") === normalizedDatabaseId
  );
}

/** ペイロードまたはページ取得で、監視対象 DB の変更か判定 */
async function eventConcernsTargetDatabase(body: unknown): Promise<boolean> {
  if (isEventForTargetDatabase(body, databaseId)) return true;
  const obj = body as {
    entity?: { id?: string; type?: string };
    data?: { entity?: { id?: string; type?: string } };
  };
  const entity = obj.entity ?? obj.data?.entity;
  if (entity?.type === "database" && entity.id) {
    return entity.id.replace(/-/g, "") === normalizedDatabaseId;
  }
  if (entity?.type === "page" && entity.id) {
    return pageBelongsToTargetDatabase(entity.id);
  }
  /** API 2025-09-03: entity が data_source。ペイロードに DB ID が無い場合は文字列マッチに頼る */
  if (entity?.type === "data_source" && entity.id) {
    return isEventForTargetDatabase(body, databaseId);
  }
  return false;
}

/**
 * Notion Webhook の X-Notion-Signature を検証。
 * 公式サンプルは JSON.parse 後の JSON.stringify と raw の両方があり得るため両方試す。
 */
function verifyNotionSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const receivedHex = signatureHeader.slice("sha256=".length);

  const payloads: string[] = [rawBody];
  try {
    payloads.push(JSON.stringify(JSON.parse(rawBody)));
  } catch {
    /* raw のみ */
  }

  for (const payload of payloads) {
    const expectedHex = createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest("hex");
    if (expectedHex.length !== receivedHex.length) continue;
    try {
      if (
        timingSafeEqual(
          Buffer.from(expectedHex, "hex"),
          Buffer.from(receivedHex, "hex")
        )
      ) {
        return true;
      }
    } catch {
      /* 長さ不一致など */
    }
  }
  return false;
}

const NOTIFY_EVENT_TYPES = new Set([
  "database.content_updated",
  "database.schema_updated",
  "database.created",
  "database.deleted",
  "database.moved",
  "database.undeleted",
  "data_source.content_updated",
  "data_source.schema_updated",
  "data_source.created",
  "data_source.deleted",
  "data_source.moved",
  "data_source.undeleted",
  "page.properties_updated",
  "page.content_updated",
  "page.created",
  "page.deleted",
  "page.moved",
  "page.undeleted",
  "page.locked",
  "page.unlocked",
]);

/** DB 行のプロパティ変更などは page.* / 新APIは data_source.* が来る。将来追加にも対応 */
function isNotifiableNotionEventType(eventType: string): boolean {
  if (!eventType) return false;
  if (NOTIFY_EVENT_TYPES.has(eventType)) return true;
  return /^(page|database|data_source)\./u.test(eventType);
}

/** Notion Database Query のレスポンス JSON を取得する */
async function queryNotionDatabase(): Promise<unknown> {
  const r = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );
  const body: unknown = await r.json();
  if (!r.ok) {
    throw new Error(
      `Notion API ${r.status}: ${JSON.stringify(body)}`
    );
  }
  return body;
}

/** LINE 用: 直近の行だけ取得（更新順） */
async function queryNotionTaskListForLine(): Promise<unknown> {
  const r = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 30,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      }),
    }
  );
  const body: unknown = await r.json();
  if (!r.ok) {
    throw new Error(
      `Notion API ${r.status}: ${JSON.stringify(body)}`
    );
  }
  return body;
}

/** Webhook が届かないとき用: DB 全行の id + last_edited_time をハッシュして変化を検知 */
const NOTION_POLL_STATE_FILE = "/tmp/jukubot-notion-poll.json";

async function queryDatabaseFingerprint(): Promise<string> {
  const rows: { id: string; last_edited_time: string }[] = [];
  let cursor: string | undefined;
  const maxPages = 25;
  for (let p = 0; p < maxPages; p++) {
    const r = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      }
    );
    const body = (await r.json()) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    if (!r.ok) {
      throw new Error(`Notion query ${r.status}: ${JSON.stringify(body)}`);
    }
    for (const page of body.results ?? []) {
      const o = page as { id?: string; last_edited_time?: string };
      if (o.id && o.last_edited_time) {
        rows.push({ id: o.id, last_edited_time: o.last_edited_time });
      }
    }
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor ?? undefined;
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// ルートを設定
app.get("/", async (_: Request, res: Response): Promise<Response> => {
  return res.status(200).send({
    message: "success",
  });
});

/**
 * LINE グループへのプッシュが単体で動くか確認（Notion 不要）
 * curl -X POST https://(host)/api/test-push -H "Authorization: Bearer $PUSH_TEST_SECRET"
 */
app.post(
  "/api/test-push",
  async (req: Request, res: Response): Promise<Response> => {
    const secret = env.PUSH_TEST_SECRET;
    if (!secret) {
      return res.status(404).send("Not found");
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).send("Unauthorized");
    }
    const gid = env.LINE_GROUP_ID?.trim();
    if (!gid) {
      return res.status(500).json({ error: "LINE_GROUP_ID is not set" });
    }
    try {
      await client.pushMessage({
        to: gid,
        messages: [
          {
            type: "text",
            text: "テスト: グループへのプッシュは成功しています（Notion とは無関係）",
          },
        ],
      });
      return res.status(200).json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof HTTPError) {
        return res.status(500).json({
          error: "LINE push failed",
          statusCode: e.statusCode,
          body: e.originalError,
        });
      }
      throw e;
    }
  }
);

/** ブラウザで開いて「URL が Vercel に届くか」確認用。Notion への登録は POST のこの URL */
app.get("/notion-webhook", (_req: Request, res: Response): void => {
  res.status(200).json({
    ok: true,
    message:
      "この URL は生きています。Notion Integration の Webhook には「POST 先」として同じパスを登録してください（GET は検証用のみ）。",
  });
});

/** 設定状況（秘密は出さない）と Notion に貼るべき URL */
app.get("/api/diag", (req: Request, res: Response): void => {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers.host || "";
  const notionWebhookUrl = host ? `${proto}://${host}/notion-webhook` : "";
  res.status(200).json({
    ok: true,
    notionWebhookPostUrl: notionWebhookUrl,
    hasLineGroupId: Boolean(env.LINE_GROUP_ID?.trim()),
    hasNotionApiKey: Boolean(env.NOTION_API_KEY),
    hasNotionVerificationToken: Boolean(env.NOTION_VERIFICATION_TOKEN),
    notionRelaxDatabaseFilter: env.NOTION_RELAX_DATABASE_FILTER,
    checkNotionIntegration: [
      "developers.notion.com の Integration → Webhooks で上記 URL を登録",
      "対象データベースを Integration に Connect",
      "購読イベントに page.properties_updated と data_source.content_updated を含める",
    ],
    fallbackPolling:
      "Webhook が難しい場合は GET /api/cron/poll-notion（CRON_SECRET または PUSH_TEST_SECRET）で定期ポーリング",
    lineWebhookPostUrl: host ? `${proto}://${host}/webhook` : "",
    taskListTriggers: env.TASK_LIST_TRIGGERS,
    taskListHint:
      "LINE で「タスク一覧」「タスク」「一覧」「リスト」のいずれかを含めて送信。グループは @メンション付きでも可。",
  });
});

/**
 * Webhook なしで Notion DB の変化を検知（Vercel Cron または手動 curl）
 * 初回実行はベースライン保存のみで LINE は送らない。2 回目以降で差分があれば通知。
 */
app.get(
  "/api/cron/poll-notion",
  async (req: Request, res: Response): Promise<Response> => {
    const secret = env.CRON_SECRET || env.PUSH_TEST_SECRET;
    if (!secret) {
      return res.status(503).json({
        error:
          "CRON_SECRET または PUSH_TEST_SECRET を Vercel に設定してください",
      });
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).send("Unauthorized");
    }
    const gid = env.LINE_GROUP_ID?.trim();
    if (!gid) {
      return res.status(500).json({ error: "LINE_GROUP_ID is not set" });
    }

    let fp: string;
    try {
      fp = await queryDatabaseFingerprint();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ error: msg });
    }

    let previous: string | undefined;
    try {
      const raw = await readFile(NOTION_POLL_STATE_FILE, "utf8");
      previous = (JSON.parse(raw) as { fingerprint?: string }).fingerprint;
    } catch {
      /* 初回 */
    }

    if (previous === undefined) {
      await writeFile(
        NOTION_POLL_STATE_FILE,
        JSON.stringify({ fingerprint: fp }),
        "utf8"
      );
      return res.status(200).json({
        ok: true,
        baseline: true,
        message:
          "初回: 状態を保存しました。次の実行から変更時に LINE 通知します。",
      });
    }

    if (fp === previous) {
      return res.status(200).json({ ok: true, changed: false });
    }

    await writeFile(
      NOTION_POLL_STATE_FILE,
      JSON.stringify({ fingerprint: fp }),
      "utf8"
    );

    try {
      await client.pushMessage({
        to: gid,
        messages: [
          {
            type: "text",
            text: "Notion: データベースに変更が検出されました（定期チェック）",
          },
        ],
      });
    } catch (e: unknown) {
      if (e instanceof HTTPError) {
        return res.status(500).json({
          error: "LINE push failed",
          statusCode: e.statusCode,
          body: e.originalError,
        });
      }
      throw e;
    }

    return res.status(200).json({ ok: true, changed: true, notified: true });
  }
);

// Notion から DB 一覧ページを取得（ブラウザや curl で確認用）
app.get("/notion-db", async (_: Request, res: Response): Promise<Response> => {
  try {
    const body = await queryNotionDatabase();
    return res.status(200).json(body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).send(msg);
  }
});

/**
 * Notion → この URL を Integration の Webhook に登録（HTTPS・公開 URL 必須）
 * 初回は body に verification_token のみ → Notion 画面に貼り付けて検証後、同じ token を NOTION_VERIFICATION_TOKEN に保存推奨
 */
app.post(
  "/notion-webhook",
  (req: Request, _res: Response, next: NextFunction) => {
    console.error(
      "[notion-webhook] POST hit content-type:",
      req.headers["content-type"] ?? "(none)"
    );
    next();
  },
  // charset 付き application/json 等でも必ず raw を取る（空ボディで署名失敗するのを防ぐ）
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req: Request, res: Response): Promise<Response> => {
    const rawBody =
      Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
    if (!rawBody.trim()) {
      console.error(
        "[notion-webhook] empty body — Content-Type またはプロキシ設定を確認してください"
      );
      return res.status(400).send("empty body");
    }
    const sigRaw = req.headers["x-notion-signature"];
    const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;

    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return res.status(400).send("invalid json");
    }

    const obj = parsed as Record<string, unknown>;
    // 購読作成時のワンタイム検証（イベントには type がある）
    if (typeof obj.verification_token === "string" && !("type" in obj)) {
      console.warn(
        "[notion-webhook] verification_token を受信しました。Notion の Webhook 画面で Verify に貼り付け、同じ値を NOTION_VERIFICATION_TOKEN に設定してください。"
      );
      return res.status(200).json({ ok: true });
    }

    const secret = env.NOTION_VERIFICATION_TOKEN;
    if (secret && !env.NOTION_SKIP_SIGNATURE_VERIFY) {
      if (!verifyNotionSignature(rawBody, sig, secret)) {
        console.error(
          "[notion-webhook] signature mismatch — token 不一致の可能性。切り分け: NOTION_SKIP_SIGNATURE_VERIFY=true または token を再取得"
        );
        return res.status(401).send("invalid signature");
      }
    } else {
      if (env.NOTION_SKIP_SIGNATURE_VERIFY) {
        console.warn(
          "[notion-webhook] NOTION_SKIP_SIGNATURE_VERIFY により署名検証をスキップしています"
        );
      } else if (!secret) {
        console.warn(
          "[notion-webhook] NOTION_VERIFICATION_TOKEN 未設定のため署名検証をスキップしています（本番では必ず設定してください）"
        );
      }
    }

    const eventType = typeof obj.type === "string" ? obj.type : "";
    console.error("[notion-webhook] incoming type:", eventType || "(empty)");
    if (!eventType || !isNotifiableNotionEventType(eventType)) {
      console.error(
        "[notion-webhook] ignored (unknown type):",
        eventType || "(empty)"
      );
      return res.status(200).send("ignored");
    }
    if (!env.NOTION_RELAX_DATABASE_FILTER) {
      const okDb = await eventConcernsTargetDatabase(parsed);
      if (!okDb) {
        console.error(
          "[notion-webhook] not target db (payload に DB ID が無い場合はページ取得で照合済み)。NOTION_RELAX_DATABASE_FILTER=true で緩和可"
        );
        return res.status(200).send("not target db");
      }
    }

    const groupId = env.LINE_GROUP_ID?.trim();
    if (!groupId) {
      console.warn(
        "[notion-webhook] LINE_GROUP_ID 未設定のため LINE 通知をスキップ"
      );
      return res.status(200).send("no LINE_GROUP_ID");
    }

    const text = `Notion: データベースに変更がありました\n種類: ${eventType || "不明"}`;
    const msg: TextMessage = { type: "text", text };
    try {
      await client.pushMessage({
        to: groupId,
        messages: [msg],
      });
    } catch (e: unknown) {
      if (e instanceof HTTPError) {
        console.error(
          "[notion-webhook] LINE push failed",
          e.statusCode,
          e.statusMessage,
          e.originalError
        );
      } else {
        console.error("[notion-webhook] LINE push failed", e);
      }
      return res.status(500).send("line push failed");
    }
    return res.status(200).send("ok");
  }
);


// テキストメッセージを処理するハンドラー（関数）　
//下で使う用。
const textEventHandler = async (
  event: WebhookEvent
): Promise<MessageAPIResponseBase | undefined> => {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const { replyToken } = event;

  const rawText = event.message.text;
  const text = normalizeLineUserText(rawText);
  const taskIntent = wantsTaskList(text, env.TASK_LIST_TRIGGERS);
  console.error("[line] text:", JSON.stringify(text), "taskIntent:", taskIntent);

  if (taskIntent) {
    try {
      const body = await queryNotionTaskListForLine();
      const chunks = buildTaskListMessages(body);
      const slice = chunks.slice(0, 5);
      const messages: TextMessage[] = slice.map((t) => ({
        type: "text",
        text: t,
      }));
      if (chunks.length > 5) {
        messages.push({
          type: "text",
          text:
            "...他 " +
            String(chunks.length - 5) +
            " 件分は長いため省略しました。Notion で全件を確認してください。",
        });
      }
      await client.replyMessage({ replyToken, messages });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `タスク一覧の取得に失敗しました。\n${msg.slice(0, 500)}`,
          },
        ],
      });
    }
    return;
  }

  const resText = (() => {
    switch (Math.floor(Math.random() * 3)) {
      case 0:
        return text.split("").reverse().join("");
      case 1:
        return text.split("").join(" ");
      default:
        return text.split("").reverse().join(" ");
    }
  })();
  console.log(resText);

  const response: TextMessage = {
    type: "text",
    text: resText,
  };
  await client.replyMessage({
    replyToken: replyToken,
    messages: [response],
  });
};

// webhookエンドポイントにpostリクエストが来たら、
app.post(
  "/webhook",
  middleware(middlewareConfig),
  async (req: Request, res: Response): Promise<Response> => {
    const events: WebhookEvent[] = req.body.events;
    await Promise.all(
      events.map(async (event: WebhookEvent) => {
        if (event.source.type === "group") {
          console.log("LINE groupId:", event.source.groupId);
        }
        try {
          await textEventHandler(event);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error(err);
          }
          return res.status(500);
        }
      })
    );
    return res.status(200);
  }
);

// ローカルのみ HTTP サーバー起動（Vercel は serverless で export を使う）
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}/`);
  });
}

export default app;