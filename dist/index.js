import { HTTPError, middleware, messagingApi, } from "@line/bot-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import express, {} from "express";
import { load } from "ts-dotenv";
import { buildTaskListMessages, normalizeLineUserText, wantsTaskList, } from "./task-list.js";
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
    /**
     * true のとき Notion の署名検証をスキップ（署名不一致で 401 になる場合の切り分け用。本番では false）
     */
    NOTION_SKIP_SIGNATURE_VERIFY: { type: Boolean, optional: true },
    /** 管理用エンドポイントの認証 */
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
const middlewareConfig = config;
// LINE Messaging APIクライアントを作成。これが応答役になる。
const client = new messagingApi.MessagingApiClient({
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
});
// Expressアプリケーションを作成
const app = express();
// Notion のデータベース ID（URL の 32 文字の部分。ハイフン無しでも可なことが多い）
const databaseId = env.NOTION_DATABASE_ID ?? "3326d8a500c880e1b81ff3e186aef576";
/** この DB に関係するイベントか（ペイロードに DB ID が含まれるか） */
function isEventForTargetDatabase(body, targetId) {
    const normalized = targetId.replace(/-/g, "");
    const s = JSON.stringify(body);
    return s.includes(normalized) || s.includes(targetId);
}
const normalizedDatabaseId = databaseId.replace(/-/g, "");
/** ページが監視対象 DB に属するか（Webhook に DB ID が無いケース用） */
async function pageBelongsToTargetDatabase(pageId) {
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
    const page = (await r.json());
    if (page.parent?.type !== "database_id" || !page.parent.database_id) {
        return false;
    }
    return (page.parent.database_id.replace(/-/g, "") === normalizedDatabaseId);
}
/** ペイロードまたはページ取得で、監視対象 DB の変更か判定 */
async function eventConcernsTargetDatabase(body) {
    if (isEventForTargetDatabase(body, databaseId))
        return true;
    const obj = body;
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
function verifyNotionSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader?.startsWith("sha256="))
        return false;
    const receivedHex = signatureHeader.slice("sha256=".length);
    const payloads = [rawBody];
    try {
        payloads.push(JSON.stringify(JSON.parse(rawBody)));
    }
    catch {
        /* raw のみ */
    }
    for (const payload of payloads) {
        const expectedHex = createHmac("sha256", secret)
            .update(payload, "utf8")
            .digest("hex");
        if (expectedHex.length !== receivedHex.length)
            continue;
        try {
            if (timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(receivedHex, "hex"))) {
                return true;
            }
        }
        catch {
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
function isNotifiableNotionEventType(eventType) {
    if (!eventType)
        return false;
    if (NOTIFY_EVENT_TYPES.has(eventType))
        return true;
    return /^(page|database|data_source)\./u.test(eventType);
}
function eventTypeToJaLabel(eventType) {
    if (eventType.endsWith(".created"))
        return "新規作成";
    if (eventType.endsWith(".deleted"))
        return "削除";
    if (eventType.endsWith(".undeleted"))
        return "復元";
    if (eventType.endsWith(".moved"))
        return "移動";
    if (eventType.endsWith(".schema_updated"))
        return "スキーマ変更";
    if (eventType.endsWith(".properties_updated"))
        return "プロパティ更新";
    if (eventType.endsWith(".content_updated"))
        return "内容更新";
    if (eventType.endsWith(".locked"))
        return "ロック";
    if (eventType.endsWith(".unlocked"))
        return "ロック解除";
    return "更新";
}
function firstTitleFromProperties(properties) {
    if (!properties)
        return undefined;
    for (const v of Object.values(properties)) {
        if (v?.type === "title" && Array.isArray(v.title)) {
            const joined = v.title.map((t) => t.plain_text ?? "").join("").trim();
            if (joined)
                return joined;
        }
    }
    return undefined;
}
function pickEntityPage(body) {
    const candidate = body.entity;
    if (candidate?.properties)
        return candidate;
    const nested = body.data?.entity;
    if (nested?.properties)
        return nested;
    return undefined;
}
function pickEntityPageId(body) {
    const candidate = body.entity;
    if (candidate?.type === "page" && candidate.id)
        return candidate.id;
    const nested = body.data
        ?.entity;
    if (nested?.type === "page" && nested.id)
        return nested.id;
    return undefined;
}
async function fetchNotionPageById(pageId) {
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: {
            Authorization: `Bearer ${env.NOTION_API_KEY}`,
            "Notion-Version": "2022-06-28",
        },
    });
    if (!r.ok) {
        console.error("[notion-webhook] fetch page detail failed", r.status, pageId);
        return undefined;
    }
    return (await r.json());
}
async function buildNotionNotificationText(eventType, body) {
    const lines = [];
    const label = eventTypeToJaLabel(eventType);
    lines.push(`Notionタスク ${label}`);
    lines.push(`種類: ${eventType || "不明"}`);
    let page = pickEntityPage(body);
    if (!page?.properties) {
        const pageId = pickEntityPageId(body);
        if (pageId) {
            page = await fetchNotionPageById(pageId);
        }
    }
    const props = page?.properties;
    const title = firstTitleFromProperties(props) ??
        ((props?.["タスク名"]?.title ?? [])
            .map((t) => t.plain_text ?? "")
            .join("")
            .trim() || undefined);
    const status = props?.["ステータス"]?.status?.name ?? undefined;
    const priority = props?.["優先度"]?.select?.name ?? undefined;
    const due = props?.["期日"]?.date?.start ?? undefined;
    const assigneesRaw = props?.["担当者"]?.people ?? [];
    const assignees = assigneesRaw
        .map((p) => p.name?.trim())
        .filter((n) => Boolean(n));
    if (title)
        lines.push(`タスク: ${title}`);
    if (status)
        lines.push(`ステータス: ${status}`);
    if (priority)
        lines.push(`優先度: ${priority}`);
    if (due)
        lines.push(`期日: ${due}`);
    if (assignees.length > 0)
        lines.push(`担当者: ${assignees.join("、")}`);
    if (page?.url)
        lines.push(`URL: ${page.url}`);
    return lines.join("\n");
}
/** LINE 用: 直近の行だけ取得（更新順） */
async function queryNotionTaskListForLine() {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
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
    });
    const body = await r.json();
    if (!r.ok) {
        throw new Error(`Notion API ${r.status}: ${JSON.stringify(body)}`);
    }
    return body;
}
/** Notion 初回 Webhook 検証で届く token をサーバー上に保存（GET で再取得用。サーバレスでは同一インスタンス時のみ有効） */
const NOTION_VERIFICATION_STATE_FILE = "/tmp/notion-verification-last.json";
// ルートを設定
app.get("/", async (_, res) => {
    return res.status(200).send({
        message: "success",
    });
});
/** ブラウザで開いて「URL が Vercel に届くか」確認用。Notion への登録は POST のこの URL */
app.get("/notion-webhook", (_req, res) => {
    res.status(200).json({
        ok: true,
        message: "この URL は生きています。Notion Integration の Webhook には「POST 先」として同じパスを登録してください（GET は検証用のみ）。",
    });
});
/** 設定状況（秘密は出さない）と Notion に貼るべき URL */
app.get("/api/diag", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || "https";
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
        lineWebhookPostUrl: host ? `${proto}://${host}/webhook` : "",
        taskListTriggers: env.TASK_LIST_TRIGGERS,
        taskListHint: "LINE で「タスク一覧」「タスク」「一覧」「リスト」のいずれかを含めて送信。グループは @メンション付きでも可。",
        lastVerificationToken: "初回検証後は GET /api/notion-verification-token（Bearer CRON_SECRET）で直近の verification_token を取得できます（Vercel ではログが確実）",
    });
});
/**
 * Notion 初回検証でサーバーが保存した verification_token を取得（Bearer 必須）
 */
app.get("/api/notion-verification-token", async (req, res) => {
    const secret = env.CRON_SECRET;
    if (!secret) {
        return res.status(503).json({
            error: "CRON_SECRET を Vercel に設定してください",
        });
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).send("Unauthorized");
    }
    try {
        const raw = await readFile(NOTION_VERIFICATION_STATE_FILE, "utf8");
        return res.status(200).json(JSON.parse(raw));
    }
    catch {
        return res.status(404).json({
            message: "まだ verification_token を保存していません。Notion で Webhook を保存して初回 POST を受け取ってください。",
        });
    }
});
/**
 * Notion → この URL を Integration の Webhook に登録（HTTPS・公開 URL 必須）
 * 初回は body に verification_token のみ → Notion 画面に貼り付けて検証後、同じ token を NOTION_VERIFICATION_TOKEN に保存推奨
 */
app.post("/notion-webhook", (req, _res, next) => {
    console.error("[notion-webhook] POST hit content-type:", req.headers["content-type"] ?? "(none)");
    next();
}, 
// charset 付き application/json 等でも必ず raw を取る（空ボディで署名失敗するのを防ぐ）
express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
    if (!rawBody.trim()) {
        console.error("[notion-webhook] empty body — Content-Type またはプロキシ設定を確認してください");
        return res.status(400).send("empty body");
    }
    const sigRaw = req.headers["x-notion-signature"];
    const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
    let parsed;
    try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
    }
    catch {
        return res.status(400).send("invalid json");
    }
    const obj = parsed;
    // 購読作成時のワンタイム検証（イベントには type がある）
    if (typeof obj.verification_token === "string" && !("type" in obj)) {
        const token = obj.verification_token;
        console.error("[notion-webhook] verification_token（この値を Notion の入力欄と NOTION_VERIFICATION_TOKEN に貼る）:", token);
        try {
            await writeFile(NOTION_VERIFICATION_STATE_FILE, JSON.stringify({
                verification_token: token,
                receivedAt: new Date().toISOString(),
            }, null, 2), "utf8");
        }
        catch (e) {
            console.error("[notion-webhook] failed to save verification state", e);
        }
        return res.status(200).json({
            ok: true,
            verification_token: token,
            message: "この verification_token を Notion の入力欄に貼り、検証してください。Vercel の NOTION_VERIFICATION_TOKEN にも同じ値を設定してください。",
        });
    }
    const secret = env.NOTION_VERIFICATION_TOKEN;
    if (secret && !env.NOTION_SKIP_SIGNATURE_VERIFY) {
        if (!verifyNotionSignature(rawBody, sig, secret)) {
            console.error("[notion-webhook] signature mismatch — token 不一致の可能性。切り分け: NOTION_SKIP_SIGNATURE_VERIFY=true または token を再取得");
            return res.status(401).send("invalid signature");
        }
    }
    else {
        if (env.NOTION_SKIP_SIGNATURE_VERIFY) {
            console.warn("[notion-webhook] NOTION_SKIP_SIGNATURE_VERIFY により署名検証をスキップしています");
        }
        else if (!secret) {
            console.warn("[notion-webhook] NOTION_VERIFICATION_TOKEN 未設定のため署名検証をスキップしています（本番では必ず設定してください）");
        }
    }
    const eventType = typeof obj.type === "string" ? obj.type : "";
    console.error("[notion-webhook] incoming type:", eventType || "(empty)");
    if (!eventType || !isNotifiableNotionEventType(eventType)) {
        console.error("[notion-webhook] ignored (unknown type):", eventType || "(empty)");
        return res.status(200).send("ignored");
    }
    if (!env.NOTION_RELAX_DATABASE_FILTER) {
        const okDb = await eventConcernsTargetDatabase(parsed);
        if (!okDb) {
            console.error("[notion-webhook] not target db (payload に DB ID が無い場合はページ取得で照合済み)。NOTION_RELAX_DATABASE_FILTER=true で緩和可");
            return res.status(200).send("not target db");
        }
    }
    const groupId = env.LINE_GROUP_ID?.trim();
    if (!groupId) {
        console.warn("[notion-webhook] LINE_GROUP_ID 未設定のため LINE 通知をスキップ");
        return res.status(200).send("no LINE_GROUP_ID");
    }
    const text = await buildNotionNotificationText(eventType, obj);
    const msg = { type: "text", text };
    try {
        await client.pushMessage({
            to: groupId,
            messages: [msg],
        });
    }
    catch (e) {
        if (e instanceof HTTPError) {
            console.error("[notion-webhook] LINE push failed", e.statusCode, e.statusMessage, e.originalError);
        }
        else {
            console.error("[notion-webhook] LINE push failed", e);
        }
        return res.status(500).send("line push failed");
    }
    return res.status(200).send("ok");
});
// テキストメッセージを処理するハンドラー（関数）　
//下で使う用。
const textEventHandler = async (event) => {
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
            const messages = slice.map((t) => ({
                type: "text",
                text: t,
            }));
            if (chunks.length > 5) {
                messages.push({
                    type: "text",
                    text: "...他 " +
                        String(chunks.length - 5) +
                        " 件分は長いため省略しました。Notion で全件を確認してください。",
                });
            }
            await client.replyMessage({ replyToken, messages });
        }
        catch (e) {
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
    return undefined;
};
// webhookエンドポイントにpostリクエストが来たら、
app.post("/webhook", middleware(middlewareConfig), async (req, res) => {
    const events = req.body.events ?? [];
    let hasError = false;
    await Promise.all(events.map(async (event) => {
        try {
            await textEventHandler(event);
        }
        catch (err) {
            hasError = true;
            console.error(err instanceof Error ? err.message : err);
        }
    }));
    if (hasError) {
        res.status(500).send("Internal Server Error");
    }
    else {
        res.status(200).send("OK");
    }
});
// ローカルのみ HTTP サーバー起動（Vercel は serverless で export を使う）
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`http://localhost:${PORT}/`);
    });
}
export default app;
//# sourceMappingURL=index.js.map