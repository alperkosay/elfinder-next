import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { BACKSLASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";
import { buildZip, type ZipInput } from "./fixtures/zip.js";

const UP = "..";

/** Creates a volume holding `sub/payload.zip` built from the given entries. */
async function volumeWithArchive(entries: ZipInput[], options = {}) {
  return makeVolume({ "sub/payload.zip": buildZip(entries) }, options);
}

const extract = (vol: Awaited<ReturnType<typeof makeVolume>>, extra = "") =>
  vol.GET(`cmd=extract&target=${hashOf("sub/payload.zip")}${extra}`);

describe("extract validates entry names (item 2)", () => {
  it("keeps the fixture honest: the archive really carries the hostile name", () => {
    // If adm-zip or the writer sanitized names, every case below would pass for
    // the wrong reason.
    const hostile = [UP, UP, UP, "ESCAPED.txt"].join("/");
    const bytes = buildZip([{ name: hostile, data: Buffer.from("x") }]);
    const names = new AdmZip(bytes).getEntries().map((e) => e.entryName);
    expect(names).toEqual([hostile]);
  });

  it("refuses dot segments with forward slashes", async () => {
    const vol = await volumeWithArchive([
      { name: [UP, UP, UP, "ESCAPED.txt"].join("/"), data: Buffer.from("PWND") },
    ]);
    expect(await errorOf(await extract(vol))).toEqual(["errArcSymlinks"]);
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("refuses dot segments with backslashes", async () => {
    const vol = await volumeWithArchive([
      { name: [UP, UP, UP, "ESCAPED.txt"].join(BACKSLASH), data: Buffer.from("PWND") },
    ]);
    expect(await errorOf(await extract(vol))).toEqual(["errArcSymlinks"]);
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("refuses an absolute entry name", async () => {
    const vol = await volumeWithArchive([
      { name: "/tmp/ABS.txt", data: Buffer.from("PWND") },
    ]);
    expect(await errorOf(await extract(vol))).toEqual(["errArcSymlinks"]);
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("writes nothing at all when one entry is hostile", async () => {
    // Validation completes before the first byte, so a bad entry cannot leave a
    // half-extracted tree behind.
    const vol = await volumeWithArchive([
      { name: "innocent.txt", data: Buffer.from("fine") },
      { name: [UP, UP, "ESCAPED.txt"].join("/"), data: Buffer.from("PWND") },
    ]);
    expect(await errorOf(await extract(vol))).toEqual(["errArcSymlinks"]);
    expect(await vol.exists("sub/innocent.txt")).toBe(false);
  });

  it("extracts a benign archive, including nested directories", async () => {
    const vol = await volumeWithArchive([
      { name: "ok/inner.txt", data: Buffer.from("fine") },
      { name: "ok/deeper/leaf.txt", data: Buffer.from("leaf") },
    ]);
    expect(await errorOf(await extract(vol))).toBeNull();
    expect(await vol.read("sub/ok/inner.txt")).toBe("fine");
    expect(await vol.read("sub/ok/deeper/leaf.txt")).toBe("leaf");
  });

  it("extracts into a new folder when makedir is set", async () => {
    const vol = await volumeWithArchive([
      { name: "inner.txt", data: Buffer.from("fine") },
    ]);
    expect(await errorOf(await extract(vol, "&makedir=1"))).toBeNull();
    expect(await vol.read("sub/payload/inner.txt")).toBe("fine");
  });
});

describe("extract caps archive size (item 2)", () => {
  it("refuses more entries than maxArchiveEntries", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.txt`,
      data: Buffer.from("x"),
    }));
    const vol = await volumeWithArchive(entries, { maxArchiveEntries: 5 });
    expect(await errorOf(await extract(vol))).toEqual(["errArcMaxSize"]);
    expect(await vol.exists("sub/f0.txt")).toBe(false);
  });

  it("refuses more uncompressed bytes than maxArchiveBytes", async () => {
    const vol = await volumeWithArchive(
      [{ name: "big.bin", data: Buffer.alloc(4096, 0) }],
      { maxArchiveBytes: 1024 },
    );
    expect(await errorOf(await extract(vol))).toEqual(["errArcMaxSize"]);
    expect(await vol.exists("sub/big.bin")).toBe(false);
  });

  it("allows an archive that sits under both caps", async () => {
    const vol = await volumeWithArchive(
      [{ name: "small.bin", data: Buffer.alloc(512, 1) }],
      { maxArchiveEntries: 5, maxArchiveBytes: 1024 },
    );
    expect(await errorOf(await extract(vol))).toBeNull();
    expect(await vol.exists("sub/small.bin")).toBe(true);
  });
});

describe("archive creation", () => {
  it("zips the selected files and reports the new archive", async () => {
    const vol = await makeVolume({ "a.txt": "A", "b.txt": "B" });
    const body = await json(
      await vol.GET(
        `cmd=archive&target=v1_Lw&name=bundle.zip` +
          `&targets[]=${hashOf("a.txt")}&targets[]=${hashOf("b.txt")}`,
      ),
    );
    expect(body.error).toBeUndefined();
    expect(body.added?.[0]?.name).toBe("bundle.zip");

    const names = new AdmZip(vol.at("bundle.zip")).getEntries().map((e) => e.entryName);
    expect(names.sort()).toEqual(["a.txt", "b.txt"]);
  });
});
