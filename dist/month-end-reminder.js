/** 月末 21:00（東京）のグループ向けリマインダー文面 */
export const MONTH_END_REMINDER_TEXT = `今月もありがとうございました！
今月働いた時間と自分の時給をかけた金額を
こうだいの個人ラインに送ってください！`;
/** 毎月最終木曜 21:00（東京）のグループ向けリマインダー文面 */
export const LAST_THURSDAY_REMINDER_TEXT = `月末なので来月に向けて
ミーティングと中掃除会を
開いてください！`;
const TOKYO = "Asia/Tokyo";
function monthKeyInTokyo(d) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TOKYO,
        year: "numeric",
        month: "2-digit",
    }).format(d);
}
/**
 * 東京時間で「その月の最後の木曜日」か。
 * 木曜かつ、7日後が翌月ならその木曜が月内最後の木曜。
 */
export function isLastThursdayOfMonthInTokyo(now) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TOKYO,
        weekday: "short",
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    if (weekday !== "Thu")
        return false;
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return monthKeyInTokyo(now) !== monthKeyInTokyo(nextWeek);
}
/** 東京タイムゾーンで「翌日が1日」ならその日は月末最終日 */
export function isLastDayOfMonthInTokyo(now) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const dayTomorrow = new Intl.DateTimeFormat("en-US", {
        timeZone: TOKYO,
        day: "numeric",
    }).format(tomorrow);
    return dayTomorrow === "1";
}
/** 東京の現在時刻（0–23） */
export function getHourInTokyo(now) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TOKYO,
        hour: "2-digit",
        hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value;
    return h !== undefined ? parseInt(h, 10) : NaN;
}
//# sourceMappingURL=month-end-reminder.js.map