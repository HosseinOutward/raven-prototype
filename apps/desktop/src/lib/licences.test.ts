import { describe, expect, test } from "bun:test";
import { parseNotices } from "./licences";

const NOTICES = `# Third-party notices

Raven is built on open-source software.

## Apache-2.0

Used by: livekit 0.7.45, tokio 1.52.3

    Apache License
    Version 2.0

    TERMS AND CONDITIONS

## MIT

Used by: react 19.2.6

    Copyright (c) Meta

Used by: serde 1.0.1

    Copyright (c) Serde developers
`;

describe("third-party notices", () => {
  test("groups the packages under each licence and keeps every text apart", () => {
    expect(parseNotices(NOTICES)).toEqual([
      {
        licence: "Apache-2.0",
        entries: [
          {
            packages: ["livekit 0.7.45", "tokio 1.52.3"],
            text: "Apache License\nVersion 2.0\n\nTERMS AND CONDITIONS",
          },
        ],
      },
      {
        licence: "MIT",
        entries: [
          { packages: ["react 19.2.6"], text: "Copyright (c) Meta" },
          { packages: ["serde 1.0.1"], text: "Copyright (c) Serde developers" },
        ],
      },
    ]);
  });

  test("reads nothing from an empty file", () => {
    expect(parseNotices("")).toEqual([]);
  });
});
