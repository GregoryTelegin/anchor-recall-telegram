const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Telegram start payloads are limited to 64 characters; the plan ID remains opaque. */
export function companionStudyPlanBotLink(botUsername: string | undefined, planId: string): string | undefined {
  if (!botUsername || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername) || !/^[a-f0-9]{64}$/.test(planId)) return undefined;
  let bits = 0, value = 0, encoded = "";
  for (let index = 0; index < planId.length; index += 2) {
    value = value << 8 | parseInt(planId.slice(index, index + 2), 16); bits += 8;
    while (bits >= 6) { bits -= 6; encoded += alphabet[value >>> bits & 63]; }
  }
  if (bits) encoded += alphabet[value << 6 - bits & 63];
  return `https://t.me/${botUsername}?start=p_${encoded}`;
}

export function parseStudyPlanStartParameter(parameter: string): string | undefined {
  if (!/^p_[A-Za-z0-9_-]{43}$/.test(parameter)) return undefined;
  let bits = 0, value = 0, hex = "";
  for (const character of parameter.slice(2)) {
    value = value << 6 | alphabet.indexOf(character); bits += 6;
    if (bits >= 8) { bits -= 8; hex += (value >>> bits & 255).toString(16).padStart(2, "0"); }
  }
  if (value & (1 << bits) - 1) return undefined;
  return hex.length === 64 ? hex : undefined;
}
