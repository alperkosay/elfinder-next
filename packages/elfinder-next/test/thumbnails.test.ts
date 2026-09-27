import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { createElfinderHandler } from "../src/index.js";
import { ROOT_HASH, hashOf, json, makeVolume } from "./helpers.js";

let png: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
});

/**
 * A static thumbnail prefix, under which `tmb` carries the bare filename. Used by the
 * tests that inspect the naming scheme; the default mode wraps the name in a
 * connector URL instead.
 */
const STATIC = { tmbUrl: "/uploads/.tmb/" };

/** Number of files sitting in the volume's thumbnail directory. */
async function thumbCount(uploadDir: string): Promise<number> {
  return (await fs.readdir(path.join(uploadDir, ".tmb")).catch(() => [])).length;
}

describe("listing a directory does not generate thumbnails (item 9)", () => {
  it("reports tmb=1 for every image and writes nothing", async () => {
    const tree = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`img${i}.png`, png]),
    );
    const vol = await makeVolume(tree);

    const body = await json(await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`));
    const images = body.files.filter((f: any) => f.mime === "image/png");

    expect(images).toHaveLength(12);
    // "1" means "a thumbnail is possible but not ready", which is what makes
    // elFinder fetch them in batches through cmd=tmb.
    expect(images.every((f: any) => f.tmb === "1")).toBe(true);
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });

  it("hides the .tmb and .chunks directories from listings", async () => {
    const vol = await makeVolume({ "a.txt": "x" });
    await vol.GET(`cmd=open&target=${ROOT_HASH}`); // creates .tmb and .chunks
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const names = body.files.map((f: any) => f.name);

    expect(names).toContain("a.txt");
    expect(names).not.toContain(".tmb");
    expect(names).not.toContain(".chunks");
  });
});

describe("cmd=tmb generates thumbnails on demand (item 9)", () => {
  it("generates only the requested targets", async () => {
    const vol = await makeVolume({ "a.png": png, "b.png": png, "c.png": png });

    const body = await json(
      await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}&targets[]=${hashOf("b.png")}`),
    );

    expect(Object.keys(body.images ?? {})).toHaveLength(2);
    expect(await thumbCount(vol.uploadDir)).toBe(2);
  });

  it("reports the generated thumbnail on the next listing", async () => {
    const vol = await makeVolume({ "a.png": png, "b.png": png }, STATIC);
    await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`);

    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f.tmb]));

    expect(byName["a.png"]).toMatch(/\.png$/);
    expect(byName["b.png"]).toBe("1");
  });

  it("produces a thumbnail no larger than 48px on its longest side", async () => {
    const vol = await makeVolume({ "a.png": png }, STATIC);
    const body = await json(await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`));
    const thumbName = body.images[hashOf("a.png")];

    const meta = await sharp(path.join(vol.uploadDir, ".tmb", thumbName)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(48);
  });

  it("reuses an existing thumbnail rather than rewriting it", async () => {
    const vol = await makeVolume({ "a.png": png }, STATIC);
    const target = hashOf("a.png");
    const first = await json(await vol.GET(`cmd=tmb&targets[]=${target}`));
    const thumbPath = path.join(vol.uploadDir, ".tmb", first.images[target]);
    const firstStat = await fs.stat(thumbPath);

    await vol.GET(`cmd=tmb&targets[]=${target}`);
    const secondStat = await fs.stat(thumbPath);

    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("does not fail the request for a non-image target", async () => {
    const vol = await makeVolume({ "notes.txt": "hello" });
    const body = await json(await vol.GET(`cmd=tmb&targets[]=${hashOf("notes.txt")}`));

    expect(body.error).toBeUndefined();
    expect(body.images).toEqual({});
  });
});

describe("thumbnails without a tmbUrl are served by the connector (item 44)", () => {
  /** The query string of a connector URL, in the form `vol.GET` takes. */
  const queryOf = (url: string) => url.slice(url.indexOf("?") + 1);

  it("hands out a connector URL that serves the thumbnail", async () => {
    const vol = await makeVolume({ "a.png": png });
    const target = hashOf("a.png");
    const body = await json(await vol.GET(`cmd=tmb&targets[]=${target}`));
    const url: string = body.images[target];

    // The 2.1 client uses tmb verbatim when tmbUrl is empty, so a bare filename
    // would resolve against the page and 404.
    expect(url).toBe(`/api/elfinder?cmd=file&target=${target}&thumb=1`);

    const response = await vol.GET(queryOf(url));
    expect(response.headers.get("content-type")).toBe("image/png");
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(48);
  });

  it("reports the same URL on the next listing", async () => {
    const vol = await makeVolume({ "a.png": png });
    const target = hashOf("a.png");
    const generated = (await json(await vol.GET(`cmd=tmb&targets[]=${target}`))).images[target];

    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    expect(body.files.find((f: any) => f.name === "a.png").tmb).toBe(generated);
  });

  it("includes the basePath", async () => {
    const vol = await makeVolume({ "a.png": png });
    const handlers = createElfinderHandler({ uploadDir: vol.uploadDir });
    const request = new NextRequest(
      `http://localhost/app/api/elfinder?cmd=tmb&targets[]=${hashOf("a.png")}`,
      { nextConfig: { basePath: "/app" } },
    );

    const body = await json((await handlers.GET(request)) as unknown as Response);
    expect(body.images[hashOf("a.png")]).toMatch(/^\/app\/api\/elfinder\?/);
  });

  it("gates the thumbnail on read access to the source", async () => {
    let denied = false;
    const vol = await makeVolume(
      { "a.png": png },
      { permissions: (p) => ({ read: !(denied && p === "a.png") }) },
    );
    const target = hashOf("a.png");
    const url = (await json(await vol.GET(`cmd=tmb&targets[]=${target}`))).images[target];

    denied = true;
    expect(await json(await vol.GET(queryOf(url)))).toEqual({ error: ["errAccess"] });
  });

  it("does not generate a thumbnail when asked for one that does not exist", async () => {
    // Generation belongs to cmd=tmb; a plain GET should not be a way to run sharp.
    const vol = await makeVolume({ "a.png": png });
    const response = await vol.GET(`cmd=file&target=${hashOf("a.png")}&thumb=1`);

    expect(await json(response)).toEqual({ error: ["errFileNotFound"] });
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });
});

describe("a replaced file gets a fresh thumbnail (item 10)", () => {
  it("changes the thumbnail name when the source contents change", async () => {
    const vol = await makeVolume({ "a.png": png }, STATIC);
    const target = hashOf("a.png");

    const first = (await json(await vol.GET(`cmd=tmb&targets[]=${target}`))).images[target];

    // Same path, different image. The old scheme keyed thumbnails by path alone
    // and served the stale one forever.
    const replacement = await sharp({
      create: { width: 120, height: 90, channels: 3, background: { r: 200, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await fs.writeFile(vol.at("a.png"), replacement);
    // Some filesystems have coarse mtime granularity; make the change unambiguous.
    const future = new Date(Date.now() + 2000);
    await fs.utimes(vol.at("a.png"), future, future);

    const second = (await json(await vol.GET(`cmd=tmb&targets[]=${target}`))).images[target];

    expect(second).not.toBe(first);
    const meta = await sharp(path.join(vol.uploadDir, ".tmb", second)).metadata();
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(120 / 90, 1);
  });

  it("reports the stale thumbnail as pending rather than serving it", async () => {
    const vol = await makeVolume({ "a.png": png });
    await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`);

    await fs.writeFile(vol.at("a.png"), Buffer.concat([png, Buffer.alloc(16)]));
    const future = new Date(Date.now() + 2000);
    await fs.utimes(vol.at("a.png"), future, future);

    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const entry = body.files.find((f: any) => f.name === "a.png");
    expect(entry.tmb).toBe("1");
  });

  it("does not accumulate a thumbnail per edit", async () => {
    const vol = await makeVolume({ "a.png": png });
    const target = hashOf("a.png");

    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(vol.at("a.png"), Buffer.concat([png, Buffer.alloc(i)]));
      const future = new Date(Date.now() + i * 2000);
      await fs.utimes(vol.at("a.png"), future, future);
      await vol.GET(`cmd=tmb&targets[]=${target}`);
    }

    expect(await thumbCount(vol.uploadDir)).toBe(1);
  });

  it("keeps thumbnail filenames short for a deeply nested path", async () => {
    // The old scheme embedded the base64 path, which grows without bound and can
    // overrun the 255-byte filename limit.
    const deep = Array.from({ length: 20 }, (_, i) => `level-${i}-with-a-longish-name`).join("/");
    const vol = await makeVolume({ [`${deep}/a.png`]: png }, STATIC);
    const target = hashOf(`${deep}/a.png`);

    const body = await json(await vol.GET(`cmd=tmb&targets[]=${target}`));
    expect(body.images[target]).toBeDefined();
    expect(body.images[target].length).toBeLessThan(64);
  });
});

describe("abandoned chunk directories are swept (item 13)", () => {
  /** Sends one non-final chunk, which leaves its part on disk. */
  async function startUpload(vol: Awaited<ReturnType<typeof makeVolume>>, cid: string) {
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.set("chunk", `big.bin.0_9.part`);
    form.set("cid", cid);
    form.set("range", "0,4,9999");
    form.append("upload[]", new File(["PART"], "blob"), "blob");
    return vol.POST(form);
  }

  const chunkDirs = async (uploadDir: string) =>
    (await fs.readdir(path.join(uploadDir, ".chunks")).catch(() => [])).sort();

  it("keeps parts that are still within the TTL", async () => {
    const vol = await makeVolume({}, { chunkTtlMs: 60_000 });
    await startUpload(vol, "alpha");
    expect(await chunkDirs(vol.uploadDir)).toEqual(["alpha"]);

    // A second upload triggers another sweep; the first is still fresh.
    await startUpload(vol, "beta");
    expect(await chunkDirs(vol.uploadDir)).toEqual(["alpha", "beta"]);
  });

  it("removes parts left behind beyond the TTL", async () => {
    const vol = await makeVolume({}, { chunkTtlMs: 50 });
    await startUpload(vol, "abandoned");
    expect(await chunkDirs(vol.uploadDir)).toEqual(["abandoned"]);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // The next upload sweeps the stale directory before writing its own.
    await startUpload(vol, "current");
    expect(await chunkDirs(vol.uploadDir)).toEqual(["current"]);
  });

  it("leaves the chunk directory itself in place", async () => {
    const vol = await makeVolume({}, { chunkTtlMs: 50 });
    await startUpload(vol, "gone");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await startUpload(vol, "kept");

    expect(await vol.exists(".chunks")).toBe(true);
  });
});

describe("deleting a file removes its thumbnail", () => {
  it("drops the thumbnail when the file itself is removed", async () => {
    const vol = await makeVolume({ "a.png": png });
    const target = hashOf("a.png");
    await vol.GET(`cmd=tmb&targets[]=${target}`);
    expect(await thumbCount(vol.uploadDir)).toBe(1);

    await vol.GET(`cmd=rm&targets[]=${target}`);
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });

  it("drops the thumbnails of images inside a deleted folder (item 11)", async () => {
    const vol = await makeVolume({
      "gallery/a.png": png,
      "gallery/nested/b.png": png,
      "keep.png": png,
    });
    await vol.GET(
      `cmd=tmb&targets[]=${hashOf("gallery/a.png")}` +
        `&targets[]=${hashOf("gallery/nested/b.png")}&targets[]=${hashOf("keep.png")}`,
    );
    expect(await thumbCount(vol.uploadDir)).toBe(3);

    await vol.GET(`cmd=rm&targets[]=${hashOf("gallery")}`);

    // Only the thumbnail for the file that survived should remain.
    expect(await thumbCount(vol.uploadDir)).toBe(1);
  });

  it("drops the old thumbnail when a file is renamed", async () => {
    const vol = await makeVolume({ "a.png": png });
    await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`);
    expect(await thumbCount(vol.uploadDir)).toBe(1);

    await vol.GET(`cmd=rename&target=${hashOf("a.png")}&name=b.png`);

    // Keyed by path, so the old name's thumbnail is now unreachable.
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });

  it("drops the old thumbnails when a folder is moved", async () => {
    const vol = await makeVolume({ "gallery/a.png": png, "dest/": "" });
    await vol.GET(`cmd=tmb&targets[]=${hashOf("gallery/a.png")}`);
    expect(await thumbCount(vol.uploadDir)).toBe(1);

    await vol.GET(
      `cmd=paste&cut=1&dst=${hashOf("dest")}&targets[]=${hashOf("gallery")}`,
    );
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });
});
