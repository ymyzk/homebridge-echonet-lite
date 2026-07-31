import { describe, expect, it } from "vitest";

import { manufacturerName } from "./manufacturer.js";

describe("manufacturerName", () => {
  it("names a known manufacturer", () => {
    expect(manufacturerName(0x00000b)).toBe("Panasonic");
    expect(manufacturerName(0x000008)).toBe("Daikin");
  });

  it("falls back to the code for an unknown manufacturer", () => {
    // 0xFFFFFF is reserved by the spec for experimental use, so it is never
    // assigned to a member and always takes this path.
    expect(manufacturerName(0xffffff)).toBe("0xffffff");
  });

  it("pads the fallback to the width of the code", () => {
    expect(manufacturerName(0x000002)).toBe("0x000002");
  });
});
