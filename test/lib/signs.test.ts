import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchSigns } from "../../src/lib/nzta";
import { parseMessage } from "../../src/lib/signs";
import { SIGNS_URL, vms } from "../fixtures/nztaSigns";
import { server } from "../msw";

// NZTA's message signs: what each is showing, as its API sends it, and the
// pages and lines its markup makes of that.

/** A sign as far as the reading of it goes. */
interface Listed {
  id: number | string;
  currentMessage?: string | number | null;
}

/** NZTA answering with `response`: "" when it has no signs to list. */
function signs(response: { vms: Listed | Listed[] } | "") {
  const requests: Request[] = [];

  server.use(
    http.get(SIGNS_URL, ({ request }) => {
      requests.push(request);

      return HttpResponse.json({ response });
    })
  );

  return requests;
}

describe("NZTA's message signs", () => {
  it("are each sign's message by its id, blank ones too", async () => {
    const requests = signs({ vms });

    expect(await fetchSigns()).toEqual({
      messages: {
        385: "J'VILLE [jl4]12[nl]WGTN CBD [jl4]19",
        136: "WGTN CBD[jl4]6[nl]WGTN HOSPITAL[jl4]9[nl]AIRPORT VIA[nl]SH1[jl4]14[nl]THE QUAYS[jl4]18",
        388: "J'VILLE [jl4]9[nl]WGTN CBD [jl4]16[np]AIRPORT [jl4]25[nl]PETONE [jl4]15",
        67: "",
        75: "TERRACE TUNNEL[nl]CLOSING NORTHBOUND[nl]SUN-THU 9PM-4:30AM",
      },
    });
    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("read one sign sent as itself, not a list of one", async () => {
    signs({ vms: vms[0] });

    expect(Object.keys((await fetchSigns()).messages)).toEqual(["385"]);
  });

  it("read a sign with no message at all as blank", async () => {
    signs({ vms: [{ id: 7 }, { id: 8, currentMessage: null }] });

    expect(await fetchSigns()).toEqual({ messages: { 7: "", 8: "" } });
  });

  it("fail when NZTA lists none, as it does with an empty answer", async () => {
    signs("");

    await expect(fetchSigns()).rejects.toThrow("nzta signs: none");
  });

  it("fail when NZTA does", async () => {
    server.use(
      http.get(SIGNS_URL, () => new HttpResponse(null, { status: 503 }))
    );

    await expect(fetchSigns()).rejects.toThrow("nzta signs: 503");
  });

  it("fail when the answer isn't as expected", async () => {
    signs({ vms: [{ id: "385", currentMessage: 12 }] });

    await expect(fetchSigns()).rejects.toThrow();
  });
});

const line = (left: string, right = "", centre = "") => ({
  left,
  centre,
  right,
});

describe("a sign's message", () => {
  it("is no pages when the sign's blank", () => {
    expect(parseMessage("")).toEqual([]);
    expect(parseMessage("[nl][np]")).toEqual([]);
  });

  it("sets a travel time's place to the left and its minutes to the right", () => {
    expect(parseMessage("J'VILLE [jl4]12[nl]WGTN CBD [jl4]19")).toEqual([
      [line("J'VILLE", "12"), line("WGTN CBD", "19")],
    ]);
  });

  it("centres a line that's all one piece", () => {
    expect(
      parseMessage("TERRACE TUNNEL[nl]CLOSING NORTHBOUND[nl]SUN-THU 9PM-4:30AM")
    ).toEqual([
      [
        line("", "", "TERRACE TUNNEL"),
        line("", "", "CLOSING NORTHBOUND"),
        line("", "", "SUN-THU 9PM-4:30AM"),
      ],
    ]);
  });

  it("starts a page at each [np]", () => {
    expect(
      parseMessage(
        "J'VILLE [jl4]9[nl]WGTN CBD [jl4]16[np]AIRPORT [jl4]25[nl]PETONE [jl4]15"
      )
    ).toEqual([
      [line("J'VILLE", "9"), line("WGTN CBD", "16")],
      [line("AIRPORT", "25"), line("PETONE", "15")],
    ]);
  });

  it("drops the empty line a trailing [nl] leaves, and tags it doesn't know", () => {
    expect(
      parseMessage(
        "[fo3]J'VILLE [jl4]7[nl]PORIRUA [jl4]14[nl]PETONE [jl4]9[nl]"
      )
    ).toEqual([
      [line("J'VILLE", "7"), line("PORIRUA", "14"), line("PETONE", "9")],
    ]);
  });

  it("keeps to the left what [jl2] sets there", () => {
    expect(parseMessage("[jl2]VIA SH58")).toEqual([[line("VIA SH58")]]);
  });

  it("splits five lines run together after a finished entry, heading with its line", () => {
    expect(
      parseMessage(
        "WGTN CBD[jl4]6[nl]WGTN HOSPITAL[jl4]9[nl]AIRPORT VIA[nl]SH1[jl4]14[nl]THE QUAYS[jl4]18"
      )
    ).toEqual([
      [line("WGTN CBD", "6"), line("WGTN HOSPITAL", "9")],
      [line("", "", "AIRPORT VIA"), line("SH1", "14"), line("THE QUAYS", "18")],
    ]);
  });

  it("splits five lines of plain text near the middle", () => {
    expect(
      parseMessage("A[nl]B[nl]C[nl]D[nl]E").map((page) =>
        page.map(({ centre }) => centre)
      )
    ).toEqual([
      ["A", "B"],
      ["C", "D", "E"],
    ]);
  });
});
