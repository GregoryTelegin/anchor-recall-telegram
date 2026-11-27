

export const getFileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Файл не указан";

export const pluralRu = (value: number, one: string, few: string, many: string): string => {
  const lastTwo = value % 100; const last = value % 10;
  return lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
};
