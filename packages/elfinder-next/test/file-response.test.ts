import { describe, expect, it } from "vitest";
import { hashOf, makeVolume } from "./helpers.js";

const BODY = "0123456789ABCDEFGHIJ"; // 20 bytes

async function serve(name: string, contents: string, query = "") {
  const vol = await makeVolume({ [name]: contents });
  const response = await vol.GET(`cmd=file&target=${hashOf(name)}${query}`);
  return response;
}

describe("inline previews are limited to types the browser will not execute (item 3)", () => {
  it.each([
    ["evil.html", "<script>alert(document.cookie)</script>"],
    ["evil.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"],
    ["macro.xhtml", "<html/>"],
    ["script.js", "alert(1)"],
  ])("serves %s as an attachment", async (name, contents) => {
    const response = await serve(name, contents);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it.each([
    ["photo.jpg", "jpegish"],
    ["photo.png", "pngish"],
    ["notes.txt", "hello"],
    ["doc.pdf", "%PDF-1.4"],
    ["clip.mp4", "mp4ish"],
  ])("still previews %s inline", async (name, contents) => {
    const response = await serve(name, contents);
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("honours an explicit download request for a previewable type", async () => {
    const response = await serve("photo.jpg", "jpegish", "&download=1");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("sets nosniff on every file response", async () => {
    for (const name of ["evil.html", "photo.jpg", "notes.txt"]) {
      const response = await serve(name, "x");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("Content-Disposition cannot be broken by a filename (item 4)", () => {
  it("keeps the ascii parameter quoted and balanced for a non-ASCII name", async () => {
    const response = await serve("türkçe-ağ.txt", "unicode");
    const header = response.headers.get("content-disposition") ?? "";
    // Before the fix this header was dropped entirely, because the raw value is
    // not a legal header value.
    expect(header).not.toBe("");
    const asciiParam = header.slice(header.indexOf('filename="'), header.indexOf("filename*="));
    expect(asciiParam.match(/"/g)).toHaveLength(2);
    expect(header).toContain("filename*=UTF-8''t%C3%BCrk%C3%A7e-a%C4%9F.txt");
  });

  it("percent-encodes a space rather than leaving it bare in filename*", async () => {
    const response = await serve("my report.pdf", "%PDF");
    const header = response.headers.get("content-disposition") ?? "";
    expect(header).toContain("filename*=UTF-8''my%20report.pdf");
  });
});

describe("Range support on cmd=file (item 12)", () => {
  async function ask(range: string | null) {
    const vol = await makeVolume({ "clip.mp4": BODY });
    const response = await vol.GET(
      `cmd=file&target=${hashOf("clip.mp4")}`,
      range ? { headers: { range } } : undefined,
    );
    return {
      status: response.status,
      length: response.headers.get("content-length"),
      contentRange: response.headers.get("content-range"),
      acceptRanges: response.headers.get("accept-ranges"),
      text: response.status === 416 ? "" : await response.text(),
    };
  }

  it("advertises range support", async () => {
    expect((await ask(null)).acceptRanges).toBe("bytes");
  });

  it("returns the whole body with no range header", async () => {
    expect(await ask(null)).toMatchObject({ status: 200, text: BODY, length: "20", contentRange: null });
  });

  it.each([
    ["bytes=0-4", 206, "01234", "bytes 0-4/20"],
    ["bytes=5-9", 206, "56789", "bytes 5-9/20"],
    ["bytes=15-", 206, "FGHIJ", "bytes 15-19/20"],
    ["bytes=-3", 206, "HIJ", "bytes 17-19/20"],
    ["bytes=0-999", 206, BODY, "bytes 0-19/20"],
  ])("serves %s as a partial response", async (range, status, text, contentRange) => {
    expect(await ask(range)).toMatchObject({ status, text, contentRange });
  });

  it("answers 416 for a start past the end", async () => {
    expect(await ask("bytes=50-60")).toMatchObject({
      status: 416,
      contentRange: "bytes */20",
    });
  });

  it("falls back to the whole body for a multi-range request", async () => {
    // Multi-range is not implemented; sending everything is a legal response and
    // better than guessing at one of the ranges.
    expect(await ask("bytes=0-1,5-6")).toMatchObject({ status: 200, text: BODY });
  });

  it("falls back to the whole body for a malformed header", async () => {
    expect(await ask("chunks=1-2")).toMatchObject({ status: 200, text: BODY });
  });

  it("treats any range over an empty file as unsatisfiable", async () => {
    const vol = await makeVolume({ "empty.mp4": "" });
    const target = hashOf("empty.mp4");
    const whole = await vol.GET(`cmd=file&target=${target}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("0");

    const ranged = await vol.GET(`cmd=file&target=${target}`, {
      headers: { range: "bytes=0-0" },
    });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });
});

describe("cmd=file rejects non-files", () => {
  it("refuses a directory", async () => {
    const vol = await makeVolume({ "sub/": "" });
    const response = await vol.GET(`cmd=file&target=${hashOf("sub")}`);
    expect(await response.json()).toEqual({ error: ["errNotFile"] });
  });

  it("refuses the volume root", async () => {
    const vol = await makeVolume();
    const response = await vol.GET("cmd=file&target=v1_Lw");
    expect(await response.json()).toEqual({ error: ["errFileNotFound"] });
  });
});
