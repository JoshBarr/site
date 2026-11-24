import { describe, expect, it } from "vitest";
import { nzDate, nzTime } from "../../src/lib/nzClock";

describe("NZ's wall clock", () => {
  it("is thirteen hours ahead in summer, twelve in winter", () => {
    expect(nzTime("2026-11-20 19:50")).toBe(Date.parse("2026-11-20T06:50Z"));
    expect(nzTime("2026-06-20 19:50")).toBe(Date.parse("2026-06-20T07:50Z"));
  });

  it("changes over at 2 am, the last Sunday of September", () => {
    expect(nzTime("2026-09-27 01:55")).toBe(Date.parse("2026-09-26T13:55Z"));
    expect(nzTime("2026-09-27 03:05")).toBe(Date.parse("2026-09-26T14:05Z"));
  });

  it("reads seconds too", () => {
    expect(nzTime("2026-11-27 23:59:59")).toBe(
      Date.parse("2026-11-27T10:59:59Z")
    );
  });

  it("gives the date there", () => {
    expect(nzDate(Date.parse("2026-11-23T10:59Z"))).toBe("2026-11-23");
    expect(nzDate(Date.parse("2026-11-23T11:01Z"))).toBe("2026-11-24");
  });
});
