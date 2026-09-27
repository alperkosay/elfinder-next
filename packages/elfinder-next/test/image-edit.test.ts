import fs from "node:fs/promises";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { errorOf, hashOf, json, makeVolume } from "./helpers.js";

let png: Buffer;
let jpeg: Buffer;

beforeAll(async () => {
  const create = { width: 300, height: 200, channels: 3 as const, background: "#08c" };
  png = await sharp({ create }).png().toBuffer();
  jpeg = await sharp({ create }).jpeg().toBuffer();
});

/** Dimensions and format of the image on disk. */
async function imageAt(vol: Awaited<ReturnType<typeof makeVolume>>, name: string) {
  const meta = await sharp(await fs.readFile(vol.at(name))).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

describe("dim reports an image's dimensions (item 34)", () => {
  it("answers WIDTHxHEIGHT", async () => {
    const vol = await makeVolume({ "a.png": png });
    const body = await json(await vol.GET(`cmd=dim&target=${hashOf("a.png")}`));
    expect(body).toEqual({ dim: "300x200" });
  });

  it("refuses a file that is not an image", async () => {
    const vol = await makeVolume({ "a.txt": "text" });
    expect(await errorOf(await vol.GET(`cmd=dim&target=${hashOf("a.txt")}`))).toEqual([
      "errUsupportType",
    ]);
  });

  it("needs read access", async () => {
    const vol = await makeVolume({ "a.png": png }, { permissions: () => ({ read: false }) });
    expect(await errorOf(await vol.GET(`cmd=dim&target=${hashOf("a.png")}`))).toEqual([
      "errAccess",
    ]);
  });
});

describe("resize edits an image in place (item 34)", () => {
  const resize = (vol: Awaited<ReturnType<typeof makeVolume>>, name: string, query: string) =>
    vol.GET(`cmd=resize&target=${hashOf(name)}&${query}`);

  it("resizes to the requested box and reports the file as changed", async () => {
    const vol = await makeVolume({ "a.png": png });
    const body = await json(await resize(vol, "a.png", "mode=resize&width=150&height=100"));

    expect(body.changed).toHaveLength(1);
    expect(body.changed[0].hash).toBe(hashOf("a.png"));
    expect(await imageAt(vol, "a.png")).toEqual({ width: 150, height: 100, format: "png" });
  });

  it("crops at the given offset", async () => {
    const vol = await makeVolume({ "a.png": png });
    await resize(vol, "a.png", "mode=crop&width=50&height=40&x=10&y=20");
    expect(await imageAt(vol, "a.png")).toMatchObject({ width: 50, height: 40 });
  });

  it("rotates, swapping the sides at 90 degrees", async () => {
    const vol = await makeVolume({ "a.png": png });
    await resize(vol, "a.png", "mode=rotate&degree=90");
    expect(await imageAt(vol, "a.png")).toMatchObject({ width: 200, height: 300 });
  });

  it("keeps the format, including JPEG", async () => {
    const vol = await makeVolume({ "a.jpg": jpeg });
    await resize(vol, "a.jpg", "mode=resize&width=30&height=20&quality=60");
    expect(await imageAt(vol, "a.jpg")).toEqual({ width: 30, height: 20, format: "jpeg" });
  });

  it("refuses a crop outside the image and leaves it untouched", async () => {
    const vol = await makeVolume({ "a.png": png });
    const response = await resize(vol, "a.png", "mode=crop&width=100&height=100&x=250&y=0");
    expect(await errorOf(response)).toEqual(["errResize", "a.png"]);
    expect(await imageAt(vol, "a.png")).toMatchObject({ width: 300, height: 200 });
  });

  it("refuses dimensions that are missing, non-positive or absurd", async () => {
    const vol = await makeVolume({ "a.png": png });
    for (const query of [
      "mode=resize&width=0&height=10",
      "mode=resize&width=abc&height=10",
      "mode=resize&width=100000&height=100000",
      "mode=teleport",
    ]) {
      expect(await errorOf(await resize(vol, "a.png", query))).toEqual([
        "errCmdParams",
        "resize",
      ]);
    }
    expect(await imageAt(vol, "a.png")).toMatchObject({ width: 300, height: 200 });
  });

  it("refuses a file that is not an image", async () => {
    const vol = await makeVolume({ "a.txt": "text" });
    const response = await resize(vol, "a.txt", "mode=resize&width=10&height=10");
    expect(await errorOf(response)).toEqual(["errResize", "a.txt"]);
    expect(await vol.read("a.txt")).toBe("text");
  });

  it("needs write access", async () => {
    const vol = await makeVolume({ "a.png": png }, { permissions: () => ({ write: false }) });
    const response = await resize(vol, "a.png", "mode=resize&width=10&height=10");
    expect(await errorOf(response)).toEqual(["errAccess"]);
    expect(await imageAt(vol, "a.png")).toMatchObject({ width: 300, height: 200 });
  });

  it("gives the edited image a fresh thumbnail", async () => {
    const vol = await makeVolume({ "a.png": png }, { tmbUrl: "/t/" });
    const target = hashOf("a.png");
    const before = (await json(await vol.GET(`cmd=tmb&targets[]=${target}`))).images[target];

    const body = await json(await resize(vol, "a.png", "mode=rotate&degree=90"));
    // Either pending or a new name; never the thumbnail of the old picture.
    expect(body.changed[0].tmb).not.toBe(before);
  });
});
