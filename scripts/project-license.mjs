import { createHash } from "node:crypto";

export const licenseIdentifier = "PolyForm-Noncommercial-1.0.0";
export const licenseUrl = "https://polyformproject.org/licenses/noncommercial/1.0.0";
export const licenseNotice = "Required Notice: Copyright (c) 2026 Gregory T.";

// Official .txt at licenseUrl, retrieved 2026-09-10. Normalize only line endings
// and outer whitespace: changing the legal terms requires deliberate review.
const officialTermsHash = "7779a554c40798f0f9c04960b82154d16dc0fa64349d401d24146e5c81f64093";
const normalize = (text) => text.replace(/\r\n/g, "\n").trim();

export function validateProjectLicense(text) {
  const license = normalize(text);
  const prefix = `${licenseNotice}\n\n`;
  if (!license.startsWith(prefix)) return "LICENSE must retain the project's Required Notice";
  const termsHash = createHash("sha256").update(license.slice(prefix.length)).digest("hex");
  if (termsHash !== officialTermsHash) return "LICENSE must contain the unmodified PolyForm Noncommercial 1.0.0 terms";
  return null;
}

export function createLicenseBanner(thirdPartyNotices) {
  const notices = normalize(thirdPartyNotices);
  if (!notices) throw new Error("THIRD_PARTY_NOTICES.md must not be empty");
  // Reject a comment terminator instead of silently changing a legal notice.
  if (notices.includes("*/")) throw new Error("THIRD_PARTY_NOTICES.md cannot contain a JavaScript comment terminator");
  return [
    "/*!",
    "Anchor Recall",
    `SPDX-License-Identifier: ${licenseIdentifier}`,
    licenseNotice,
    `Project license: ${licenseUrl}`,
    "The project license applies to Anchor Recall's own code, not to bundled third-party components.",
    "Third-party components retain their original licenses and notices below.",
    "",
    notices,
    "*/"
  ].join("\n");
}
