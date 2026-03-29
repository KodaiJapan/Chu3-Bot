/**
 * Notion DB の query 結果から LINE 向けタスク一覧テキストを組み立てる
 */
/** グループで「@ボット名 タスク一覧」のように送られる前提で先頭の @〜 を除く */
export declare function normalizeLineUserText(text: string): string;
/** トリガー文字列（カンマ区切り）に一致するか */
export declare function wantsTaskList(userText: string, triggersCsv: string): boolean;
export type NotionQueryBody = {
    results?: Array<{
        properties?: Record<string, unknown>;
    }>;
};
/**
 * query レスポンスから LINE 用テキストチャンクの配列（長さ制限で分割）
 */
export declare function buildTaskListMessages(body: unknown): string[];
//# sourceMappingURL=task-list.d.ts.map