import { pluralRu } from "../../shared/format";
import type { StepUnit } from "ts-fsrs";

export const formatDuration = (minutes: number): string => {
  if (minutes >= 43200 && minutes % 43200 === 0) { const value = minutes / 43200; return `${value} ${pluralRu(value, "месяц", "месяца", "месяцев")}`; }
  if (minutes >= 10080 && minutes % 10080 === 0) { const value = minutes / 10080; return `${value} ${pluralRu(value, "неделя", "недели", "недель")}`; }
  if (minutes >= 1440 && minutes % 1440 === 0) { const value = minutes / 1440; return `${value} ${pluralRu(value, "день", "дня", "дней")}`; }
  if (minutes >= 60 && minutes % 60 === 0) { const value = minutes / 60; return `${value} ${pluralRu(value, "час", "часа", "часов")}`; }
  return `${minutes} мин`;
};

export const formatIntervalCode = (minutes: number): string => {
  if (minutes >= 43200 && minutes % 43200 === 0) return `${minutes / 43200}mo`;
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};

export const parseIntervals = (value: string): number[] => {
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?)+$/.test(normalized)) return normalized.split(/\s+/).map(Number);
  return normalized.split(/[;,]+/).map((part) => {
    const match = part.trim().toLocaleLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-zа-яё.]*)$/u);
    if (!match) return Number.NaN;
    const amount = Number(match[1]); const unit = match[2].replace(/\./g, "");
    let multiplier = 1;
    if (["ч", "h", "hr", "hrs", "hour", "hours"].includes(unit) || unit.startsWith("час")) multiplier = 60;
    else if (["д", "d", "day", "days"].includes(unit) || unit.startsWith("ден") || unit.startsWith("дн")) multiplier = 1440;
    else if (["н", "w", "wk", "week", "weeks"].includes(unit) || unit.startsWith("нед")) multiplier = 10080;
    else if (["mo", "month", "months"].includes(unit) || unit.startsWith("мес")) multiplier = 43200;
    else if (unit && !["м", "m", "min", "mins", "minute", "minutes"].includes(unit) && !unit.startsWith("мин")) return Number.NaN;
    return Math.round(amount * multiplier);
  }).filter((minutes) => Number.isFinite(minutes) && minutes > 0);
};

export const formatFsrsStepCode = (minutes: number): StepUnit => {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d` as StepUnit;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h` as StepUnit;
  return `${minutes}m` as StepUnit;
};

export const normalizeFsrsSteps = (value: string, maxSteps: number, fallback: string): StepUnit[] => {
  const parsed = parseIntervals(value).slice(0, maxSteps);
  const minutes = parsed.length ? parsed : parseIntervals(fallback).slice(0, maxSteps);
  return minutes.map(formatFsrsStepCode);
};

export const normalizeFsrsStepText = (value: string, maxSteps: number, fallback: string): string =>
  normalizeFsrsSteps(value, maxSteps, fallback).join(", ");
