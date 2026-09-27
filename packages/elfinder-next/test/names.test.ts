import { describe, expect, it } from "vitest";
import { BACKSLASH, ROOT_HASH, errorOf, hashOf, makeVolume } from "./helpers.js";

/**
 * A name arriving from the client must name one entry in the target directory.
 * Before item 37 it was joined onto the target and normalized, so separators and
 * `..` moved the entry somewhere else in the volume, past the permission check
 * that had only looked at the target.
 */
describe("names are single path segments (item 37)", () => {
  const traversals = ["../escaped", "sub/nested", `sub${BACKSLASH}nested`, "..", "."];

  for (const name of traversals) {
    it(`mkdir refuses ${JSON.stringify(name)}`, async () => {
      const vol = await makeVolume({ "a/": "", "sub/": "" });
      const response = await vol.GET(
        `cmd=mkdir&target=${hashOf("a")}&name=${encodeURIComponent(name)}`,
      );
      expect(await errorOf(response)).toEqual(["errInvName"]);
      expect(await vol.exists("escaped")).toBe(false);
      expect(await vol.exists("sub/nested")).toBe(false);
    });
  }

  it("mkfile refuses a name that walks out of the target", async () => {
    const vol = await makeVolume({ "a/": "" });
    const response = await vol.GET(`cmd=mkfile&target=${hashOf("a")}&name=..%2Fout.txt`);
    expect(await errorOf(response)).toEqual(["errInvName"]);
    expect(await vol.exists("out.txt")).toBe(false);
  });

  it("rename refuses a name that moves the entry to another folder", async () => {
    const vol = await makeVolume({ "a/f.txt": "keep", "b/": "" });
    const response = await vol.GET(`cmd=rename&target=${hashOf("a/f.txt")}&name=..%2Fb%2Ff.txt`);
    expect(await errorOf(response)).toEqual(["errInvName"]);
    expect(await vol.read("a/f.txt")).toBe("keep");
    expect(await vol.exists("b/f.txt")).toBe(false);
  });

  it("archive refuses a name that writes the zip elsewhere", async () => {
    const vol = await makeVolume({ "a/f.txt": "x", "b/": "" });
    const response = await vol.GET(
      `cmd=archive&target=${hashOf("a")}&type=application/zip` +
        `&targets[]=${hashOf("a/f.txt")}&name=..%2Fb%2Fz.zip`,
    );
    expect(await errorOf(response)).toEqual(["errInvName"]);
    expect(await vol.exists("b/z.zip")).toBe(false);
  });

  it("does not let a name bypass write permission on another folder", async () => {
    const vol = await makeVolume(
      { "open/": "", "locked/": "" },
      { permissions: (p) => ({ write: !p.startsWith("locked") }) },
    );
    const response = await vol.GET(
      `cmd=mkdir&target=${hashOf("open")}&name=..%2Flocked%2Fplanted`,
    );
    expect(await errorOf(response)).toEqual(["errInvName"]);
    expect(await vol.exists("locked/planted")).toBe(false);
  });

  it("still accepts ordinary names, including dots inside them", async () => {
    const vol = await makeVolume({});
    for (const name of ["report.final.txt", "..hidden", "a..b"]) {
      const response = await vol.GET(`cmd=mkfile&target=${ROOT_HASH}&name=${name}`);
      expect(await errorOf(response)).toBeNull();
      expect(await vol.exists(name)).toBe(true);
    }
  });
});

describe("creating an entry never replaces one", () => {
  it("mkfile refuses an existing file instead of truncating it", async () => {
    const vol = await makeVolume({ "notes.txt": "precious" });
    const response = await vol.GET(`cmd=mkfile&target=${ROOT_HASH}&name=notes.txt`);
    expect(await errorOf(response)).toEqual(["errExists"]);
    expect(await vol.read("notes.txt")).toBe("precious");
  });

  it("archive refuses to overwrite an existing file", async () => {
    const vol = await makeVolume({ "f.txt": "x", "keep.zip": "not a zip, but mine" });
    const response = await vol.GET(
      `cmd=archive&target=${ROOT_HASH}&type=application/zip` +
        `&targets[]=${hashOf("f.txt")}&name=keep.zip`,
    );
    expect(await errorOf(response)).toEqual(["errExists", "keep.zip"]);
    expect(await vol.read("keep.zip")).toBe("not a zip, but mine");
  });
});
