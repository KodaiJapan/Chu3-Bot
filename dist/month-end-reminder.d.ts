/** 月末 21:00（東京）のグループ向けリマインダー文面 */
export declare const MONTH_END_REMINDER_TEXT = "\u4ECA\u6708\u3082\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3057\u305F\uFF01\n\u4ECA\u6708\u50CD\u3044\u305F\u6642\u9593\u3068\u81EA\u5206\u306E\u6642\u7D66\u3092\u304B\u3051\u305F\u91D1\u984D\u3092\n\u3053\u3046\u3060\u3044\u306E\u500B\u4EBA\u30E9\u30A4\u30F3\u306B\u9001\u3063\u3066\u304F\u3060\u3055\u3044\uFF01";
/** 毎月最終木曜 21:00（東京）のグループ向けリマインダー文面 */
export declare const LAST_THURSDAY_REMINDER_TEXT = "\u6708\u672B\u306A\u306E\u3067\u6765\u6708\u306B\u5411\u3051\u3066\n\u30DF\u30FC\u30C6\u30A3\u30F3\u30B0\u3068\u4E2D\u6383\u9664\u4F1A\u3092\n\u958B\u3044\u3066\u304F\u3060\u3055\u3044\uFF01";
/**
 * 東京時間で「その月の最後の木曜日」か。
 * 木曜かつ、7日後が翌月ならその木曜が月内最後の木曜。
 */
export declare function isLastThursdayOfMonthInTokyo(now: Date): boolean;
/** 東京タイムゾーンで「翌日が1日」ならその日は月末最終日 */
export declare function isLastDayOfMonthInTokyo(now: Date): boolean;
/** 東京の現在時刻（0–23） */
export declare function getHourInTokyo(now: Date): number;
//# sourceMappingURL=month-end-reminder.d.ts.map