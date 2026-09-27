import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { createElfinderHandler } from "../src/index.js";
import type { ElfinderOptions } from "../src/types.js";

/** The hash elFinder uses for the volume root, given the default volumeId. */
export const ROOT_HASH = "v1_Lw";

/**
 * Encodes a relative path the way the connector does, so tests can address a
 * file without first listing its directory.
 */
export function hashOf(relativePath: string, volumeId = "v1_"): string {
  const b64 = Buffer.from(relativePath)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${volumeId}${b64}`;
}

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

export type Volume = {
  /** Directory handed to the connector as `uploadDir`. */
  uploadDir: string;
  /** Parent of `uploadDir`. Anything here is outside the volume, by definition. */
  sandbox: string;
  /** Only headers are ever needed; NextRequest's own RequestInit is narrower than the global one. */
  GET: (query: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  POST: (body: FormData) => Promise<Response>;
  /** Absolute path of a path relative to the volume root. */
  at: (relativePath: string) => string;
  /** File contents, or null when it does not exist. */
  read: (relativePath: string) => Promise<string | null>;
  exists: (relativePath: string) => Promise<boolean>;
  /** Every file anywhere in the sandbox that is NOT inside the volume. */
  strayFiles: () => Promise<string[]>;
};

/**
 * Creates an isolated volume with a connector bound to it.
 *
 * `uploadDir` is deliberately nested one level inside the temporary directory so
 * that a traversal escaping the volume lands somewhere observable rather than in
 * the OS temp root.
 */
export async function makeVolume(
  tree: Record<string, string | Buffer> = {},
  options: ElfinderOptions = {},
): Promise<Volume> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "elfinder-test-"));
  sandboxes.push(sandbox);
  const uploadDir = path.join(sandbox, "volume");
  await fs.mkdir(uploadDir, { recursive: true });

  for (const [relativePath, body] of Object.entries(tree)) {
    const absolute = path.join(uploadDir, relativePath);
    if (relativePath.endsWith("/")) {
      await fs.mkdir(absolute, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }

  const handlers = createElfinderHandler({ uploadDir, ...options });

  const at = (relativePath: string) => path.join(uploadDir, relativePath);

  return {
    uploadDir,
    sandbox,
    at,
    GET: (query, init) =>
      handlers.GET(
        new NextRequest(`http://localhost/api/elfinder?${query}`, init),
      ) as unknown as Promise<Response>,
    POST: (body: FormData) =>
      handlers.POST(
        new NextRequest("http://localhost/api/elfinder", { method: "POST", body }),
      ) as unknown as Promise<Response>,
    read: (relativePath) => fs.readFile(at(relativePath), "utf8").catch(() => null),
    exists: (relativePath) =>
      fs
        .access(at(relativePath))
        .then(() => true)
        .catch(() => false),
    strayFiles: async () => {
      const found: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            found.push(full);
          }
        }
      };
      await walk(sandbox);
      return found
        .filter((file) => !file.startsWith(uploadDir + path.sep))
        .map((file) => path.relative(sandbox, file));
    },
  };
}

/** Parses a connector response as the elFinder JSON envelope. */
export async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

/** The `error` field of a response, or null when the command succeeded. */
export async function errorOf(response: Response): Promise<string[] | null> {
  const body = await json(response);
  return (body.error as string[] | undefined) ?? null;
}

/** Characters that are awkward to write as source literals on Windows. */
export const BACKSLASH = String.fromCharCode(92);
export const DOUBLE_QUOTE = String.fromCharCode(34);
