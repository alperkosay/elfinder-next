import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_HASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";
import { buildZip } from "./fixtures/zip.js";

describe("volume options drive the client's menus (items 15, 16, 17)", () => {
  it("advertises zip in both archiver lists", async () => {
    // The Archive and Extract commands are hidden unless the mime appears here, which
    // made both handlers unreachable from the UI.
    const vol = await makeVolume({ "a.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));

    expect(body.cwd.options.archivers).toEqual({
      create: ["application/zip"],
      extract: ["application/zip"],
    });
  });

  it("does not disable size, which is implemented", async () => {
    const vol = await makeVolume({ "a.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));

    expect(body.cwd.options.disabled).not.toContain("size");
    expect(body.cwd.options.disabled).toContain("chmod");
  });

  it("carries the options on a subfolder too, not only the root", async () => {
    const vol = await makeVolume({ "sub/a.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&target=${hashOf("sub")}`));

    expect(body.cwd.options).toBeDefined();
    expect(body.cwd.options.archivers.create).toEqual(["application/zip"]);
    expect(body.cwd.options.url).toBe("/uploads/");
  });

  it("leaves plain files without an options block", async () => {
    const vol = await makeVolume({ "a.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const file = body.files.find((f: any) => f.name === "a.txt");

    expect(file.options).toBeUndefined();
  });
});

describe("upload limits are advertised and enforced (item 28)", () => {
  it("reports uplMaxSize and uplMaxFile on init", async () => {
    const vol = await makeVolume({}, { maxUploadBytes: 32 * 1024 * 1024, maxUploadFiles: 5 });
    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));

    expect(body.uplMaxSize).toBe("32M");
    expect(body.uplMaxFile).toBe(5);
  });

  it("omits them when the limits are switched off", async () => {
    const vol = await makeVolume({}, { maxUploadBytes: 0, maxUploadFiles: 0 });
    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));

    expect(body.uplMaxSize).toBeUndefined();
    expect(body.uplMaxFile).toBeUndefined();
  });

  it("refuses a file over the byte limit", async () => {
    const vol = await makeVolume({}, { maxUploadBytes: 16 });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["x".repeat(64)], "big.bin"), "big.bin");

    expect(await errorOf(await vol.POST(form))).toEqual(["errUploadFileSize", "big.bin"]);
    expect(await vol.exists("big.bin")).toBe(false);
  });

  it("refuses more files than the count limit", async () => {
    const vol = await makeVolume({}, { maxUploadFiles: 2 });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      form.append("upload[]", new File(["x"], name), name);
    }

    expect(await errorOf(await vol.POST(form))).toEqual(["errUploadFile"]);
    expect(await vol.exists("a.txt")).toBe(false);
  });

  it("refuses a chunked upload whose declared total is over the limit", async () => {
    // The per-file check only ever sees one slice, so the declared total is the only
    // chance to refuse before writing the whole thing.
    const vol = await makeVolume({}, { maxUploadBytes: 100 });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.set("chunk", "huge.bin.0_9.part");
    form.set("cid", "1");
    form.set("range", "0,4,999999");
    form.append("upload[]", new File(["PART"], "blob"), "blob");

    expect(await errorOf(await vol.POST(form))).toEqual(["errUploadFileSize", "huge.bin.0_9.part"]);
  });

  it("still accepts an upload inside the limits", async () => {
    const vol = await makeVolume({}, { maxUploadBytes: 1024, maxUploadFiles: 5 });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["fine"], "ok.txt"), "ok.txt");

    expect(await errorOf(await vol.POST(form))).toBeNull();
    expect(await vol.read("ok.txt")).toBe("fine");
  });
});

describe("folder size is the sum of its contents (item 18)", () => {
  it("adds up files recursively instead of reporting the inode size", async () => {
    const vol = await makeVolume({
      "docs/a.txt": "12345",
      "docs/deep/b.txt": "1234567890",
      "elsewhere.txt": "ignored",
    });
    const body = await json(await vol.GET(`cmd=size&targets[]=${hashOf("docs")}`));

    expect(body.size).toBe("15");
  });

  it("sums several targets, files and folders alike", async () => {
    const vol = await makeVolume({ "docs/a.txt": "12345", "top.txt": "123" });
    const body = await json(
      await vol.GET(`cmd=size&targets[]=${hashOf("docs")}&targets[]=${hashOf("top.txt")}`),
    );

    expect(body.size).toBe("8");
  });

  it("ignores the bookkeeping directories", async () => {
    const vol = await makeVolume({ "a.png": "x" });
    await vol.GET(`cmd=open&target=${ROOT_HASH}`); // creates .tmb, .chunks, .tmp
    await fs.writeFile(path.join(vol.uploadDir, ".tmb", "junk.png"), "0123456789");

    const body = await json(await vol.GET(`cmd=size&targets[]=${ROOT_HASH}`));
    expect(body.size).toBe("1");
  });
});

describe("search stays inside the volume's real contents (item 21)", () => {
  it("does not return thumbnails or chunk parts", async () => {
    const vol = await makeVolume({ "report.txt": "x" });
    await vol.GET(`cmd=open&target=${ROOT_HASH}`);
    await fs.writeFile(path.join(vol.uploadDir, ".tmb", "report-thumb.png"), "x");
    await fs.mkdir(path.join(vol.uploadDir, ".chunks", "7"), { recursive: true });
    await fs.writeFile(path.join(vol.uploadDir, ".chunks", "7", "report.0_1.part"), "x");

    const body = await json(await vol.GET(`cmd=search&q=report&target=${ROOT_HASH}`));
    expect(body.files.map((f: any) => f.name)).toEqual(["report.txt"]);
  });

  it("stops at the result cap", async () => {
    const tree = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`match-${i}.txt`, "x"]),
    );
    const vol = await makeVolume(tree, { maxSearchResults: 7 });
    const body = await json(await vol.GET(`cmd=search&q=match&target=${ROOT_HASH}`));

    expect(body.files).toHaveLength(7);
  });

  it("finds matches in nested folders", async () => {
    const vol = await makeVolume({ "a/b/c/needle.txt": "x", "other.txt": "x" });
    const body = await json(await vol.GET(`cmd=search&q=needle&target=${ROOT_HASH}`));

    expect(body.files.map((f: any) => f.name)).toEqual(["needle.txt"]);
  });

  it("omits matches the caller may not read", async () => {
    const vol = await makeVolume(
      { "open/needle.txt": "x", "closed/needle.txt": "x" },
      { permissions: (p) => ({ read: !p.startsWith("closed") }) },
    );
    const body = await json(await vol.GET(`cmd=search&q=needle&target=${ROOT_HASH}`));

    expect(body.files).toHaveLength(1);
  });
});

describe("a folder cannot be pasted into itself (item 22)", () => {
  it("refuses a copy into its own subtree", async () => {
    const vol = await makeVolume({ "outer/inner/a.txt": "x" });
    const response = await vol.GET(
      `cmd=paste&dst=${hashOf("outer/inner")}&targets[]=${hashOf("outer")}`,
    );

    expect(await errorOf(response)).toEqual(["errCopyInItself"]);
  });

  it("refuses a move into its own subtree", async () => {
    const vol = await makeVolume({ "outer/inner/a.txt": "x" });
    const response = await vol.GET(
      `cmd=paste&cut=1&dst=${hashOf("outer/inner")}&targets[]=${hashOf("outer")}`,
    );

    expect(await errorOf(response)).toEqual(["errCopyInItself"]);
    expect(await vol.read("outer/inner/a.txt")).toBe("x");
  });

  it("still allows a paste into a sibling", async () => {
    const vol = await makeVolume({ "outer/a.txt": "x", "sibling/": "" });
    const response = await vol.GET(
      `cmd=paste&dst=${hashOf("sibling")}&targets[]=${hashOf("outer")}`,
    );

    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("sibling/outer/a.txt")).toBe("x");
  });
});

describe("duplicate numbers its copies (item 23)", () => {
  it("can duplicate the same file repeatedly", async () => {
    const vol = await makeVolume({ "notes.txt": "body" });
    const target = hashOf("notes.txt");

    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const body = await json(await vol.GET(`cmd=duplicate&targets[]=${target}`));
      expect(body.error, `duplicate ${i + 1}`).toBeUndefined();
      names.push(body.added[0].name);
    }

    expect(names).toEqual(["notes(copy).txt", "notes(copy 2).txt", "notes(copy 3).txt"]);
    expect(await vol.read("notes(copy 3).txt")).toBe("body");
  });

  it("duplicates a folder too", async () => {
    const vol = await makeVolume({ "gallery/a.txt": "x" });
    const body = await json(await vol.GET(`cmd=duplicate&targets[]=${hashOf("gallery")}`));

    expect(body.added[0].name).toBe("gallery(copy)");
    expect(await vol.read("gallery(copy)/a.txt")).toBe("x");
  });
});

describe("extract reports only what it produced (item 24)", () => {
  it("does not list pre-existing siblings as newly added", async () => {
    const vol = await makeVolume({
      "sub/existing-1.txt": "x",
      "sub/existing-2.txt": "x",
      "sub/payload.zip": buildZip([{ name: "fresh.txt", data: Buffer.from("new") }]),
    });
    const body = await json(await vol.GET(`cmd=extract&target=${hashOf("sub/payload.zip")}`));

    expect(body.added.map((f: any) => f.name)).toEqual(["fresh.txt"]);
  });

  it("reports a nested archive's top-level folder once", async () => {
    const vol = await makeVolume({
      "sub/payload.zip": buildZip([
        { name: "bundle/one.txt", data: Buffer.from("1") },
        { name: "bundle/two.txt", data: Buffer.from("2") },
      ]),
    });
    const body = await json(await vol.GET(`cmd=extract&target=${hashOf("sub/payload.zip")}`));

    expect(body.added.map((f: any) => f.name)).toEqual(["bundle"]);
  });
});

describe("chunked upload completes on bytes, not offset (item 26)", () => {
  /** Uploads one slice of a three-slice file. */
  function slice(index: number, body: string, total: number) {
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.set("chunk", `movie.bin.${index}_2.part`);
    form.set("cid", "42");
    form.set("range", `${index * body.length},${body.length},${total}`);
    form.append("upload[]", new File([body], "blob"), "blob");
    return form;
  }

  it("does not merge when the last slice arrives first", async () => {
    const vol = await makeVolume();
    // Offset 8 plus length 4 reaches the declared total, which is what the old check
    // looked at. Only 4 of 12 bytes are actually present.
    const response = await vol.POST(slice(2, "CCCC", 12));

    const body = await json(response);
    expect(body.added).toEqual([]);
    expect(await vol.exists("movie.bin")).toBe(false);
  });

  /**
   * The merge request the client sends on seeing `_chunkmerged`. `upload[]` carries
   * the name string it was given, not another slice.
   */
  function mergeRequest(chunkmerged: string, name: string) {
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.set("chunk", chunkmerged);
    form.set("cid", "42");
    form.append("upload[]", name);
    return form;
  }

  it("reports completion once every slice has landed, without merging yet", async () => {
    const vol = await makeVolume();
    await vol.POST(slice(2, "CCCC", 12));
    await vol.POST(slice(0, "AAAA", 12));
    const body = await json(await vol.POST(slice(1, "BBBB", 12)));

    // The protocol is explicit that these two appear only when every chunk has
    // arrived, and that the merge happens on the request the client sends next.
    expect(body.added).toEqual([]);
    expect(body._chunkmerged).toBe("movie.bin");
    expect(body._name).toBe("movie.bin");
    expect(await vol.exists("movie.bin")).toBe(false);
  });

  it("stays silent about completion on an intermediate slice", async () => {
    const vol = await makeVolume();
    const body = await json(await vol.POST(slice(0, "AAAA", 12)));

    expect(body).toEqual({ added: [] });
  });

  it("merges in offset order on the follow-up request", async () => {
    const vol = await makeVolume();
    for (const [index, chunk] of [
      [2, "CCCC"],
      [0, "AAAA"],
      [1, "BBBB"],
    ] as const) {
      await vol.POST(slice(index, chunk, 12));
    }

    const body = await json(await vol.POST(mergeRequest("movie.bin", "movie.bin")));

    expect(body.added?.[0]?.name).toBe("movie.bin");
    expect(await vol.read("movie.bin")).toBe("AAAABBBBCCCC");
  });

  it("clears the staging directory after merging", async () => {
    const vol = await makeVolume();
    for (const index of [0, 1, 2]) {
      await vol.POST(slice(index, "XXXX", 12));
    }
    await vol.POST(mergeRequest("movie.bin", "movie.bin"));

    const left = await fs.readdir(path.join(vol.uploadDir, ".chunks")).catch(() => []);
    expect(left).toEqual([]);
  });

  it("finds the parts even when the merge request omits cid", async () => {
    // The protocol only promises `chunk` and `upload[]` on this request, so losing cid
    // must not lose the upload.
    const vol = await makeVolume();
    for (const index of [0, 1, 2]) {
      await vol.POST(slice(index, "YYYY", 12));
    }

    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.set("chunk", "movie.bin");
    form.append("upload[]", "movie.bin");

    const body = await json(await vol.POST(form));
    expect(body.added?.[0]?.name).toBe("movie.bin");
    expect(await vol.read("movie.bin")).toBe("YYYYYYYYYYYY");
  });

  it("refuses a merge request for parts that do not exist", async () => {
    const vol = await makeVolume();
    expect(await errorOf(await vol.POST(mergeRequest("ghost.bin", "ghost.bin")))).toEqual([
      "errUploadTemp",
    ]);
  });
});

describe("zipdl downloads in two phases (item 19)", () => {
  it("stages the archive outside the volume's visible contents", async () => {
    const vol = await makeVolume({ "docs/a.txt": "A", "docs/b.txt": "B" });
    const body = await json(
      await vol.GET(
        `cmd=zipdl&targets[]=${hashOf("docs/a.txt")}&targets[]=${hashOf("docs/b.txt")}`,
      ),
    );

    expect(body.zipdl.mime).toBe("application/zip");
    expect(body.zipdl.name).toBe("docs.zip");

    // The old implementation wrote the archive into the user's own folder, where it
    // stayed as litter and showed up in listings.
    const listing = await json(await vol.GET(`cmd=open&target=${hashOf("docs")}`));
    expect(listing.files.map((f: any) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("serves the archive on the second request and then drops it", async () => {
    const vol = await makeVolume({ "docs/a.txt": "A", "docs/b.txt": "B" });
    const phase1 = await json(
      await vol.GET(
        `cmd=zipdl&targets[]=${hashOf("docs/a.txt")}&targets[]=${hashOf("docs/b.txt")}`,
      ),
    );
    const { file, name } = phase1.zipdl;

    const response = await vol.GET(
      `cmd=zipdl&download=1&targets[]=${hashOf("docs")}&targets[]=${file}` +
        `&targets[]=${encodeURIComponent(name)}&targets[]=application/zip`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);

    const bytes = Buffer.from(await response.arrayBuffer());
    const entries = new AdmZip(bytes).getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses an id that was never issued", async () => {
    const vol = await makeVolume({ "docs/a.txt": "A" });
    const response = await vol.GET(
      `cmd=zipdl&download=1&targets[]=${hashOf("docs")}` +
        `&targets[]=00000000-0000-0000-0000-000000000000&targets[]=x.zip&targets[]=application/zip`,
    );

    expect(await errorOf(response)).toEqual(["errFileNotFound"]);
  });

  it("refuses an id shaped like a path", async () => {
    const vol = await makeVolume({ "docs/a.txt": "A", "secret.txt": "s" });
    const response = await vol.GET(
      `cmd=zipdl&download=1&targets[]=${hashOf("docs")}` +
        `&targets[]=${encodeURIComponent("../../secret")}&targets[]=x.zip&targets[]=application/zip`,
    );

    expect(await errorOf(response)).toEqual(["errFileNotFound"]);
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("needs only read access on the sources", async () => {
    // It writes nothing into the volume, so it must not demand write on a folder the
    // caller may only read.
    const vol = await makeVolume(
      { "docs/a.txt": "A" },
      { permissions: () => ({ write: false }) },
    );
    const body = await json(await vol.GET(`cmd=zipdl&targets[]=${hashOf("docs/a.txt")}`));

    expect(body.error).toBeUndefined();
    expect(body.zipdl.file).toBeDefined();
  });
});

describe("open with tree=1 fills the navigation pane (item 27)", () => {
  it("includes the root and the folders beside the current one", async () => {
    const vol = await makeVolume({
      "alpha/deep/a.txt": "x",
      "beta/b.txt": "x",
      "gamma/": "",
    });
    const body = await json(await vol.GET(`cmd=open&tree=1&target=${hashOf("alpha/deep")}`));
    const names = body.files.map((f: any) => f.name);

    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
    expect(names).toContain("uploads");
  });

  it("returns only the directory's own contents without tree=1", async () => {
    const vol = await makeVolume({ "alpha/deep/a.txt": "x", "beta/b.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&target=${hashOf("alpha/deep")}`));

    expect(body.files.map((f: any) => f.name)).toEqual(["a.txt"]);
  });

  it("does not duplicate an entry that is already listed", async () => {
    const vol = await makeVolume({ "alpha/inner/": "", "beta/": "" });
    const body = await json(await vol.GET(`cmd=open&tree=1&target=${hashOf("alpha")}`));
    const hashes = body.files.map((f: any) => f.hash);

    expect(hashes.length).toBe(new Set(hashes).size);
  });
});

describe("cmd=get refuses to mangle a binary file (item 30)", () => {
  it("reports non-UTF-8 content instead of returning replacement characters", async () => {
    // Saving the editor's view of such a file back to disk destroys it.
    const vol = await makeVolume({ "logo.bin": Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x99]) });
    const response = await vol.GET(`cmd=get&target=${hashOf("logo.bin")}`);

    expect(await errorOf(response)).toEqual(["errNotUTF8Content"]);
  });

  it("returns it anyway when the client asks with conv", async () => {
    const vol = await makeVolume({ "logo.bin": Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x99]) });
    const body = await json(await vol.GET(`cmd=get&target=${hashOf("logo.bin")}&conv=1`));

    expect(body.error).toBeUndefined();
    expect(typeof body.content).toBe("string");
  });

  it("still serves ordinary text, including non-ASCII", async () => {
    const vol = await makeVolume({ "notes.txt": "türkçe içerik — ağ" });
    const body = await json(await vol.GET(`cmd=get&target=${hashOf("notes.txt")}`));

    expect(body.content).toBe("türkçe içerik — ağ");
  });
});
