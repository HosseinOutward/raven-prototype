export interface LicenceEntry {
  packages: string[];
  text: string;
}

export interface LicenceGroup {
  licence: string;
  entries: LicenceEntry[];
}

/**
 * Reads THIRD-PARTY-NOTICES.md, which scripts/third-party-notices.ts writes: a `## licence`
 * heading, then for each distinct text a `Used by:` line and the text indented by four spaces.
 */
export function parseNotices(raw: string): LicenceGroup[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [licence, ...rest] = section.split(/^Used by: /m);
      return {
        licence: licence.trim(),
        entries: rest.map((block) => {
          const [packages, ...text] = block.split("\n");
          return {
            packages: packages.split(", "),
            text: text.map((line) => line.replace(/^ {4}/, "")).join("\n").trim(),
          };
        }),
      };
    });
}
