import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import * as holidays from "../../src/pages/api/holidays";
import { server } from "../msw";
import { call } from "../next";

// Wellington's public holidays, for how busy the scene's roads are, from
// Nager.Date.

const NAGER = "https://date.nager.at/api/v3/PublicHolidays/2026/NZ";

const holiday = (date: string, counties: string[] | null = null) => ({
  date,
  localName: "",
  name: "",
  countryCode: "NZ",
  fixed: false,
  global: counties === null,
  counties,
  launchYear: null,
  types: ["Public"],
});

describe("the holidays API route", () => {
  it("serves the national holidays and Wellington's own", async () => {
    server.use(
      http.get(NAGER, () =>
        HttpResponse.json([
          holiday("2026-01-01"),
          holiday("2026-01-19", ["NZ-WGN", "NZ-MWT"]),
          holiday("2026-01-26", ["NZ-AUK", "NZ-NTL"]),
          holiday("2026-07-10"),
        ])
      )
    );

    const response = await call(holidays, "/?year=2026");

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=86400, stale-while-revalidate=604800"
    );

    expect(await response.json()).toEqual({
      year: 2026,
      dates: ["2026-01-01", "2026-01-19", "2026-07-10"],
    });
  });

  it("refuses a year Nager.Date doesn't know", async () => {
    const response = await call(holidays, "/?year=1900");

    expect(response.status).toBe(400);
  });

  it("says so, briefly cached, when Nager.Date answers oddly", async () => {
    server.use(http.get(NAGER, () => HttpResponse.json({ status: 500 })));
    const response = await call(holidays, "/?year=2026");

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=300");
  });
});
