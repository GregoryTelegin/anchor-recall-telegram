export interface MediaRange { start: number; end: number; }
export type MediaRangeValidation = { valid: true; range: MediaRange } | { valid: false; error: string };

/** Seconds relative to one media file. No repair, coercion or silent clamping. */
export function validateMediaRange(value: unknown): MediaRangeValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "Укажите начало и конец фрагмента." };
  const range = value as Record<string, unknown>;
  if (Object.keys(range).some(key => key !== "start" && key !== "end")) return { valid: false, error: "Фрагмент поддерживает только start и end." };
  if (typeof range.start !== "number" || typeof range.end !== "number" || !Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start) return { valid: false, error: "Время должно быть конечным числом: 0 ≤ начало < конец." };
  return { valid: true, range: { start: range.start, end: range.end } };
}

/** Accept seconds, mm:ss or hh:mm:ss, with a decimal fraction on seconds only. */
export function parseMediaRangeTime(value: string): number | undefined {
  const parts = value.trim().split(":");
  if (!parts.length || parts.length > 3 || !/^\d+(?:[.,]\d+)?$/.test(parts[parts.length - 1])
    || parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return undefined;
  const numbers = parts.map(part => Number(part.replace(",", ".")));
  if (numbers.some(part => !Number.isFinite(part)) || numbers.slice(1).some(part => part >= 60)) return undefined;
  const seconds = numbers.reduce((result, part) => result * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Compact display labels, rounded to milliseconds only; never use to save bounds. */
export function formatMediaRangeTime(seconds: number): string {
  return formatClockTime(Number.isFinite(seconds) && seconds >= 0 ? Number(seconds.toFixed(3)) : seconds, false);
}

/** Editable clock values preserve all stored precision, including sub-millisecond bounds. */
export function formatMediaRangeInputTime(seconds: number): string {
  return formatClockTime(seconds, true);
}

function formatClockTime(seconds: number, paddedHours: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const source = String(seconds);
  // Expand scientific notation so even tiny/large valid bounds can be edited with
  // the same strict decimal parser, without rounding a nonzero bound to zero.
  if (/e/i.test(source)) {
    const [coefficient, exponentText] = source.split("e");
    const digits = coefficient.replace(".", ""), point = (coefficient.indexOf(".") < 0 ? coefficient.length : coefficient.indexOf(".")) + Number(exponentText);
    return point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const integer = Math.floor(seconds), hours = Math.floor(integer / 3600), minutes = Math.floor(integer / 60) % 60;
  const fractionDigits = source.split(".")[1] ?? "";
  const fraction = paddedHours ? `.${fractionDigits.padEnd(3, "0")}` : fractionDigits ? `.${fractionDigits}` : "";
  const tail = `${String(integer % 60).padStart(2, "0")}${fraction}`;
  if (paddedHours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${tail}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${Math.floor(integer / 60)}:${tail}`;
}
