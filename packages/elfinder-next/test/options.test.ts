import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContext } from "../src/context.js";
import { ROOT_HASH, json, makeVolume } from "./helpers.js";

/** The root volume options elFinder reads on init. */
async function rootOptions(options = {}) {
  const vol = await makeVolume({}, options);
  const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));
  return { cwd: body.cwd, top: body.options };
}

describe("url prefixes (item 44)", () => {
  it("serves everything through the connector by default (item 45)", async () => {
    // Next snapshots public/ at startup, so a static prefix for runtime uploads
    // answers 404 until a restart. Empty prefixes route through cmd=file instead.
    const { cwd, top } = await rootOptions();
    expect(cwd.options.url).toBe("");
    expect(cwd.options.tmbUrl).toBe("");
    expect(top.tmbUrl).toBe("");
  });

  it("appends a missing trailing slash", async () => {
    const { cwd } = await rootOptions({ publicUrl: "/media", tmbUrl: "/media/.tmb" });
    expect(cwd.options.url).toBe("/media/");
    expect(cwd.options.tmbUrl).toBe("/media/.tmb/");
  });

  it("keeps an empty prefix empty", async () => {
    // An empty url tells elFinder the files have no static path, so it addresses
    // them through cmd=file. Coercing "" to "/" claimed the opposite and produced
    // URLs like /photo.jpg.
    const { cwd, top } = await rootOptions({ publicUrl: "", tmbUrl: "" });
    expect(cwd.options.url).toBe("");
    expect(cwd.options.tmbUrl).toBe("");
    expect(top.tmbUrl).toBe("");
  });
});

describe("volume identity", () => {
  it("uses the configured root name and volume id", async () => {
    const vol = await makeVolume({ "a.txt": "x" }, { rootName: "media", volumeId: "v9_" });
    const body = await json(await vol.GET("cmd=open&init=1&target=v9_Lw"));

    expect(body.cwd.name).toBe("media");
    expect(body.cwd.hash).toBe("v9_Lw");
    expect(body.files.every((f: any) => f.hash.startsWith("v9_"))).toBe(true);
  });

  it("recognizes its own hash in upload_path[] whatever the volume id (item 39)", async () => {
    // elFinder sends the destination's hash in upload_path[] on a plain upload. The
    // connector used to spot it with /^v\d+_/, so under "files_" the hash itself
    // became the file name.
    const vol = await makeVolume({}, { volumeId: "files_" });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", "files_Lw");
    form.append("upload[]", new File(["x"], "photo.txt"));
    form.append("upload_path[]", "files_Lw");

    await vol.POST(form);
    expect(await vol.exists("photo.txt")).toBe(true);
    expect(await vol.exists("files_Lw")).toBe(false);
  });

  it("keeps a file whose name merely looks like a hash", async () => {
    const vol = await makeVolume();
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["x"], "v2_report"));

    await vol.POST(form);
    expect(await vol.exists("v2_report")).toBe(true);
  });

  it("refuses a hash minted for a different volume id", async () => {
    const vol = await makeVolume({ "src/f.txt": "x" }, { volumeId: "v9_" });
    // A v1_ hash is not ours when volumeId is v9_.
    const response = await vol.GET("cmd=paste&dst=v1_Lw&targets[]=v1_c3JjL2YudHh0");
    expect(await response.json()).toEqual({ error: ["errTrgFolderNotFound"] });
  });
});

describe("uploadDir resolution", () => {
  it("defaults to a directory outside public/ (item 38)", () => {
    // Under public/, the half-uploaded parts in .chunks were downloadable by anyone.
    expect(resolveContext().uploadDir).toBe(path.resolve(process.cwd(), "uploads"));
  });

  it("accepts an absolute uploadDir", async () => {
    const vol = await makeVolume({ "a.txt": "x" });
    expect(path.isAbsolute(vol.uploadDir)).toBe(true);
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    expect(body.files.map((f: any) => f.name)).toContain("a.txt");
  });

  it("creates the volume and its bookkeeping directories on first request", async () => {
    const vol = await makeVolume();
    await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`);
    expect(await vol.exists(".tmb")).toBe(true);
    expect(await vol.exists(".chunks")).toBe(true);
  });
});

describe("archive caps are configurable", () => {
  it("defaults are permissive enough for an ordinary archive", async () => {
    const { cwd } = await rootOptions();
    // The caps are not part of the protocol payload; this just asserts that
    // omitting them does not disable archiving.
    expect(cwd.options.archivers).toBeDefined();
  });
});
