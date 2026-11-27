import { invalid } from "../../../domain/companion/protocol";
/** Calendar arithmetic uses the explicitly paired vault IANA zone, never machine TZ.
 * Repeated DST minutes count as one session; nonexistent wall-clock sessions are skipped. */
export function zoneParts(now: number, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = f.formatToParts(now), get = (name: string) => Number(parts.find(p => p.type === name)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}
export function validateTimeZone(zone: string): void { invalid(typeof zone === "string" && zone.length <= 100); zoneParts(0, zone); }
export function studyDay(now: number, zone: string): string { const p = zoneParts(now, zone); return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour - 4)).toISOString().slice(0, 10); }
export function sessionOrder(now: number, zone: string): number { const p = zoneParts(now, zone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
export function sessionKey(now: number, zone: string): string { const p = zoneParts(now, zone); return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}`; }
export function latestSession(now: number, zone: string, minutes: number[]): number {
  const start = Math.floor(now / 60000) * 60000;
  for (let i = 0; i <= 14; i++) { const t = start - i * 60000, p = zoneParts(t, zone); if (minutes.includes(p.hour * 60 + p.minute)) return t; }
  return 0;
}
export function nextSession(now: number, zone: string, minutes: number[], previousSession = 0): number {
  const start = Math.floor(now / 60000) * 60000;
  const currentKey = sessionKey(now, zone);
  for (let i = 1; i <= 3 * 1440; i++) { const t = start + i * 60000, p = zoneParts(t, zone); if (minutes.includes(p.hour * 60 + p.minute) && sessionKey(t, zone) !== currentKey && (!previousSession || sessionOrder(t, zone) > sessionOrder(previousSession, zone))) return t; }
  throw new Error("no future reminder session");
}
