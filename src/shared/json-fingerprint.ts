/** JSON-value equality independent of object insertion order; array order matters. */
export function jsonFingerprint(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}
