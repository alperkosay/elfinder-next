import { describe, expect, it } from "vitest";
import { ROOT_HASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";

describe("cmd=open", () => {
  it("announces the API version and the root on init", async () => {
    const vol = await makeVolume({ "a.txt": "hello" });
    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));

    expect(body.api).toBe("2.1");
    expect(body.cwd.hash).toBe(ROOT_HASH);
    expect(body.cwd.mime).toBe("directory");
    expect(body.files.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(["uploads", "a.txt"]),
    );
  });

  it("omits the API version on a plain open", async () => {
    const vol = await makeVolume();
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    expect(body.api).toBeUndefined();
  });

  it("falls back to the root when the target no longer exists", async () => {
    // elFinder restores the last directory from localStorage, which may have been
    // deleted in the meantime.
    const vol = await makeVolume({ "a.txt": "x" });
    const body = await json(await vol.GET(`cmd=open&target=${hashOf("gone")}`));

    expect(body.error).toBeUndefined();
    expect(body.cwd.hash).toBe(ROOT_HASH);
  });

  it("marks a folder containing subfolders with dirs=1", async () => {
    const vol = await makeVolume({ "parent/child/": "", "lonely/": "" });
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f]));

    expect(byName.parent.dirs).toBe(1);
    expect(byName.lonely.dirs).toBeUndefined();
  });
});

describe("folder and file creation", () => {
  it("creates a folder and reports it", async () => {
    const vol = await makeVolume();
    const body = await json(await vol.GET(`cmd=mkdir&target=${ROOT_HASH}&name=Photos`));

    expect(body.added?.[0]?.mime).toBe("directory");
    expect(await vol.exists("Photos")).toBe(true);
  });

  it("refuses a folder name already in use", async () => {
    const vol = await makeVolume({ "Photos/": "" });
    expect(await errorOf(await vol.GET(`cmd=mkdir&target=${ROOT_HASH}&name=Photos`))).toEqual(
      ["errExists"],
    );
  });

  it("creates an empty file", async () => {
    const vol = await makeVolume();
    const body = await json(await vol.GET(`cmd=mkfile&target=${ROOT_HASH}&name=notes.txt`));

    expect(body.added?.[0]?.name).toBe("notes.txt");
    expect(await vol.read("notes.txt")).toBe("");
  });
});

describe("text content round-trip", () => {
  it("reads a file with cmd=get and writes it back with cmd=put", async () => {
    const vol = await makeVolume({ "notes.txt": "before" });
    const target = hashOf("notes.txt");

    expect((await json(await vol.GET(`cmd=get&target=${target}`))).content).toBe("before");

    const put = await json(await vol.GET(`cmd=put&target=${target}&content=after`));
    expect(put.changed?.[0]?.name).toBe("notes.txt");
    expect(await vol.read("notes.txt")).toBe("after");
  });
});

describe("cmd=rm", () => {
  it("removes files and folders recursively", async () => {
    const vol = await makeVolume({ "gallery/deep/a.txt": "x", "b.txt": "y" });
    const body = await json(
      await vol.GET(`cmd=rm&targets[]=${hashOf("gallery")}&targets[]=${hashOf("b.txt")}`),
    );

    expect(body.removed).toHaveLength(2);
    expect(await vol.exists("gallery")).toBe(false);
    expect(await vol.exists("b.txt")).toBe(false);
  });

  it("ignores the volume root rather than deleting it", async () => {
    const vol = await makeVolume({ "a.txt": "x" });
    await vol.GET(`cmd=rm&targets[]=${ROOT_HASH}`);
    expect(await vol.exists("a.txt")).toBe(true);
  });
});

describe("uploads", () => {
  it("accepts a plain multipart upload", async () => {
    const vol = await makeVolume();
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["contents"], "doc.txt"), "doc.txt");

    const body = await json(await vol.POST(form));
    expect(body.added?.[0]?.name).toBe("doc.txt");
    expect(await vol.read("doc.txt")).toBe("contents");
  });

  it("creates the subdirectories named by upload_path", async () => {
    const vol = await makeVolume();
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["leaf"], "leaf.txt"), "leaf.txt");
    form.append("upload_path[]", "outer/inner/leaf.txt");

    await vol.POST(form);
    expect(await vol.read("outer/inner/leaf.txt")).toBe("leaf");
  });
});

describe("error envelope (items 5 and 20)", () => {
  it("answers HTTP 200 so the client reads the error instead of reporting errConnect", async () => {
    const vol = await makeVolume();
    const response = await vol.GET("cmd=nosuchcommand");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: ["errUnknownCmd"] });
  });

  it("uses message keys rather than prose, and never leaks a filesystem path", async () => {
    const vol = await makeVolume();
    const response = await vol.GET(`cmd=get&target=${hashOf("missing.txt")}`);
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.error).toEqual(["errFileNotFound"]);
    expect(JSON.stringify(body)).not.toContain(vol.uploadDir);
  });

  it("reports an unsupported command without a 4xx", async () => {
    const vol = await makeVolume({ "a.png": "x" });
    const response = await vol.GET(`cmd=resize&target=${hashOf("a.png")}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: ["errCmdNoSupport"] });
  });
});
