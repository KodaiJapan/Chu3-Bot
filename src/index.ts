import {
  middleware,
  messagingApi,
  type MiddlewareConfig,
  type WebhookEvent,
  type TextMessage,
  type MessageAPIResponseBase,
} from "@line/bot-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Application, type Request, type Response } from "express";
import { load } from "ts-dotenv";

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

/** Notion Webhook の X-Notion-Signature を検証（生ボディ文字列で HMAC） */
function verifyNotionSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  const receivedHex = signatureHeader.slice("sha256=".length);
  if (expectedHex.length !== receivedHex.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expectedHex, "hex"),
      Buffer.from(receivedHex, "hex")
    );
  } catch {
    return false;
  }
}

const NOTIFY_EVENT_TYPES = new Set([
  "database.content_updated",
  "database.schema_updated",
  "page.properties_updated",
  "page.content_updated",
  "page.created",
  "page.deleted",
]);

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

// ルートを設定
app.get("/", async (_: Request, res: Response): Promise<Response> => {
  return res.status(200).send({
    message: "success",
  });
});

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
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response): Promise<Response> => {
    const rawBody =
      Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
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
    if (secret) {
      if (!verifyNotionSignature(rawBody, sig, secret)) {
        console.error("[notion-webhook] signature mismatch");
        return res.status(401).send("invalid signature");
      }
    } else {
      console.warn(
        "[notion-webhook] NOTION_VERIFICATION_TOKEN 未設定のため署名検証をスキップしています（本番では必ず設定してください）"
      );
    }

    const eventType = typeof obj.type === "string" ? obj.type : "";
    if (!eventType || !NOTIFY_EVENT_TYPES.has(eventType)) {
      return res.status(200).send("ignored");
    }
    if (!isEventForTargetDatabase(parsed, databaseId)) {
      return res.status(200).send("not target db");
    }

    const groupId = env.LINE_GROUP_ID;
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
      console.error("[notion-webhook] LINE push failed", e);
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

  const { text } = event.message;

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