import { describe, expect, it } from "vitest";
import { ROOT_HASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";

describe("rename never clobbers an existing file (item 7)", () => {
  it("refuses a rename onto an occupied name and leaves both files alone", async () => {
    const vol = await makeVolume({ "a.txt": "AAA", "b.txt": "BBB" });
    const response = await vol.GET(`cmd=rename&target=${hashOf("a.txt")}&name=b.txt`);

    expect(await errorOf(response)).toEqual(["errExists", "b.txt"]);
    // fs.rename replaces its destination silently on every platform, so before
    // this check "BBB" was simply gone.
    expect(await vol.read("b.txt")).toBe("BBB");
    expect(await vol.read("a.txt")).toBe("AAA");
  });

  it("still renames onto a free name", async () => {
    const vol = await makeVolume({ "a.txt": "AAA" });
    const body = await json(await vol.GET(`cmd=rename&target=${hashOf("a.txt")}&name=c.txt`));

    expect(body.error).toBeUndefined();
    expect(body.added?.[0]?.name).toBe("c.txt");
    expect(await vol.read("c.txt")).toBe("AAA");
    expect(await vol.exists("a.txt")).toBe(false);
  });

  it("allows a case-only rename", async () => {
    // Windows and macOS are case-insensitive by default, so the destination
    // "exists" while being the very file being renamed.
    const vol = await makeVolume({ "Photo.JPG": "image" });
    const response = await vol.GET(`cmd=rename&target=${hashOf("Photo.JPG")}&name=photo.jpg`);

    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("photo.jpg")).toBe("image");
  });

  it("refuses to rename the volume root", async () => {
    const vol = await makeVolume();
    expect(await errorOf(await vol.GET(`cmd=rename&target=${ROOT_HASH}&name=other`))).toEqual([
      "errPerm",
    ]);
  });
});

describe("paste never clobbers an existing file (item 7)", () => {
  it("refuses a cut onto an occupied name and keeps the source", async () => {
    const vol = await makeVolume({ "src/f.txt": "SRC", "f.txt": "DST" });
    const response = await vol.GET(
      `cmd=paste&cut=1&dst=${ROOT_HASH}&targets[]=${hashOf("src/f.txt")}`,
    );

    expect(await errorOf(response)).toEqual(["errExists", "f.txt"]);
    expect(await vol.read("f.txt")).toBe("DST");
    expect(await vol.read("src/f.txt")).toBe("SRC");
  });

  it("refuses a copy onto an occupied name with the same error as a cut", async () => {
    // These used to disagree: copy surfaced a bare EEXIST while cut overwrote in
    // silence.
    const vol = await makeVolume({ "src/f.txt": "SRC", "f.txt": "DST" });
    const response = await vol.GET(
      `cmd=paste&dst=${ROOT_HASH}&targets[]=${hashOf("src/f.txt")}`,
    );

    expect(await errorOf(response)).toEqual(["errExists", "f.txt"]);
    expect(await vol.read("f.txt")).toBe("DST");
  });

  it("still moves a file to a free name", async () => {
    const vol = await makeVolume({ "src/f.txt": "SRC" });
    const response = await vol.GET(
      `cmd=paste&cut=1&dst=${ROOT_HASH}&targets[]=${hashOf("src/f.txt")}`,
    );

    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("f.txt")).toBe("SRC");
    expect(await vol.exists("src/f.txt")).toBe(false);
  });

  it("still copies a directory tree to a free name", async () => {
    const vol = await makeVolume({ "src/deep/leaf.txt": "LEAF", "dest/": "" });
    const response = await vol.GET(
      `cmd=paste&dst=${hashOf("dest")}&targets[]=${hashOf("src")}`,
    );

    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("dest/src/deep/leaf.txt")).toBe("LEAF");
    expect(await vol.read("src/deep/leaf.txt")).toBe("LEAF");
  });
});

describe("an undecodable hash is not the volume root (item 8)", () => {
  it.each([["garbage"], ["v2_abc"], ["v1_!!!!"], [""]])(
    "refuses a paste with dst=%j instead of pasting into the root",
    async (badHash) => {
      const vol = await makeVolume({ "src/f.txt": "SRC" });
      const response = await vol.GET(
        `cmd=paste&dst=${encodeURIComponent(badHash)}&targets[]=${hashOf("src/f.txt")}`,
      );

      expect(await errorOf(response)).toEqual(["errTrgFolderNotFound"]);
      expect(await vol.exists("f.txt")).toBe(false);
    },
  );

  it("refuses an upload whose target cannot be decoded", async () => {
    const vol = await makeVolume();
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", "garbage");
    form.append("upload[]", new File(["x"], "sneaky.txt"), "sneaky.txt");

    expect(await errorOf(await vol.POST(form))).toEqual(["errTrgFolderNotFound"]);
    expect(await vol.exists("sneaky.txt")).toBe(false);
  });

  it("refuses mkdir with an undecodable target", async () => {
    const vol = await makeVolume();
    expect(await errorOf(await vol.GET("cmd=mkdir&target=nonsense&name=New"))).toEqual([
      "errTrgFolderNotFound",
    ]);
    expect(await vol.exists("New")).toBe(false);
  });

  it("still accepts the genuine root hash", async () => {
    const vol = await makeVolume({ "src/f.txt": "SRC" });
    const response = await vol.GET(
      `cmd=paste&dst=${ROOT_HASH}&targets[]=${hashOf("src/f.txt")}`,
    );

    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("f.txt")).toBe("SRC");
  });

  it.each([
    "a.txt",
    "sub/deep/file name.txt",
    "türkçe ağ/dosya.txt",
    "e=mc2.txt",
    "a+b/c_d.txt",
    "100% done.txt",
  ])("round-trips the hash for %j", async (name) => {
    // Validation is by re-encoding, so a legitimate hash for an awkward name must
    // not be mistaken for a forgery.
    const vol = await makeVolume({ [name]: "x" });
    const body = await json(await vol.GET(`cmd=info&targets[]=${hashOf(name)}`));

    expect(body.error).toBeUndefined();
    expect(body.files?.[0]?.name).toBe(name.split("/").pop());
  });
});
