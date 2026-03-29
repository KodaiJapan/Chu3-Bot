import { middleware, messagingApi, } from "@line/bot-sdk";
import express, {} from "express";
import { load } from "ts-dotenv";
// 環境変数をロード
const env = load({
    CHANNEL_ACCESS_TOKEN: String,
    CHANNEL_SECRET: String,
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
// ルートを設定
app.get("/", async (_, res) => {
    return res.status(200).send({
        message: "success",
    });
});
// テキストメッセージを処理するハンドラー（関数）　
//下で使う用。
const textEventHandler = async (event) => {
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
    const response = {
        type: "text",
        text: resText,
    };
    await client.replyMessage({
        replyToken: replyToken,
        messages: [response],
    });
};
// webhookエンドポイントにpostリクエストが来たら、
app.post("/webhook", middleware(middlewareConfig), async (req, res) => {
    const events = req.body.events;
    await Promise.all(events.map(async (event) => {
        try {
            await textEventHandler(event);
        }
        catch (err) {
            if (err instanceof Error) {
                console.error(err);
            }
            return res.status(500);
        }
    }));
    return res.status(200);
});
// ローカルのみ HTTP サーバー起動（Vercel は serverless で export を使う）
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`http://localhost:${PORT}/`);
    });
}
export default app;
//# sourceMappingURL=index.js.map