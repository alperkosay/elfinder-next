import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKSLASH, ROOT_HASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";

/**
 * Builds the multipart body for one chunk of a chunked upload.
 *
 * `total` is deliberately larger than the chunk by default, which keeps this a
 * NON-final chunk. That matters: the merge step deletes the part files it
 * consumes, so a final chunk would erase the very file a traversal test is
 * looking for.
 */
function chunkUpload(options: {
  target?: string;
  chunk: string;
  cid?: string;
  total?: number;
  body?: string;
}): FormData {
  const body = options.body ?? "PWND";
  const form = new FormData();
  form.set("cmd", "upload");
  form.set("target", options.target ?? ROOT_HASH);
  form.set("chunk", options.chunk);
  if (options.cid !== undefined) {
    form.set("cid", options.cid);
  }
  form.set("range", `0,${body.length},${options.total ?? 999}`);
  form.append("upload[]", new File([body], "x.bin"), "x.bin");
  return form;
}

describe("chunked upload cannot write outside the volume (item 1)", () => {
  it("refuses a cid that climbs out of the chunk directory", async () => {
    const vol = await makeVolume();
    // .chunks lives at <volume>/.chunks/<cid>, so three levels up is the sandbox.
    await vol.POST(chunkUpload({ chunk: "x.bin.0_2.part", cid: "../../.." }));
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("refuses a chunk name using backslash separators", async () => {
    const vol = await makeVolume();
    // path.posix.basename does not treat "\" as a separator, so this vector
    // survived basename intact and was then split apart by path.resolve.
    const vector = ["..", "..", "..", "ESCAPED.txt.0_2.part"].join(BACKSLASH);
    await vol.POST(chunkUpload({ chunk: vector, cid: "1" }));
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("refuses a chunk name using forward slashes", async () => {
    const vol = await makeVolume();
    await vol.POST(chunkUpload({ chunk: "../../../ESCAPED.txt.0_2.part", cid: "1" }));
    expect(await vol.strayFiles()).toEqual([]);
  });

  it("rejects a chunk name that reduces to nothing", async () => {
    const vol = await makeVolume();
    const response = await vol.POST(chunkUpload({ chunk: "..", cid: "1" }));
    expect(await errorOf(response)).toEqual(["errInvName"]);
  });

  it("still accepts an ordinary chunked upload", async () => {
    const vol = await makeVolume();
    // A single chunk whose range covers the whole file is the final chunk, so the
    // connector merges it immediately. elFinder sends the slice as "blob", which
    // the filename heuristic skips in favour of the name encoded in `chunk`.
    const form = chunkUpload({ chunk: "report.pdf.0_0.part", cid: "7", total: 4 });
    form.set("upload[]", new File(["PWND"], "blob"), "blob");
    const body = await json(await vol.POST(form));
    expect(body.error).toBeUndefined();
    expect(body.added?.[0]?.name).toBe("report.pdf");
    expect(await vol.read("report.pdf")).toBe("PWND");
  });
});

describe("symlinks cannot leave the volume (item 6)", () => {
  /**
   * Windows refuses a true directory symlink without elevation, but allows a
   * junction, which realpath resolves the same way. Whichever the platform
   * permits is enough to exercise the check.
   */
  async function linkOutOfVolume(uploadDir: string, target: string): Promise<boolean> {
    for (const type of ["junction", "dir"] as const) {
      try {
        await fs.symlink(target, path.join(uploadDir, "escape"), type);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  it("refuses to list, read or write through a link pointing outside", async () => {
    const vol = await makeVolume();
    const secret = path.join(vol.sandbox, "secret");
    await fs.mkdir(secret, { recursive: true });
    await fs.writeFile(path.join(secret, "passwd.txt"), "TOP-SECRET");

    if (!(await linkOutOfVolume(vol.uploadDir, secret))) {
      // No link type available on this platform and privilege level.
      return;
    }

    expect(await errorOf(await vol.GET(`cmd=open&target=${hashOf("escape")}`))).toEqual([
      "errAccess",
    ]);
    expect(
      await errorOf(await vol.GET(`cmd=get&target=${hashOf("escape/passwd.txt")}`)),
    ).toEqual(["errAccess"]);
    expect(
      await errorOf(
        await vol.GET(`cmd=mkfile&target=${hashOf("escape")}&name=planted.txt`),
      ),
    ).toEqual(["errAccess"]);

    await expect(fs.access(path.join(secret, "planted.txt"))).rejects.toThrow();
  });

  it("still serves a volume root that is itself a link", async () => {
    // A symlinked root is an ordinary deployment: public/uploads pointing at a
    // mounted volume. Containment is judged against the resolved root.
    const vol = await makeVolume();
    const store = path.join(vol.sandbox, "store");
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, "hello.txt"), "hi");

    const linkedRoot = path.join(vol.sandbox, "linked-volume");
    let linked = false;
    for (const type of ["junction", "dir"] as const) {
      try {
        await fs.symlink(store, linkedRoot, type);
        linked = true;
        break;
      } catch {
        continue;
      }
    }
    if (!linked) {
      return;
    }

    const { createElfinderHandler } = await import("../src/index.js");
    const { NextRequest } = await import("next/server");
    const { GET } = createElfinderHandler({ uploadDir: linkedRoot });
    const response = (await GET(
      new NextRequest(`http://localhost/api/elfinder?cmd=open&target=${ROOT_HASH}`),
    )) as unknown as Response;

    const body = await json(response);
    expect(body.error).toBeUndefined();
    expect(body.files.map((f: any) => f.name)).toContain("hello.txt");
  });
});

describe("path traversal through ordinary parameters", () => {
  it("cannot escape with dot segments in a folder name", async () => {
    const vol = await makeVolume({ "sub/": "" });
    await vol.GET(`cmd=mkdir&target=${hashOf("sub")}&name=../../escaped`);
    expect(await vol.strayFiles()).toEqual([]);
    await expect(fs.access(path.join(vol.sandbox, "escaped"))).rejects.toThrow();
  });

  it("cannot escape with an absolute upload path", async () => {
    const vol = await makeVolume();
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["x"], "ok.txt"), "ok.txt");
    form.append("upload_path[]", "/etc/passwd");
    await vol.POST(form);
    expect(await vol.strayFiles()).toEqual([]);
  });
});
