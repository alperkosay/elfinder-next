import { describe, expect, it } from "vitest";
import { ROOT_HASH, errorOf, hashOf, json, makeVolume } from "./helpers.js";

const TREE = {
  "public/notes.txt": "open",
  "secret/creds.txt": "classified",
  "archive/old.txt": "frozen",
  "top.txt": "root file",
};

describe("authorize gates the whole request (item 14)", () => {
  it("leaves the connector open when no hook is given", async () => {
    const vol = await makeVolume(TREE);
    const response = await vol.GET(`cmd=open&target=${ROOT_HASH}`);
    expect(response.status).toBe(200);
    expect(await errorOf(response)).toBeNull();
  });

  it("allows the request when the hook returns a session", async () => {
    const vol = await makeVolume(TREE, { authorize: () => ({ id: "u1" }) });
    expect(await errorOf(await vol.GET(`cmd=open&target=${ROOT_HASH}`))).toBeNull();
  });

  it.each([
    ["null", () => null],
    ["undefined", () => undefined],
    ["false", () => false as unknown as null],
  ])("answers 403 when the hook returns %s", async (_label, authorize) => {
    const vol = await makeVolume(TREE, { authorize });
    const response = await vol.GET(`cmd=open&target=${ROOT_HASH}`);

    // 403 rather than the 200 envelope: a rejected session is an infrastructure
    // event that proxies and monitoring should see, and lets the app redirect to
    // sign-in instead of showing a file-manager error.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: ["errAccess"] });
  });

  it("answers 403 when the hook throws", async () => {
    const vol = await makeVolume(TREE, {
      authorize: () => {
        throw new Error("upstream session store is down");
      },
    });
    const response = await vol.GET(`cmd=open&target=${ROOT_HASH}`);

    expect(response.status).toBe(403);
    // The thrown message must not reach the client.
    expect(JSON.stringify(await response.json())).not.toContain("session store");
  });

  it("keeps a message key the hook chose to throw", async () => {
    const { ElfinderError } = await import("../src/index.js");
    const vol = await makeVolume(TREE, {
      authorize: () => {
        throw new ElfinderError("errSessionExpires");
      },
    });
    const response = await vol.GET(`cmd=open&target=${ROOT_HASH}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: ["errSessionExpires"] });
  });

  it("gates uploads as well as reads", async () => {
    const vol = await makeVolume({}, { authorize: () => null });
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", ROOT_HASH);
    form.append("upload[]", new File(["x"], "sneaky.txt"), "sneaky.txt");

    const response = await vol.POST(form);
    expect(response.status).toBe(403);
    expect(await vol.exists("sneaky.txt")).toBe(false);
  });

  it("runs once per request, not once per path", async () => {
    let calls = 0;
    const vol = await makeVolume(TREE, {
      authorize: () => {
        calls += 1;
        return { id: "u1" };
      },
    });
    await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`);
    expect(calls).toBe(1);
  });
});

describe("the session reaches the permissions hook", () => {
  it("passes through whatever authorize returned", async () => {
    const seen: unknown[] = [];
    const vol = await makeVolume(TREE, {
      authorize: () => ({ id: "u1", role: "viewer" }),
      permissions: (_path, session) => {
        seen.push(session);
        return {};
      },
    });
    await vol.GET(`cmd=open&target=${ROOT_HASH}`);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ id: "u1", role: "viewer" });
  });

  it("asks about each path once per request", async () => {
    const asked: string[] = [];
    const vol = await makeVolume(TREE, {
      permissions: (relativePath) => {
        asked.push(relativePath);
        return {};
      },
    });
    await vol.GET(`cmd=open&init=1&target=${ROOT_HASH}`);

    expect(asked.length).toBe(new Set(asked).size);
  });
});

describe("permissions are reported on every entry", () => {
  it("maps booleans onto the protocol's 0 and 1", async () => {
    const vol = await makeVolume(TREE, {
      permissions: (relativePath) => ({
        read: relativePath !== "secret",
        write: relativePath !== "archive",
        locked: relativePath === "top.txt",
      }),
    });
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));
    const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f]));

    expect(byName.secret).toMatchObject({ read: 0, write: 1, locked: 0 });
    expect(byName.archive).toMatchObject({ read: 1, write: 0, locked: 0 });
    expect(byName["top.txt"]).toMatchObject({ read: 1, write: 1, locked: 1 });
    expect(byName.public).toMatchObject({ read: 1, write: 1, locked: 0 });
  });

  it("applies the permissive default for anything the hook omits", async () => {
    const vol = await makeVolume(TREE, { permissions: () => ({ write: false }) });
    const body = await json(await vol.GET(`cmd=open&target=${ROOT_HASH}`));

    expect(body.files.every((f: any) => f.read === 1 && f.write === 0 && f.locked === 0)).toBe(
      true,
    );
  });
});

describe("read permission is enforced", () => {
  const noReadOnSecret = {
    permissions: (relativePath: string) => ({ read: !relativePath.startsWith("secret") }),
  };

  it.each([
    ["open", () => `cmd=open&target=${hashOf("secret")}`],
    ["ls", () => `cmd=ls&target=${hashOf("secret")}`],
    ["get", () => `cmd=get&target=${hashOf("secret/creds.txt")}`],
    ["file", () => `cmd=file&target=${hashOf("secret/creds.txt")}`],
    ["search", () => `cmd=search&q=creds&target=${hashOf("secret")}`],
    ["size", () => `cmd=size&targets[]=${hashOf("secret/creds.txt")}`],
  ])("refuses %s inside an unreadable folder", async (_label, query) => {
    const vol = await makeVolume(TREE, noReadOnSecret);
    const response = await vol.GET(query());

    // A per-path denial stays inside the 200 envelope so elFinder can render it.
    expect(response.status).toBe(200);
    expect(await errorOf(response)).toEqual(["errAccess"]);
  });

  it("never puts the contents in the response body", async () => {
    const vol = await makeVolume(TREE, noReadOnSecret);
    const response = await vol.GET(`cmd=get&target=${hashOf("secret/creds.txt")}`);
    expect(await response.text()).not.toContain("classified");
  });

  it("omits unreadable entries from cmd=info rather than failing outright", async () => {
    const vol = await makeVolume(TREE, noReadOnSecret);
    const body = await json(
      await vol.GET(
        `cmd=info&targets[]=${hashOf("top.txt")}&targets[]=${hashOf("secret/creds.txt")}`,
      ),
    );

    expect(body.error).toBeUndefined();
    expect(body.files.map((f: any) => f.name)).toEqual(["top.txt"]);
  });

  it("hides unreadable folders from the navigation tree", async () => {
    const vol = await makeVolume(TREE, noReadOnSecret);
    const body = await json(await vol.GET(`cmd=tree&target=${ROOT_HASH}`));
    expect(body.tree.map((f: any) => f.name).sort()).toEqual(["archive", "public"]);
  });

  it("still allows reads elsewhere", async () => {
    const vol = await makeVolume(TREE, noReadOnSecret);
    const body = await json(await vol.GET(`cmd=get&target=${hashOf("public/notes.txt")}`));
    expect(body.content).toBe("open");
  });
});

describe("write permission is enforced", () => {
  const readOnlyArchive = {
    permissions: (relativePath: string) => ({ write: !relativePath.startsWith("archive") }),
  };

  it("refuses mkdir inside a read-only folder", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    const response = await vol.GET(`cmd=mkdir&target=${hashOf("archive")}&name=New`);

    expect(response.status).toBe(200);
    expect(await errorOf(response)).toEqual(["errAccess"]);
    expect(await vol.exists("archive/New")).toBe(false);
  });

  it("refuses mkfile inside a read-only folder", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(await vol.GET(`cmd=mkfile&target=${hashOf("archive")}&name=new.txt`)),
    ).toEqual(["errAccess"]);
    expect(await vol.exists("archive/new.txt")).toBe(false);
  });

  it("refuses to overwrite a file's contents", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(
        await vol.GET(`cmd=put&target=${hashOf("archive/old.txt")}&content=tampered`),
      ),
    ).toEqual(["errAccess"]);
    expect(await vol.read("archive/old.txt")).toBe("frozen");
  });

  it("refuses an upload into a read-only folder", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    const form = new FormData();
    form.set("cmd", "upload");
    form.set("target", hashOf("archive"));
    form.append("upload[]", new File(["x"], "added.txt"), "added.txt");

    expect(await errorOf(await vol.POST(form))).toEqual(["errAccess"]);
    expect(await vol.exists("archive/added.txt")).toBe(false);
  });

  it("refuses a paste into a read-only folder", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(
        await vol.GET(`cmd=paste&dst=${hashOf("archive")}&targets[]=${hashOf("top.txt")}`),
      ),
    ).toEqual(["errAccess"]);
    expect(await vol.exists("archive/top.txt")).toBe(false);
  });

  it("refuses to delete a file out of a read-only folder", async () => {
    // Removing an entry changes its directory, so the directory's write bit governs
    // it the way a POSIX unlink does. This is what makes a read-only folder mean
    // something.
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(await vol.GET(`cmd=rm&targets[]=${hashOf("archive/old.txt")}`)),
    ).toEqual(["errAccess"]);
    expect(await vol.exists("archive/old.txt")).toBe(true);
  });

  it("refuses to move a file out of a read-only folder", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(
        await vol.GET(
          `cmd=paste&cut=1&dst=${ROOT_HASH}&targets[]=${hashOf("archive/old.txt")}`,
        ),
      ),
    ).toEqual(["errAccess"]);
    expect(await vol.exists("archive/old.txt")).toBe(true);
  });

  it("still allows a copy out of a read-only folder", async () => {
    // Reading is permitted; only the folder's own contents are frozen.
    const vol = await makeVolume(TREE, readOnlyArchive);
    const response = await vol.GET(
      `cmd=paste&dst=${ROOT_HASH}&targets[]=${hashOf("archive/old.txt")}`,
    );
    expect(await errorOf(response)).toBeNull();
    expect(await vol.read("old.txt")).toBe("frozen");
  });

  it("still allows writes elsewhere", async () => {
    const vol = await makeVolume(TREE, readOnlyArchive);
    expect(
      await errorOf(await vol.GET(`cmd=mkdir&target=${hashOf("public")}&name=New`)),
    ).toBeNull();
    expect(await vol.exists("public/New")).toBe(true);
  });
});

describe("locked entries cannot be renamed or deleted", () => {
  const lockTop = {
    permissions: (relativePath: string) => ({ locked: relativePath === "top.txt" }),
  };

  it("refuses to delete, naming the entry", async () => {
    const vol = await makeVolume(TREE, lockTop);
    expect(await errorOf(await vol.GET(`cmd=rm&targets[]=${hashOf("top.txt")}`))).toEqual([
      "errLocked",
      "top.txt",
    ]);
    expect(await vol.exists("top.txt")).toBe(true);
  });

  it("refuses to rename", async () => {
    const vol = await makeVolume(TREE, lockTop);
    expect(
      await errorOf(await vol.GET(`cmd=rename&target=${hashOf("top.txt")}&name=other.txt`)),
    ).toEqual(["errLocked", "top.txt"]);
    expect(await vol.exists("top.txt")).toBe(true);
  });

  it("refuses to move", async () => {
    const vol = await makeVolume(TREE, lockTop);
    expect(
      await errorOf(
        await vol.GET(`cmd=paste&cut=1&dst=${hashOf("public")}&targets[]=${hashOf("top.txt")}`),
      ),
    ).toEqual(["errLocked", "top.txt"]);
    expect(await vol.exists("top.txt")).toBe(true);
  });

  it("still allows the contents to be rewritten", async () => {
    // locked governs the entry's identity, not its bytes; write still applies.
    const vol = await makeVolume(TREE, lockTop);
    expect(
      await errorOf(await vol.GET(`cmd=put&target=${hashOf("top.txt")}&content=edited`)),
    ).toBeNull();
    expect(await vol.read("top.txt")).toBe("edited");
  });
});

describe("a fully read-only volume", () => {
  const readOnly = { permissions: () => ({ write: false }) };

  it("serves listings and downloads", async () => {
    const vol = await makeVolume(TREE, readOnly);
    expect(await errorOf(await vol.GET(`cmd=open&target=${ROOT_HASH}`))).toBeNull();
    expect((await json(await vol.GET(`cmd=get&target=${hashOf("top.txt")}`))).content).toBe(
      "root file",
    );
  });

  it("refuses every mutation", async () => {
    const vol = await makeVolume(TREE, readOnly);
    const attempts = [
      `cmd=mkdir&target=${ROOT_HASH}&name=New`,
      `cmd=mkfile&target=${ROOT_HASH}&name=new.txt`,
      `cmd=rm&targets[]=${hashOf("top.txt")}`,
      `cmd=rename&target=${hashOf("top.txt")}&name=other.txt`,
      `cmd=put&target=${hashOf("top.txt")}&content=x`,
      `cmd=paste&dst=${hashOf("public")}&targets[]=${hashOf("top.txt")}`,
      `cmd=duplicate&targets[]=${hashOf("top.txt")}`,
      `cmd=archive&target=${ROOT_HASH}&name=a.zip&targets[]=${hashOf("top.txt")}`,
    ];

    for (const query of attempts) {
      expect(await errorOf(await vol.GET(query)), query).toEqual(["errAccess"]);
    }
    expect(await vol.read("top.txt")).toBe("root file");
    expect(await vol.exists("new.txt")).toBe(false);
    expect(await vol.exists("a.zip")).toBe(false);
  });
});
