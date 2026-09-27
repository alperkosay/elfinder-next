import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { ROOT_HASH, hashOf, json, makeVolume } from "./helpers.js";

let png: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
});

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
    const vol = await makeVolume({ "a.png": png, "b.png": png });
    await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`);

    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f.tmb]));

    expect(byName["a.png"]).toMatch(/\.png$/);
    expect(byName["b.png"]).toBe("1");
  });

  it("produces a thumbnail no larger than 48px on its longest side", async () => {
    const vol = await makeVolume({ "a.png": png });
    const body = await json(await vol.GET(`cmd=tmb&targets[]=${hashOf("a.png")}`));
    const thumbName = body.images[hashOf("a.png")];

    const meta = await sharp(path.join(vol.uploadDir, ".tmb", thumbName)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(48);
  });

  it("reuses an existing thumbnail rather than rewriting it", async () => {
    const vol = await makeVolume({ "a.png": png });
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

describe("deleting a file removes its thumbnail", () => {
  it("drops the thumbnail when the file itself is removed", async () => {
    const vol = await makeVolume({ "a.png": png });
    const target = hashOf("a.png");
    await vol.GET(`cmd=tmb&targets[]=${target}`);
    expect(await thumbCount(vol.uploadDir)).toBe(1);

    await vol.GET(`cmd=rm&targets[]=${target}`);
    expect(await thumbCount(vol.uploadDir)).toBe(0);
  });

  it("leaves thumbnails behind for images inside a deleted folder", async () => {
    // Known gap, REVIEW.md item 11: only the named target's thumbnail is removed,
    // so deleting a folder orphans the thumbnails of everything inside it. This
    // test pins the current behaviour so the fix has something to flip.
    const vol = await makeVolume({ "gallery/a.png": png, "gallery/b.png": png });
    await vol.GET(
      `cmd=tmb&targets[]=${hashOf("gallery/a.png")}&targets[]=${hashOf("gallery/b.png")}`,
    );
    expect(await thumbCount(vol.uploadDir)).toBe(2);

    await vol.GET(`cmd=rm&targets[]=${hashOf("gallery")}`);
    expect(await thumbCount(vol.uploadDir)).toBe(2);
  });
});
