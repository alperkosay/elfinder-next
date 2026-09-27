import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { Readable } from "stream";
import path from "path";
import mime from "mime-types";
import AdmZip from "adm-zip";
import sharp from "sharp";
import type { ElfinderContext } from "./context.js";
import { ElfinderAuthError, ElfinderError, toErrorResponse } from "./errors.js";
import type { ElfinderFile, ElfinderHandlers } from "./types.js";

/**
 * Renders a byte count the way elFinder's `uplMaxSize` is written, e.g. `"256M"`.
 *
 * The client parses this string rather than a number, and shows it verbatim in the
 * error it raises for an oversized file.
 */
function formatByteSize(bytes: number): string {
  const units: Array<[number, string]> = [
    [1024 ** 3, "G"],
    [1024 ** 2, "M"],
    [1024, "K"],
  ];
  for (const [size, suffix] of units) {
    if (bytes >= size && bytes % size === 0) {
      return `${bytes / size}${suffix}`;
    }
  }
  return String(bytes);
}

/** A permission with every default applied, so callers never re-check for undefined. */
type ResolvedPermission = { read: boolean; write: boolean; locked: boolean };


type ParamBag = {
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
};

function isBusyError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return code === "EBUSY" || code === "EPERM";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Throws unless `absolute` is `root` itself or sits underneath it. */
function assertWithin(root: string, absolute: string): void {
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ElfinderError("errAccess");
  }
}

/**
 * Reduces a client-supplied value to a single path segment, or `null` when it
 * cannot be made into one.
 *
 * Both `/` and `\` count as separators. `path.posix.basename` leaves backslashes
 * alone, so on Windows a value such as `..\..\evil.txt` survives basename intact
 * and is then split by `path.resolve`, landing outside the intended directory.
 */
function safeSegment(raw: string): string | null {
  const last = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return null;
  }
  return cleaned;
}

/**
 * Validates a name the client chose for a new or renamed entry.
 *
 * Unlike safeSegment, which salvages a usable name from upload metadata, this
 * refuses. A typed name containing a separator or `..` would be joined onto the
 * target and normalized into a different directory — one whose permissions were
 * never checked — and quietly trimming it would create an entry nobody named.
 */
function requireEntryName(raw: string | null, fallback = ""): string {
  const name = (raw || fallback).trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f]/.test(name)) {
    throw new ElfinderError("errInvName");
  }
  return name;
}

async function rmWithRetry(
  absolutePath: string,
  options?: { recursive?: boolean; force?: boolean },
  attempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.rm(absolutePath, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === attempts) {
        throw error;
      }
      await sleep(40 * attempt);
    }
  }
  throw lastError;
}

type ZipEntry = {
  entryName: string;
  isDirectory: boolean;
  header: { size: number };
  getData: () => Buffer;
};

type ZipAdapter = {
  addLocalFolder: (localPath: string, zipPath?: string) => void;
  addLocalFile: (
    localPath: string,
    zipPath?: string,
    zipName?: string,
    comment?: string,
  ) => void;
  writeZip: (targetFileName?: string) => void;
  getEntries: () => ZipEntry[];
};

/**
 * Media types that may be rendered inline by the browser.
 *
 * Uploaded files are served from the application's own origin, so anything the
 * browser will execute there runs with the app's cookies. `text/html` and
 * `image/svg+xml` are the obvious offenders and are deliberately absent: SVG can
 * carry script. Everything outside this set is sent as a download.
 */
const INLINE_SAFE_MIME = new Set([
  "application/pdf",
  "audio/aac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

function isInlineSafeMime(mimeType: string): boolean {
  return INLINE_SAFE_MIME.has(mimeType.split(";")[0].trim().toLowerCase());
}

type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header.
 *
 * Returns `null` when the whole body should be sent — no header, a malformed one,
 * or a multi-range request this handler does not implement — and `"unsatisfiable"`
 * when the client asked for bytes that do not exist, which owes a 416.
 */
function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }
  if (size === 0) {
    return "unsatisfiable";
  }

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the final 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return "unsatisfiable";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Builds a Content-Disposition value that cannot break out of the header.
 *
 * A filename may legitimately contain a double quote or a non-ASCII character.
 * Interpolating it raw lets the first quote terminate the parameter, so the
 * ASCII form is sanitized and the real name travels in the RFC 5987 parameter.
 */
function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Normalizes a zip entry name to a relative POSIX path, or returns `null` when
 * the entry cannot be trusted.
 *
 * Archives are attacker-controlled input. Entry names may be absolute, may use
 * backslashes, and may contain `..` segments that walk out of the extraction
 * directory ("zip slip").
 */
function safeEntryPath(entryName: string): string | null {
  const cleaned = entryName.replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(cleaned)) {
    return null;
  }
  const segments = cleaned.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (segments.some((segment) => segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    return null;
  }
  return segments.join("/");
}

export function createElfinderHandlers(ctx: ElfinderContext): ElfinderHandlers {
  const {
    uploadDir: UPLOAD_DIR,
    rootName: ROOT_NAME,
    volumeId: VOLUME_ID,
    rootHash: ROOT_HASH,
    tmbDir: TMB_DIR,
    chunkDir: CHUNK_DIR,
    tmpDir: TMP_DIR,
    publicUrl: PUBLIC_URL,
    tmbUrl: TMB_URL,
    maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    chunkTtlMs: CHUNK_TTL_MS,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxUploadFiles: MAX_UPLOAD_FILES,
    maxSearchResults: MAX_SEARCH_RESULTS,
    authorize: AUTHORIZE,
    permissions: PERMISSIONS,
  } = ctx;

  function normalizeRelativePath(raw: string): string {
    const clean = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean || clean === ".") {
      return "";
    }
    return path.posix.normalize(clean).replace(/^(\.\.(\/|\\|$))+/, "");
  }

  function encodeHash(relativePath: string): string {
    if (!relativePath) {
      return ROOT_HASH;
    }
    const normalized = normalizeRelativePath(relativePath);
    const b64 = Buffer.from(normalized)
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `${VOLUME_ID}${b64}`;
  }

  /**
   * Decodes a hash, telling "the volume root" apart from "not a hash we issued".
   *
   * Returns `""` for the root and `null` when the value cannot be decoded. The
   * distinction matters: treating an undecodable hash as the root silently sends
   * pastes and uploads to the top of the volume instead of reporting an error.
   */
  function decodeHashStrict(hash?: string | null): string | null {
    if (!hash) {
      return null;
    }
    if (hash === ROOT_HASH) {
      return "";
    }
    if (!hash.startsWith(VOLUME_ID)) {
      return null;
    }
    let normalized: string;
    try {
      const encoded = hash
        .slice(VOLUME_ID.length)
        .replace(/ /g, "+")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = encoded + "=".repeat((4 - (encoded.length % 4 || 4)) % 4);
      normalized = normalizeRelativePath(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return null;
    }
    if (!normalized) {
      return null;
    }
    // Base64 decoding never fails loudly: arbitrary text decodes to arbitrary
    // bytes. Re-encoding is the real check — a hash we issued round-trips, and
    // anything else does not.
    if (encodeHash(normalized) !== hash) {
      return null;
    }
    return normalized;
  }

  function decodeHash(hash?: string | null): string {
    return decodeHashStrict(hash) ?? "";
  }

  /**
   * Decodes a hash for a command that cannot fall back to the root, such as the
   * destination of a paste or an upload.
   */
  function requireHash(hash: string | null | undefined, code: string): string {
    const decoded = decodeHashStrict(hash);
    if (decoded === null) {
      throw new ElfinderError(code);
    }
    return decoded;
  }

  let realRootPromise: Promise<string> | null = null;

  /**
   * The volume root with symlinks resolved, cached for the handler's lifetime.
   *
   * The root itself is often a link — `public/uploads` pointing at a mounted
   * volume is a normal deployment — so containment has to be judged against the
   * resolved root, not the configured one.
   */
  function realRoot(): Promise<string> {
    if (!realRootPromise) {
      realRootPromise = fs.realpath(UPLOAD_DIR).catch((error: unknown) => {
        // Do not cache a failure; the directory may simply not exist yet.
        realRootPromise = null;
        throw error;
      });
    }
    return realRootPromise;
  }

  async function resolveWithinRoot(relativePath: string): Promise<string> {
    const safeRelative = normalizeRelativePath(relativePath);
    const absolute = path.resolve(UPLOAD_DIR, safeRelative);
    assertWithin(UPLOAD_DIR, absolute);

    // The check above is lexical and cannot see symlinks. Walk up to the deepest
    // component that exists, resolve that, and confirm it is still inside the
    // volume. A component that does not exist yet cannot be a link, so stopping
    // at the first one that does is sufficient.
    const root = await realRoot();
    let probe = absolute;
    for (;;) {
      try {
        assertWithin(root, await fs.realpath(probe));
        return absolute;
      } catch (error) {
        if (error instanceof ElfinderError) {
          throw error;
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new ElfinderError("errAccess");
        }
        probe = parent;
      }
    }
  }

  type RequestScope = {
    session: unknown;
    /** Memoizes permission lookups so a listing asks about each path once. */
    cache: Map<string, ResolvedPermission>;
    /** Path of the route serving this request, basePath included. */
    connectorUrl: string;
    /** Read for conditional requests, so streamFile can answer 304. */
    headers: Headers;
  };

  /**
   * Request-scoped state, carried implicitly rather than threaded through every
   * internal function.
   *
   * Almost everything here needs the session, directly or through a caller:
   * toFileInfo reports the flags, listDirectory calls toFileInfo, and each handler
   * checks access. Passing it explicitly would mean an extra parameter on some forty
   * functions for a value that never changes within a request.
   */
  const scopeStorage = new AsyncLocalStorage<RequestScope>();

  const FULL_ACCESS: ResolvedPermission = { read: true, write: true, locked: false };

  /**
   * Resolves what the caller may do with one path, applying the permissive defaults
   * for anything the callback leaves out.
   */
  async function permissionFor(relativePath: string): Promise<ResolvedPermission> {
    if (!PERMISSIONS) {
      return FULL_ACCESS;
    }
    const scope = scopeStorage.getStore();
    const key = normalizeRelativePath(relativePath);

    const cached = scope?.cache.get(key);
    if (cached) {
      return cached;
    }

    const granted = await PERMISSIONS(key, scope?.session);
    const resolved: ResolvedPermission = {
      read: granted.read ?? true,
      write: granted.write ?? true,
      locked: granted.locked ?? false,
    };
    scope?.cache.set(key, resolved);
    return resolved;
  }

  async function requireRead(relativePath: string): Promise<void> {
    if (!(await permissionFor(relativePath)).read) {
      throw new ElfinderError("errAccess");
    }
  }

  async function requireWrite(relativePath: string): Promise<void> {
    if (!(await permissionFor(relativePath)).write) {
      throw new ElfinderError("errAccess");
    }
  }

  /**
   * Part filenames in `dir` belonging to the same upload as `chunkName`, in offset
   * order.
   *
   * elFinder names slices `<file>.<index>_<count>.part`, so the base name identifies
   * the upload and the index orders it. Sorting numerically matters: lexical order
   * puts `.10_` before `.2_` and would concatenate the file scrambled.
   */
  function chunkBaseName(chunkName: string): string {
    return chunkName.replace(/\.\d+_\d+\.part$/, "");
  }

  async function chunkPartNames(dir: string, chunkName: string): Promise<string[]> {
    return chunkPartNamesForBase(dir, chunkBaseName(chunkName));
  }

  async function chunkPartNamesForBase(dir: string, base: string): Promise<string[]> {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}\\.(\\d+)_\\d+\\.part$`);

    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const indexOf = (name: string) => Number(pattern.exec(name)?.[1] ?? 0);
    return entries.filter((name) => pattern.test(name)).sort((a, b) => indexOf(a) - indexOf(b));
  }

  /** Sizes of the parts already written for this upload. */
  async function chunkPartSizes(dir: string, chunkName: string): Promise<number[]> {
    const names = await chunkPartNames(dir, chunkName);
    return Promise.all(
      names.map(async (name) => {
        try {
          return (await fs.stat(path.resolve(dir, name))).size;
        } catch {
          return 0;
        }
      }),
    );
  }

  /** Parent directory of a path, as permissions and `phash` see it. */
  function parentOf(relativePath: string): string {
    const parent = normalizeRelativePath(path.posix.dirname(relativePath));
    return parent === "." ? "" : parent;
  }

  /**
   * Guards renaming or deleting an existing entry.
   *
   * Requires `write` on the entry and on the directory holding it, the way a POSIX
   * unlink does, so revoking `write` on a folder is enough to freeze its contents.
   * `locked` denies the operation even where `write` is granted.
   */
  async function requireMutable(relativePath: string): Promise<void> {
    const own = await permissionFor(relativePath);
    if (own.locked) {
      throw new ElfinderError(["errLocked", path.posix.basename(relativePath)]);
    }
    if (!own.write) {
      throw new ElfinderError("errAccess");
    }
    await requireWrite(parentOf(relativePath));
  }

  /**
   * Last time abandoned chunk directories were swept, so an upload burst does not
   * scan the directory on every request.
   */
  let lastChunkSweep = 0;

  /**
   * Deletes chunk directories that have not been touched within the TTL.
   *
   * An upload that is cancelled, or whose browser tab is closed, leaves its parts
   * behind forever: nothing else ever revisits them. A directory's mtime moves as
   * parts are written into it, so it tracks the last activity for that upload.
   *
   * The sweep interval is capped by the TTL itself, which keeps a deliberately
   * short TTL responsive instead of waiting out a fixed timer.
   */
  async function sweepStaleTemp(): Promise<void> {
    const now = Date.now();
    if (now - lastChunkSweep < Math.min(CHUNK_TTL_MS, 5 * 60_000)) {
      return;
    }
    lastChunkSweep = now;

    // Staged zipdl archives expire on the same clock. Phase two normally collects and
    // deletes them, but a client that walks away leaves one behind.
    const staged = await fs.readdir(TMP_DIR).catch(() => [] as string[]);
    await Promise.all(
      staged.map(async (name) => {
        const file = path.resolve(TMP_DIR, name);
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs >= CHUNK_TTL_MS) {
            await rmWithRetry(file, { force: true });
          }
        } catch {
          // Being collected by the request that made it.
        }
      }),
    );

    let entries;
    try {
      entries = await fs.readdir(CHUNK_DIR, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = path.resolve(CHUNK_DIR, entry.name);
          try {
            const stat = await fs.stat(dir);
            if (now - stat.mtimeMs >= CHUNK_TTL_MS) {
              await rmWithRetry(dir, { recursive: true, force: true });
            }
          } catch {
            // Another request may be mid-upload in this directory.
          }
        }),
    );
  }

  let uploadDirReady: Promise<void> | null = null;

  /**
   * Creates the volume and its bookkeeping directories once per handler, rather
   * than issuing four mkdir calls on every request. A failure is not cached, so a
   * volume that was briefly unavailable (an unmounted disk, say) is retried.
   */
  function ensureUploadDir(): Promise<void> {
    uploadDirReady ??= (async () => {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      await Promise.all(
        [TMB_DIR, CHUNK_DIR, TMP_DIR].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
    })().catch((error) => {
      uploadDirReady = null;
      throw error;
    });
    return uploadDirReady;
  }

  function isImageMime(mimeType: string): boolean {
    return mimeType.startsWith("image/");
  }

  /**
   * First half of a thumbnail filename: a digest of the source's path.
   *
   * Keeping the path identifiable lets thumbnails be deleted without stat-ing the
   * source, which is necessary because cleanup happens after the file is already
   * gone.
   */
  function thumbPathPrefix(relativePath: string): string {
    return createHash("sha256")
      .update(normalizeRelativePath(relativePath))
      .digest("hex")
      .slice(0, 24);
  }

  /**
   * Thumbnail filename: `<pathDigest>-<contentDigest>.png`.
   *
   * The content half changes whenever the source's size or mtime changes, so
   * replacing a file under the same name produces a different filename instead of
   * serving the previous image forever. Digesting both halves also bounds the
   * length: the old scheme embedded the base64 path, which grows without limit as
   * the tree deepens and can overrun the 255-byte filename limit.
   */
  function thumbFilename(
    relativePath: string,
    stat: { mtimeMs: number; size: number },
  ): string {
    const content = createHash("sha256")
      .update(`${Math.floor(stat.mtimeMs)}:${stat.size}`)
      .digest("hex")
      .slice(0, 12);
    return `${thumbPathPrefix(relativePath)}-${content}.png`;
  }

  function detectMimeFromName(name: string): string {
    return mime.lookup(name) || "application/octet-stream";
  }

  /**
   * Whether `value` is one of this volume's hashes, which elFinder puts in
   * upload_path[] in place of a name. Decoding rather than pattern-matching means
   * a custom volumeId is recognized and a file named like `v2_report` is not.
   */
  function looksLikeElfinderHash(value: string): boolean {
    return decodeHashStrict(value) !== null;
  }

  function chooseUploadFilename(candidates: Array<string | null | undefined>): string {
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const base = path.posix.basename(normalizeRelativePath(candidate));
      if (!base || base === "." || base === "..") {
        continue;
      }
      if (base === "blob") {
        continue;
      }
      if (looksLikeElfinderHash(base)) {
        continue;
      }
      return base;
    }
    return "upload.bin";
  }

  /**
   * Returns the thumbnail filename if one matching the source's current contents
   * is already on disk, without creating it.
   *
   * The caller passes the stat it already has, so this costs one access() rather
   * than a second stat of every file in a listing.
   */
  async function existingThumbForFile(
    relativePath: string,
    stat: { mtimeMs: number; size: number },
  ): Promise<string | null> {
    const thumbName = thumbFilename(relativePath, stat);
    try {
      await fs.access(path.resolve(TMB_DIR, thumbName));
      return thumbName;
    } catch {
      return null;
    }
  }

  async function ensureThumbForFile(relativePath: string): Promise<string | null> {
    const normalized = normalizeRelativePath(relativePath);
    const absolute = await resolveWithinRoot(normalized);

    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      return null;
    }

    const existing = await existingThumbForFile(normalized, stat);
    if (existing) {
      return existing;
    }

    const thumbName = thumbFilename(normalized, stat);
    const thumbPath = path.resolve(TMB_DIR, thumbName);

    try {
      // Read into a buffer so sharp never holds a path-based lock on the source file.
      const input = await fs.readFile(absolute);
      // ensureUploadDir runs once per handler, so .tmb may have been removed since.
      await fs.mkdir(TMB_DIR, { recursive: true });
      await sharp(input)
        .resize(48, 48, { fit: "inside", withoutEnlargement: true })
        .png()
        .toFile(thumbPath);
    } catch {
      return null;
    }

    // Superseded thumbnails for this path are cleaned up by the caller in one
    // batch, so a request generating fifty thumbnails scans .tmb once rather than
    // fifty times.
    return thumbName;
  }

  /**
   * What goes in a file's `tmb` field once its thumbnail exists.
   *
   * With a `tmbUrl` the client prefixes it, so the bare filename is enough. Without
   * one the 2.1 client uses `tmb` verbatim as the image URL, so it must be a full
   * address, and since nothing serves `.tmb` statically that address is the
   * connector itself.
   */
  function thumbReference(relativePath: string, thumbName: string): string {
    if (TMB_URL) {
      return thumbName;
    }
    const connectorUrl = scopeStorage.getStore()?.connectorUrl ?? "";
    return `${connectorUrl}?cmd=file&target=${encodeHash(relativePath)}&thumb=1`;
  }

  /**
   * Deletes every thumbnail belonging to any of `relativePaths`.
   *
   * Reads the thumbnail directory once and matches by path digest, rather than
   * probing per file: cleaning up a folder of a thousand images would otherwise
   * mean a thousand directory scans. `keep` spares one filename, used when a fresh
   * thumbnail has just been written for one of the paths.
   */
  async function removeThumbsForPaths(
    relativePaths: string[],
    keep?: ReadonlySet<string>,
  ): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }
    const prefixes = new Set(relativePaths.map((p) => `${thumbPathPrefix(p)}-`));

    let entries: string[];
    try {
      entries = await fs.readdir(TMB_DIR);
    } catch {
      return;
    }

    const doomed = entries.filter((name) => {
      if (keep?.has(name)) {
        return false;
      }
      const dash = name.indexOf("-");
      return dash > 0 && prefixes.has(name.slice(0, dash + 1));
    });

    await Promise.all(
      doomed.map((name) =>
        rmWithRetry(path.resolve(TMB_DIR, name), { force: true }).catch(() => {
          // A concurrent request may have removed it already.
        }),
      ),
    );
  }

  /**
   * Relative paths whose thumbnails belong to `relative`, gathered before it is
   * moved or deleted.
   *
   * For a directory that means every image inside it: those thumbnails are keyed by
   * their own paths, so removing only the directory's own key would orphan them.
   * Non-images are skipped since they never had a thumbnail.
   */
  async function collectThumbOwners(relative: string, absolute: string): Promise<string[]> {
    const isImagePath = (p: string) =>
      isImageMime(detectMimeFromName(path.posix.basename(p)));

    let isDirectory: boolean;
    try {
      isDirectory = (await fs.stat(absolute)).isDirectory();
    } catch {
      return [];
    }
    if (!isDirectory) {
      return isImagePath(relative) ? [relative] : [];
    }

    const owners: string[] = [];
    try {
      await walkRecursive(absolute, async (fullPath) => {
        const childRelative = relFromAbs(fullPath);
        if (isImagePath(childRelative)) {
          owners.push(childRelative);
        }
      });
    } catch {
      // Best effort: a partially readable tree still yields what it can.
    }
    return owners;
  }

  async function hasSubDirs(absolutePath: string): Promise<0 | 1> {
    try {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      return entries.some((entry) => entry.isDirectory()) ? 1 : 0;
    } catch {
      return 0;
    }
  }

  async function toFileInfo(relativePath: string): Promise<ElfinderFile> {
    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = await resolveWithinRoot(normalized);
    const stat = await fs.stat(absolutePath);
    const isDir = stat.isDirectory();
    const parent = normalizeRelativePath(path.posix.dirname(normalized));
    const permission = await permissionFor(normalized);

    const info: ElfinderFile = {
      name: normalized ? path.posix.basename(normalized) : ROOT_NAME,
      size: stat.size,
      hash: encodeHash(normalized),
      mime: isDir
        ? "directory"
        : detectMimeFromName(path.posix.basename(normalized)),
      ts: Math.floor(stat.mtimeMs / 1000),
      read: permission.read ? 1 : 0,
      write: permission.write ? 1 : 0,
      locked: permission.locked ? 1 : 0,
      volumeid: VOLUME_ID,
    };

    if (normalized) {
      info.phash = encodeHash(parent === "." ? "" : parent);
    } else {
      info.phash = "";
    }

    if (isDir) {
      // elFinder reads these from the *current* directory, not from the root, so a
      // subfolder without them loses the archive commands and the file URL base.
      info.options = volumeOptions();
    }

    if (isDir) {
      const dirs = await hasSubDirs(absolutePath);
      if (dirs) {
        info.dirs = 1;
      }
    } else if (isImageMime(info.mime)) {
      // "1" means "a thumbnail is possible but not ready", which makes elFinder
      // fetch it through cmd=tmb in batches. Generating it here instead would run
      // one sharp resize per image every time a directory is listed, so opening a
      // folder of 500 images would be 500 resizes inside a single request.
      const thumbName = await existingThumbForFile(normalized, stat);
      info.tmb = thumbName ? thumbReference(normalized, thumbName) : "1";
    }

    return info;
  }

  async function listDirectory(relativeDir: string): Promise<ElfinderFile[]> {
    const baseRelative = normalizeRelativePath(relativeDir);
    const absoluteDir = await resolveWithinRoot(baseRelative);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    const visible = entries.filter(
      (entry) => !isBookkeepingPath(path.join(absoluteDir, entry.name)),
    );
    // Bounded rather than Promise.all over the whole directory: each entry costs
    // at least a stat, and a directory with thousands of files would otherwise
    // open thousands of descriptors at once.
    return mapWithConcurrency(visible, 16, (entry) =>
      toFileInfo(
        normalizeRelativePath(baseRelative ? `${baseRelative}/${entry.name}` : entry.name),
      ),
    );
  }

  function getTargets(params: ParamBag): string[] {
    const bracket = params.getAll("targets[]");
    if (bracket.length > 0) {
      return bracket;
    }
    const plain = params.getAll("targets");
    if (plain.length > 0) {
      return plain
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    }
    return [];
  }

  function isTruthy(value: string | null): boolean {
    return value === "1" || value === "true";
  }

  function suffixName(name: string, suffix: string): string {
    const ext = path.posix.extname(name);
    const base = path.posix.basename(name, ext);
    return `${base}${suffix}${ext}`;
  }

  /**
   * True when two paths name the same file on disk.
   *
   * Needed so a case-only rename (`Photo.JPG` to `photo.jpg`) is not mistaken for
   * a collision. Windows and macOS are case-insensitive by default, so the two
   * spellings are one file there; the inode comparison covers case-sensitive
   * filesystems, where they are genuinely different.
   */
  async function isSameTarget(a: string, b: string): Promise<boolean> {
    if (a === b) {
      return true;
    }
    if (process.platform !== "linux" && a.toLowerCase() === b.toLowerCase()) {
      return true;
    }
    try {
      const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
      return statA.dev === statB.dev && statA.ino !== 0 && statA.ino === statB.ino;
    } catch {
      return false;
    }
  }

  /**
   * Refuses to clobber an existing file.
   *
   * `fs.rename` replaces its destination silently on every platform, so without
   * this a rename or a cut-paste onto an existing name destroys that file with no
   * error. elFinder responds to errExists by asking the user whether to overwrite
   * or keep both, which is the decision that was being made for them.
   */
  async function assertNotOccupied(destination: string, source?: string): Promise<void> {
    try {
      await fs.stat(destination);
    } catch {
      return;
    }
    if (source && (await isSameTarget(source, destination))) {
      return;
    }
    throw new ElfinderError(["errExists", path.basename(destination)]);
  }

  async function movePath(src: string, dst: string) {
    await assertNotOccupied(dst, src);
    try {
      await fs.rename(src, dst);
    } catch {
      await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
      await rmWithRetry(src, { recursive: true, force: true });
    }
  }

  /**
   * True for the connector's own bookkeeping directories and their contents.
   *
   * Compared by resolved path rather than by name, so a user folder that happens to
   * be called `.tmb` deeper in the tree stays visible. Only the two at the volume
   * root are ours.
   */
  function isBookkeepingPath(absolute: string): boolean {
    return [TMB_DIR, CHUNK_DIR, TMP_DIR].some(
      (dir) => absolute === dir || absolute.startsWith(`${dir}${path.sep}`),
    );
  }

  /**
   * Walks a directory tree depth-first, skipping the connector's own bookkeeping
   * directories.
   *
   * The visitor returns `false` to stop the walk, which is what keeps a search over a
   * large volume bounded instead of enumerating everything before truncating.
   */
  async function walkRecursive(
    base: string,
    visitor: (fullPath: string) => Promise<boolean | void>,
  ): Promise<boolean> {
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      const current = path.join(base, entry.name);
      if (isBookkeepingPath(current)) {
        continue;
      }
      if ((await visitor(current)) === false) {
        return false;
      }
      if (entry.isDirectory() && (await walkRecursive(current, visitor)) === false) {
        return false;
      }
    }
    return true;
  }

  function relFromAbs(absolutePath: string): string {
    return normalizeRelativePath(path.relative(UPLOAD_DIR, absolutePath));
  }

  /**
   * The volume capability block elFinder attaches to a directory.
   *
   * `archivers` is what actually drives the UI: the Archive and Extract commands are
   * hidden unless the mime type appears here, which is why both were unreachable
   * while the handlers for them existed. `disabled` must not list a command that
   * works, for the same reason in reverse.
   */
  function volumeOptions(): NonNullable<ElfinderFile["options"]> {
    return {
      // chmod has no meaning for this backend and netmount has no driver; `size` is
      // implemented and deliberately absent from this list.
      disabled: ["chmod", "netmount"],
      archivers: {
        create: ["application/zip"],
        extract: ["application/zip"],
      },
      url: PUBLIC_URL,
      tmbUrl: TMB_URL,
      separator: "/",
    };
  }

  async function handleOpen(params: ParamBag) {
    const init = params.get("init") === "1";
    let target = decodeHash(params.get("target"));
    if (init && !params.get("target")) {
      target = "";
    }
    if (target) {
      try {
        await fs.stat(await resolveWithinRoot(target));
      } catch {
        target = "";
      }
    }
    await requireRead(target);
    const cwd = await toFileInfo(target);
    const children = await listDirectory(target);
    const files = init ? [await toFileInfo(""), ...children] : children;

    // With tree=1 the client is drawing the navigation pane and expects the folders
    // above and beside the current one in the same response. Without them the pane
    // shows only the branch it happens to have walked into.
    if (isTruthy(params.get("tree"))) {
      const seen = new Set(files.map((file) => file.hash));
      for (const folder of await ancestorFolders(target)) {
        if (!seen.has(folder.hash)) {
          seen.add(folder.hash);
          files.push(folder);
        }
      }
    }

    return NextResponse.json({
      ...(init ? { api: "2.1" } : {}),
      cwd,
      files,
      options: {
        uiCmdMap: [],
        tmbUrl: TMB_URL,
      },
      // Advertised so the client can refuse an oversized file before sending it and
      // batch a large selection, instead of discovering the limit from an error.
      ...(MAX_UPLOAD_BYTES > 0 ? { uplMaxSize: formatByteSize(MAX_UPLOAD_BYTES) } : {}),
      ...(MAX_UPLOAD_FILES > 0 ? { uplMaxFile: MAX_UPLOAD_FILES } : {}),
    });
  }

  async function handleTree(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    await requireRead(target);
    const files = await listDirectory(target);
    return NextResponse.json({
      tree: files.filter((item) => item.mime === "directory" && item.read === 1),
    });
  }

  /**
   * The root, plus every readable folder on the path from the root to `target` and
   * beside it.
   *
   * This is the shape the navigation pane needs, and both `parents` and an `open` with
   * `tree=1` ask for it.
   */
  async function ancestorFolders(target: string): Promise<ElfinderFile[]> {
    const tree = new Map<string, ElfinderFile>();

    const rootInfo = await toFileInfo("");
    tree.set(rootInfo.hash, rootInfo);

    let current = target;
    while (current) {
      const parent = normalizeRelativePath(path.posix.dirname(current));
      const parentDir = parent === "." ? "" : parent;
      let siblings: ElfinderFile[] = [];
      try {
        siblings = await listDirectory(parentDir);
      } catch {
        siblings = [];
      }
      siblings
        .filter((item) => item.mime === "directory" && item.read === 1)
        .forEach((item) => tree.set(item.hash, item));
      if (!parent || parent === "." || parent === current) {
        break;
      }
      current = parent;
    }

    return Array.from(tree.values());
  }

  async function handleParents(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    return NextResponse.json({ tree: await ancestorFolders(target) });
  }

  async function handleMkdir(params: ParamBag) {
    const target = requireHash(params.get("target"), "errTrgFolderNotFound");
    const name = requireEntryName(params.get("name"), "New Folder");
    await requireWrite(target);
    const targetRelative = normalizeRelativePath(target ? `${target}/${name}` : name);
    const absolute = await resolveWithinRoot(targetRelative);
    await fs.mkdir(absolute, { recursive: false });
    return NextResponse.json({ added: [await toFileInfo(targetRelative)] });
  }

  async function handleRm(params: ParamBag) {
    const targets = getTargets(params);
    if (!targets.length) {
      return NextResponse.json({ removed: [] });
    }

    const removed: string[] = [];
    for (const hash of targets) {
      const relative = decodeHash(hash);
      if (!relative) {
        continue;
      }
      await requireMutable(relative);
      const absolute = await resolveWithinRoot(relative);
      // Gathered before the delete: once the tree is gone there is no way to know
      // which thumbnails belonged to it.
      const owners = await collectThumbOwners(relative, absolute);
      await rmWithRetry(absolute, { recursive: true, force: true });
      await removeThumbsForPaths(owners);
      removed.push(hash);
    }

    return NextResponse.json({ removed });
  }

  async function handleRename(params: ParamBag) {
    const targetHash = params.get("target");
    if (!targetHash) {
      throw new ElfinderError("errInvName");
    }
    const name = requireEntryName(params.get("name"));

    const oldRelative = decodeHash(targetHash);
    if (!oldRelative) {
      throw new ElfinderError("errPerm");
    }

    const parent = normalizeRelativePath(path.posix.dirname(oldRelative));
    const newRelative = normalizeRelativePath(parent ? `${parent}/${name}` : name);
    await requireMutable(oldRelative);
    const oldAbsolute = await resolveWithinRoot(oldRelative);
    const newAbsolute = await resolveWithinRoot(newRelative);
    await assertNotOccupied(newAbsolute, oldAbsolute);

    // Thumbnails are keyed by path, so everything under the old name is orphaned
    // by the rename. Collect first, delete after the rename succeeds.
    const owners = await collectThumbOwners(oldRelative, oldAbsolute);
    await fs.rename(oldAbsolute, newAbsolute);
    await removeThumbsForPaths(owners);

    return NextResponse.json({
      removed: [targetHash],
      added: [await toFileInfo(newRelative)],
    });
  }

  async function handleFile(params: ParamBag, rangeHeader: string | null) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }

    await requireRead(target);
    const absolute = await resolveWithinRoot(target);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new ElfinderError("errNotFile");
    }

    // The address thumbReference hands out when there is no tmbUrl. Addressed by the
    // source rather than the thumbnail's own name, so the source's read permission
    // is what gates it and .tmb never has to be reachable as a path.
    if (params.get("thumb") === "1") {
      const thumbName = await existingThumbForFile(target, stat);
      if (!thumbName) {
        throw new ElfinderError("errFileNotFound");
      }
      const thumbPath = path.resolve(TMB_DIR, thumbName);
      return streamFile(thumbPath, await fs.stat(thumbPath), {
        filename: thumbName,
        contentType: "image/png",
        disposition: "inline",
        rangeHeader,
        cache: "revalidate",
      });
    }

    const filename = path.posix.basename(target);
    const contentType = mime.lookup(filename) || "application/octet-stream";
    const download = params.get("download") === "1";
    // Only hand back an inline response for types the browser cannot be talked
    // into executing on this origin; everything else becomes a download even
    // when elFinder asked to preview it.
    const disposition = !download && isInlineSafeMime(contentType) ? "inline" : "attachment";

    return streamFile(absolute, stat, {
      filename,
      contentType,
      disposition,
      rangeHeader,
      cache: "revalidate",
    });
  }

  /**
   * Streams a file on disk as an HTTP response, honouring a Range request.
   *
   * Shared by cmd=file and the second phase of zipdl, which need identical framing:
   * both must stream rather than buffer, and both must answer ranged requests so a
   * browser can resume or seek.
   *
   * Volume files are `private, no-cache` with validators: private because the route
   * may sit behind `authorize`, and revalidated because a file's URL does not change
   * when it is overwritten. An unchanged file then costs a 304 rather than a full
   * download. The zipdl archive is single-use and is never stored.
   */
  function streamFile(
    absolutePath: string,
    stat: { size: number; mtimeMs: number },
    options: {
      filename: string;
      contentType: string;
      disposition: "inline" | "attachment";
      rangeHeader: string | null;
      cache: "revalidate" | "no-store";
    },
  ): NextResponse {
    const baseHeaders: Record<string, string> = {
      "Content-Type": options.contentType,
      "Content-Disposition": contentDisposition(options.filename, options.disposition),
      "X-Content-Type-Options": "nosniff",
      // Without this the browser will not seek in audio or video previews.
      "Accept-Ranges": "bytes",
    };

    if (options.cache === "no-store") {
      baseHeaders["Cache-Control"] = "no-store";
    } else {
      // Weak: equal size and mtime say the content is the same, not the bytes proven.
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const modifiedSeconds = Math.floor(stat.mtimeMs / 1000);
      const validators = {
        "Cache-Control": "private, no-cache",
        ETag: etag,
        "Last-Modified": new Date(modifiedSeconds * 1000).toUTCString(),
      };
      if (isNotModified(etag, modifiedSeconds)) {
        return new NextResponse(null, { status: 304, headers: validators });
      }
      Object.assign(baseHeaders, validators);
    }

    const range = parseRange(options.rangeHeader, stat.size);
    if (range === "unsatisfiable") {
      return new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${stat.size}` },
      });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;

    // Streamed rather than read into a buffer: a large file would otherwise be
    // held in memory in full, once per concurrent request.
    const source = createReadStream(absolutePath, stat.size === 0 ? {} : { start, end });
    const body = Readable.toWeb(source) as ReadableStream<Uint8Array>;

    return new NextResponse(body, {
      status: range ? 206 : 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(length),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      },
    });
  }

  /**
   * Evaluates If-None-Match, or If-Modified-Since when that is absent, as RFC 9110
   * orders them. ETags compare weakly, which is what a GET revalidation calls for.
   */
  function isNotModified(etag: string, modifiedSeconds: number): boolean {
    const headers = scopeStorage.getStore()?.headers;
    if (!headers) {
      return false;
    }
    const ifNoneMatch = headers.get("if-none-match");
    if (ifNoneMatch !== null) {
      const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
      return ifNoneMatch
        .split(",")
        .some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
    }
    const since = Date.parse(headers.get("if-modified-since") ?? "");
    return !Number.isNaN(since) && modifiedSeconds * 1000 <= since;
  }

  async function handleLs(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    await requireRead(target);
    const list = (await listDirectory(target)).map((item) => item.name);
    return NextResponse.json({ list });
  }

  async function handleMkfile(params: ParamBag) {
    const target = requireHash(params.get("target"), "errTrgFolderNotFound");
    const name = requireEntryName(params.get("name"), "newfile.txt");
    await requireWrite(target);
    const relative = normalizeRelativePath(target ? `${target}/${name}` : name);
    // "wx": an existing file of the same name answers errExists rather than being
    // truncated to zero bytes.
    await fs.writeFile(await resolveWithinRoot(relative), "", { flag: "wx" });
    return NextResponse.json({ added: [await toFileInfo(relative)] });
  }

  async function handleGet(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    await requireRead(target);
    const bytes = await fs.readFile(await resolveWithinRoot(target));

    // elFinder's editor sends `conv=1` to mean "give me the file even if it is not
    // valid UTF-8". Without the check, invalid bytes were silently replaced with
    // U+FFFD, and saving the result back destroyed the file. Refusing by default lets
    // the client offer to open it read-only instead.
    const text = bytes.toString("utf8");
    if (!isTruthy(params.get("conv")) && text.includes("�")) {
      const roundTrip = Buffer.from(text, "utf8");
      if (!roundTrip.equals(bytes)) {
        throw new ElfinderError("errNotUTF8Content");
      }
    }

    return NextResponse.json({ content: text });
  }

  async function handlePut(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    await requireWrite(target);
    const content = params.get("content") ?? "";
    await fs.writeFile(await resolveWithinRoot(target), content, "utf8");
    return NextResponse.json({ changed: [await toFileInfo(target)] });
  }

  async function handleInfo(params: ParamBag) {
    const targets = getTargets(params);
    const readable: string[] = [];
    const decoded = targets
      .map((hash) => decodeHashStrict(hash))
      .filter((relative): relative is string => relative !== null);
    for (const relative of decoded) {
      // Omitted rather than refused: elFinder asks about a whole selection at once,
      // and one forbidden item should not blank out the rest.
      if ((await permissionFor(relative)).read) {
        readable.push(relative);
      }
    }
    const files = await Promise.all(readable.map((relative) => toFileInfo(relative)));
    return NextResponse.json({ files });
  }

  /**
   * Picks the first unused `name(copy)`, `name(copy 2)`, … in a directory.
   *
   * Duplicating twice used to fail: the name was always `name(copy)` and the second
   * attempt hit errorOnExist. elFinder's own numbering is what users expect here.
   */
  async function firstFreeCopyName(
    parent: string,
    base: string,
    ext: string,
  ): Promise<string> {
    for (let attempt = 1; attempt <= 1000; attempt++) {
      const suffix = attempt === 1 ? "(copy)" : `(copy ${attempt})`;
      const candidate = `${base}${suffix}${ext}`;
      const relative = normalizeRelativePath(parent ? `${parent}/${candidate}` : candidate);
      try {
        await fs.stat(await resolveWithinRoot(relative));
      } catch {
        return relative;
      }
    }
    throw new ElfinderError("errExists");
  }

  async function handleDuplicate(params: ParamBag) {
    const targets = getTargets(params);
    const added: ElfinderFile[] = [];
    for (const targetHash of targets) {
      const sourceRel = decodeHash(targetHash);
      if (!sourceRel) {
        continue;
      }
      await requireRead(sourceRel);
      await requireWrite(parentOf(sourceRel));
      const sourceAbs = await resolveWithinRoot(sourceRel);
      const ext = path.posix.extname(sourceRel);
      const base = path.posix.basename(sourceRel, ext);
      const parent = normalizeRelativePath(path.posix.dirname(sourceRel));
      const destRel = await firstFreeCopyName(parent, base, ext);
      await fs.cp(sourceAbs, await resolveWithinRoot(destRel), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      added.push(await toFileInfo(destRel));
    }
    return NextResponse.json({ added });
  }

  async function handlePaste(params: ParamBag) {
    const dst = requireHash(params.get("dst"), "errTrgFolderNotFound");
    await requireWrite(dst);
    const cut = isTruthy(params.get("cut"));
    const renames = new Set(params.getAll("renames[]"));
    const suffix = params.get("suffix") || "_copy";
    const targets = getTargets(params);

    const added: ElfinderFile[] = [];
    const removed: string[] = [];
    const changed = new Set<string>();

    for (const targetHash of targets) {
      const sourceRel = decodeHash(targetHash);
      if (!sourceRel) {
        continue;
      }
      await requireRead(sourceRel);
      if (cut) {
        await requireMutable(sourceRel);
      }
      const sourceAbs = await resolveWithinRoot(sourceRel);
      const sourceName = path.posix.basename(sourceRel);
      const finalName = renames.has(sourceName) ? suffixName(sourceName, suffix) : sourceName;
      const destRel = normalizeRelativePath(dst ? `${dst}/${finalName}` : finalName);
      const destAbs = await resolveWithinRoot(destRel);

      // Moving or copying a folder into its own subtree is unsatisfiable: the
      // destination would be a child of the thing being moved. fs.cp would recurse
      // into the copy it is making, and fs.rename fails obscurely.
      if (destAbs === sourceAbs || destAbs.startsWith(`${sourceAbs}${path.sep}`)) {
        throw new ElfinderError("errCopyInItself");
      }

      if (cut) {
        // Same as rename: the source path's thumbnails die with the move.
        const owners = await collectThumbOwners(sourceRel, sourceAbs);
        await movePath(sourceAbs, destAbs);
        await removeThumbsForPaths(owners);
        removed.push(targetHash);
      } else {
        // Checked up front so copy and cut report the same errExists with the
        // conflicting name, rather than copy surfacing a bare EEXIST.
        await assertNotOccupied(destAbs, sourceAbs);
        await fs.cp(sourceAbs, destAbs, { recursive: true, errorOnExist: true, force: false });
      }

      added.push(await toFileInfo(destRel));
      changed.add(encodeHash(dst));
    }

    return NextResponse.json({ added, removed, changed: Array.from(changed) });
  }

  async function handleSearch(params: ParamBag) {
    const q = params.get("q") || "";
    const target = decodeHash(params.get("target"));
    if (!q) {
      return NextResponse.json({ files: [] });
    }

    await requireRead(target);
    const base = await resolveWithinRoot(target);
    const needle = q.toLowerCase();
    const files: ElfinderFile[] = [];

    // Bounded: an unbounded walk over a large volume is a slow request that ends in a
    // response too big to render. Stopping at the cap keeps both in hand, and the walk
    // now skips .tmb and .chunks, which used to surface thumbnails and half-uploaded
    // chunk parts as search hits.
    await walkRecursive(base, async (fullPath) => {
      if (!path.basename(fullPath).toLowerCase().includes(needle)) {
        return;
      }
      const relative = relFromAbs(fullPath);
      if (!(await permissionFor(relative)).read) {
        return;
      }
      files.push(await toFileInfo(relative));
      return files.length < MAX_SEARCH_RESULTS;
    });

    return NextResponse.json({ files });
  }

  async function handleSize(params: ParamBag) {
    const targets = getTargets(params);
    let total = 0;
    for (const targetHash of targets) {
      // Strict, because the volume root decodes to "" and a falsy check would skip it:
      // asking for the size of the whole volume used to answer 0.
      const rel = decodeHashStrict(targetHash);
      if (rel === null) {
        continue;
      }
      await requireRead(rel);
      const abs = await resolveWithinRoot(rel);
      const st = await fs.stat(abs);
      if (!st.isDirectory()) {
        total += st.size;
        continue;
      }
      // A directory's own stat size is its inode overhead, not its contents, so the
      // folder sizes elFinder showed were meaningless.
      await walkRecursive(abs, async (fullPath) => {
        const child = await fs.stat(fullPath).catch(() => null);
        if (child && !child.isDirectory()) {
          total += child.size;
        }
      });
    }
    return NextResponse.json({ size: String(total) });
  }

  async function handleTmb(params: ParamBag) {
    const images: Record<string, string> = {};
    const touchedPaths: string[] = [];
    const freshNames = new Set<string>();

    const generate = async (targetHash: string, relative: string) => {
      // Generation happens here, not during directory listing, so this is the
      // request that pays for it.
      const thumb = await ensureThumbForFile(relative);
      if (!thumb) {
        return;
      }
      images[targetHash] = thumbReference(relative, thumb);
      touchedPaths.push(relative);
      freshNames.add(thumb);
    };

    const targets = getTargets(params);
    if (targets.length > 0) {
      for (const targetHash of targets) {
        const relative = decodeHash(targetHash);
        if (!relative) {
          continue;
        }
        try {
          if (!(await permissionFor(relative)).read) {
            continue;
          }
          await generate(targetHash, relative);
        } catch {
          // ignore invalid target
        }
      }
    } else {
      const current = decodeHash(params.get("current"));
      for (const item of await listDirectory(current)) {
        if (item.mime === "directory" || !isImageMime(item.mime)) {
          continue;
        }
        const relative = decodeHash(item.hash);
        if (!relative) {
          continue;
        }
        await generate(item.hash, relative);
      }
    }

    // One pass for the whole request: drops thumbnails superseded by the ones just
    // written, so .tmb does not grow by one file per edit.
    await removeThumbsForPaths(touchedPaths, freshNames);

    return NextResponse.json({ images });
  }

  async function addPathToZip(zip: ZipAdapter, absolutePath: string, zipEntryName: string) {
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      zip.addLocalFolder(absolutePath, zipEntryName);
      return;
    }
    zip.addLocalFile(
      absolutePath,
      path.posix.dirname(zipEntryName),
      path.posix.basename(zipEntryName),
    );
  }

  async function handleArchive(params: ParamBag) {
    const target = requireHash(params.get("target"), "errTrgFolderNotFound");
    const name = requireEntryName(params.get("name"), "archive.zip");
    const archiveRel = normalizeRelativePath(target ? `${target}/${name}` : name);
    await requireWrite(target);
    const archiveAbs = await resolveWithinRoot(archiveRel);
    // writeZip replaces whatever is there, so check before collecting anything.
    await assertNotOccupied(archiveAbs);
    const zip = new (AdmZip as unknown as new () => ZipAdapter)();
    for (const targetHash of getTargets(params)) {
      const rel = decodeHash(targetHash);
      if (!rel) {
        continue;
      }
      await requireRead(rel);
      const abs = await resolveWithinRoot(rel);
      await addPathToZip(zip, abs, path.posix.basename(rel));
    }
    zip.writeZip(archiveAbs);
    return NextResponse.json({ added: [await toFileInfo(archiveRel)] });
  }

  async function handleExtract(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    const makedir = isTruthy(params.get("makedir"));
    const zipAbs = await resolveWithinRoot(target);
    const zip = new (AdmZip as unknown as new (path: string) => ZipAdapter)(zipAbs);
    const sourceParent = normalizeRelativePath(path.posix.dirname(target));
    const sourceBase = path.posix.basename(target, path.posix.extname(target));
    const outputRel = makedir
      ? normalizeRelativePath(sourceParent ? `${sourceParent}/${sourceBase}` : sourceBase)
      : sourceParent;
    await requireRead(target);
    await requireWrite(outputRel);
    const outputAbs = await resolveWithinRoot(outputRel);

    // Validate the whole archive before writing a single byte, so a malicious
    // entry halfway through cannot leave a half-extracted tree behind.
    const entries = zip.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new ElfinderError("errArcMaxSize");
    }

    let declaredBytes = 0;
    const planned: Array<{ entry: ZipEntry; absolute: string }> = [];
    for (const entry of entries) {
      const relative = safeEntryPath(entry.entryName);
      if (!relative) {
        throw new ElfinderError("errArcSymlinks");
      }
      const absolute = path.resolve(outputAbs, relative);
      assertWithin(outputAbs, absolute);
      declaredBytes += entry.header.size;
      if (declaredBytes > MAX_ARCHIVE_BYTES) {
        throw new ElfinderError("errArcMaxSize");
      }
      planned.push({ entry, absolute });
    }

    await fs.mkdir(outputAbs, { recursive: true });
    for (const { entry, absolute } of planned) {
      if (entry.isDirectory) {
        await fs.mkdir(absolute, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, entry.getData());
    }

    // Only what this archive actually produced. Listing the whole output directory
    // reported every pre-existing sibling as newly added, which elFinder renders as
    // duplicate rows when extracting into a folder that already has contents.
    const topLevel = new Set(
      planned
        .map(({ entry }) => safeEntryPath(entry.entryName)?.split("/")[0])
        .filter((name): name is string => Boolean(name)),
    );

    const added: ElfinderFile[] = [];
    for (const name of topLevel) {
      const rel = normalizeRelativePath(outputRel ? `${outputRel}/${name}` : name);
      added.push(await toFileInfo(rel));
    }

    return NextResponse.json({ added });
  }

  /**
   * "Download as zip", which elFinder performs in two requests.
   *
   * Phase one selects the items and gets back an opaque id. Phase two asks for that
   * id with `download=1`, and carries four targets: the current directory, the id,
   * the filename and the mime type. The previous implementation only understood phase
   * one, so the download never arrived — and it wrote the archive into the user's own
   * folder, where it stayed as litter and appeared in listings.
   *
   * The archive now lands in the volume's `.tmp` directory under a random id, is
   * streamed out on phase two and deleted immediately after, and is swept on a TTL if
   * phase two never comes.
   */
  async function handleZipdl(params: ParamBag, rangeHeader: string | null) {
    const targets = getTargets(params);
    if (targets.length === 0) {
      throw new ElfinderError("errCmdParams");
    }

    if (isTruthy(params.get("download"))) {
      return serveZipdlArchive(targets, rangeHeader);
    }

    const first = decodeHash(targets[0]);
    const parent = normalizeRelativePath(path.posix.dirname(first));
    const parentName = parent ? path.posix.basename(parent) : ROOT_NAME;
    const filename = `${parentName}.zip`;

    const zip = new (AdmZip as unknown as new () => ZipAdapter)();
    for (const targetHash of targets) {
      const rel = decodeHash(targetHash);
      if (!rel) {
        continue;
      }
      // Read access is all this needs. It does not write into the volume, so it must
      // not demand write on a folder the caller may only read from.
      await requireRead(rel);
      await addPathToZip(zip, await resolveWithinRoot(rel), path.posix.basename(rel));
    }

    await fs.mkdir(TMP_DIR, { recursive: true });
    await sweepStaleTemp();
    const id = randomUUID();
    zip.writeZip(path.resolve(TMP_DIR, `${id}.zip`));

    return NextResponse.json({
      zipdl: {
        file: id,
        name: filename,
        mime: "application/zip",
      },
    });
  }

  /** Phase two of zipdl: stream the staged archive, then delete it. */
  async function serveZipdlArchive(targets: string[], rangeHeader: string | null) {
    // targets are [cwd hash, id, name, mime].
    const id = targets[1] ? safeSegment(targets[1]) : null;
    const filename = safeSegment(targets[2] ?? "") ?? "archive.zip";
    if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) {
      throw new ElfinderError("errFileNotFound");
    }

    const archive = path.resolve(TMP_DIR, `${id}.zip`);
    assertWithin(TMP_DIR, archive);

    let stat;
    try {
      stat = await fs.stat(archive);
    } catch {
      throw new ElfinderError("errFileNotFound");
    }

    const response = streamFile(archive, stat, {
      filename,
      contentType: "application/zip",
      disposition: "attachment",
      rangeHeader,
      cache: "no-store",
    });

    // A ranged request is one of several for the same archive, so only a whole-body
    // response means the client is done with it.
    if (response.status === 200) {
      queueDelete(archive);
    }
    return response;
  }

  /**
   * Deletes a staged archive once the response has had a chance to be read.
   *
   * The stream is already attached to the response, so the file cannot be unlinked
   * synchronously on Windows, where an open handle blocks it. The TTL sweep is the
   * backstop if this never runs.
   */
  function queueDelete(absolutePath: string): void {
    setTimeout(() => {
      void rmWithRetry(absolutePath, { force: true }).catch(() => {});
    }, 30_000).unref?.();
  }

  /** Reads an image file into a buffer, refusing anything that is not a file. */
  async function readImageSource(target: string): Promise<{ absolute: string; input: Buffer }> {
    const absolute = await resolveWithinRoot(target);
    if (!(await fs.stat(absolute)).isFile()) {
      throw new ElfinderError("errNotFile");
    }
    // A buffer rather than a path, as for thumbnails, so libvips never holds the
    // file open and blocks a later unlink on Windows.
    return { absolute, input: await fs.readFile(absolute) };
  }

  async function handleDim(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    await requireRead(target);
    const { input } = await readImageSource(target);

    let width: number | undefined;
    let height: number | undefined;
    try {
      ({ width, height } = await sharp(input).metadata());
    } catch {
      // Not an image sharp can read.
    }
    if (!width || !height) {
      throw new ElfinderError("errUsupportType");
    }
    return NextResponse.json({ dim: `${width}x${height}` });
  }

  /** Largest side resize and crop accept, so one request cannot allocate gigapixels. */
  const MAX_EDIT_SIDE = 10_000;

  /**
   * Resizes, crops or rotates an image in place, as the client's resize dialog asks.
   *
   * The client computes the final box itself, keeping the aspect ratio if the user
   * asked it to, so `resize` fills exactly width x height. The format is kept, and
   * the result replaces the file only once it has been fully written.
   */
  async function handleResize(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    await requireWrite(target);
    const name = path.posix.basename(target);
    const badParams = () => new ElfinderError(["errCmdParams", "resize"]);

    const intParam = (key: string, min: number, max: number): number => {
      const raw = params.get(key) ?? "";
      const value = Number(raw);
      if (!/^-?\d+$/.test(raw.trim()) || value < min || value > max) {
        throw badParams();
      }
      return value;
    };

    const mode = params.get("mode") || "resize";
    if (mode !== "resize" && mode !== "crop" && mode !== "rotate") {
      throw badParams();
    }
    const box =
      mode === "rotate"
        ? null
        : { width: intParam("width", 1, MAX_EDIT_SIDE), height: intParam("height", 1, MAX_EDIT_SIDE) };
    const degree = mode === "rotate" ? intParam("degree", -360, 360) : 0;
    const offset =
      mode === "crop" ? { left: intParam("x", 0, MAX_EDIT_SIDE), top: intParam("y", 0, MAX_EDIT_SIDE) } : null;
    const quality = Number(params.get("quality"));

    const { absolute, input } = await readImageSource(target);

    let output: Buffer;
    try {
      let image = sharp(input);
      const { format } = await image.metadata();
      if (box && offset) {
        image = image.extract({ ...offset, ...box });
      } else if (box) {
        image = image.resize(box.width, box.height, { fit: "fill" });
      } else {
        // The client sends a background colour for the corners a rotation exposes;
        // without one, formats with alpha get transparency and JPEG gets white.
        const bg = params.get("bg") || (format === "jpeg" ? "#ffffff" : "#00000000");
        image = image.rotate(degree, { background: bg });
      }
      if (format === "jpeg" && quality >= 1 && quality <= 100) {
        image = image.jpeg({ quality });
      }
      output = await image.toBuffer();
    } catch {
      throw new ElfinderError(["errResize", name]);
    }

    // Written aside and renamed over the original, so a failure part-way through
    // cannot leave a truncated image behind.
    await fs.mkdir(TMP_DIR, { recursive: true });
    const staged = path.resolve(TMP_DIR, `${randomUUID()}.resize`);
    await fs.writeFile(staged, output);
    await fs.rename(staged, absolute);
    // The thumbnail name tracks size and mtime, so the old one is now unreachable.
    await removeThumbsForPaths([target]);

    return NextResponse.json({ changed: [await toFileInfo(target)] });
  }

  function toParamBagFromSearchParams(params: URLSearchParams): ParamBag {
    return {
      get: (key) => params.get(key),
      getAll: (key) => params.getAll(key),
    };
  }

  function toParamBagFromFormData(formData: FormData): ParamBag {
    return {
      get: (key) => {
        const value = formData.get(key);
        return typeof value === "string" ? value : null;
      },
      getAll: (key) =>
        formData.getAll(key).filter((value): value is string => typeof value === "string"),
    };
  }

  async function executeCommand(
    cmd: string | null,
    params: ParamBag,
    rangeHeader: string | null = null,
  ) {
    switch (cmd) {
      case "open":
        return handleOpen(params);
      case "tree":
        return handleTree(params);
      case "parents":
        return handleParents(params);
      case "mkdir":
        return handleMkdir(params);
      case "rm":
        return handleRm(params);
      case "rename":
        return handleRename(params);
      case "file":
        return handleFile(params, rangeHeader);
      case "ls":
        return handleLs(params);
      case "mkfile":
        return handleMkfile(params);
      case "get":
        return handleGet(params);
      case "put":
        return handlePut(params);
      case "info":
        return handleInfo(params);
      case "duplicate":
        return handleDuplicate(params);
      case "paste":
        return handlePaste(params);
      case "search":
        return handleSearch(params);
      case "size":
        return handleSize(params);
      case "tmb":
        return handleTmb(params);
      case "archive":
        return handleArchive(params);
      case "extract":
        return handleExtract(params);
      case "zipdl":
        return handleZipdl(params, rangeHeader);
      case "dim":
        return handleDim(params);
      case "resize":
        return handleResize(params);
      default:
        return NextResponse.json({ error: ["errUnknownCmd"] });
    }
  }

  /**
   * Performs the merge the client asks for after a chunked upload reports completion.
   *
   * The staging directory is normally found from `cid`, but the protocol only promises
   * `chunk` and `upload[]` on this request, so a scan is the fallback rather than a
   * failed upload.
   */
  async function mergeChunks(options: {
    base: string;
    cid: string | null;
    nameHints: string[];
    uploadTarget: string;
    target: string;
    uploadPathValues: string[];
  }): Promise<NextResponse> {
    const base = safeSegment(options.base);
    if (!base) {
      throw new ElfinderError("errInvName");
    }

    const located = await findChunkStaging(base, options.cid);
    if (!located) {
      throw new ElfinderError("errUploadTemp");
    }
    const { dir: chunkTempDir, parts } = located;

    const destinationDir = await uploadDestination(
      options.uploadTarget,
      options.target,
      options.uploadPathValues,
    );

    const realFilename = chooseUploadFilename([
      options.uploadPathValues[0] ?? "",
      options.nameHints[0] ?? "",
      base,
    ]);
    const finalName = safeSegment(realFilename);
    if (!finalName) {
      throw new ElfinderError("errInvName");
    }

    const finalAbsolute = path.resolve(destinationDir, finalName);
    assertWithin(destinationDir, finalAbsolute);

    // Streamed part by part: the parts together are the whole file, so reading them
    // all into memory would defeat the point of having chunked it.
    const sink = createWriteStream(finalAbsolute);
    try {
      for (const partName of parts) {
        const source = createReadStream(path.resolve(chunkTempDir, partName));
        await pipeline(source, sink, { end: false });
      }
    } finally {
      await new Promise<void>((resolve) => sink.end(resolve));
    }

    await rmWithRetry(chunkTempDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json({ added: [await toFileInfo(relFromAbs(finalAbsolute))] });
  }

  /** Finds the staging directory holding the parts for `base`, preferring `cid`. */
  async function findChunkStaging(
    base: string,
    cid: string | null,
  ): Promise<{ dir: string; parts: string[] } | null> {
    const candidates: string[] = [];
    const cidSegment = cid ? safeSegment(cid) : null;
    if (cidSegment) {
      candidates.push(cidSegment);
    }
    for (const name of await fs.readdir(CHUNK_DIR).catch(() => [] as string[])) {
      if (name !== cidSegment) {
        candidates.push(name);
      }
    }

    for (const name of candidates) {
      const dir = path.resolve(CHUNK_DIR, name);
      try {
        assertWithin(CHUNK_DIR, dir);
      } catch {
        continue;
      }
      const parts = await chunkPartNamesForBase(dir, base);
      if (parts.length > 0) {
        return { dir, parts };
      }
    }
    return null;
  }

  /** Where an upload's files land, honouring the subdirectory in `upload_path[]`. */
  async function uploadDestination(
    uploadTarget: string,
    target: string,
    uploadPathValues: string[],
  ): Promise<string> {
    if (uploadPathValues.length === 0) {
      return uploadTarget;
    }
    const subdir = normalizeRelativePath(path.posix.dirname(uploadPathValues[0]));
    if (!subdir) {
      return uploadTarget;
    }
    const resolved = await resolveWithinRoot(target ? `${target}/${subdir}` : subdir);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }

  async function handleUpload(formData: FormData) {
    // Awaited rather than fired and forgotten: it is a single directory scan, rate
    // limited to once per interval, and a detached promise would not survive the
    // end of a serverless invocation anyway.
    await sweepStaleTemp();

    const target = requireHash(
      formData.get("target") as string | null,
      "errTrgFolderNotFound",
    );
    await requireWrite(target);
    const uploadTarget = await resolveWithinRoot(target);
    await fs.mkdir(uploadTarget, { recursive: true });

    const uploads = formData.getAll("upload[]").filter((f): f is File => f instanceof File);

    // Enforced as well as advertised: a client that ignores uplMaxFile or uplMaxSize,
    // or a request that never came from elFinder at all, must not be able to fill the
    // disk. elFinder renders both of these keys with the limit it was told.
    if (MAX_UPLOAD_FILES > 0 && uploads.length > MAX_UPLOAD_FILES) {
      throw new ElfinderError("errUploadFile");
    }
    if (MAX_UPLOAD_BYTES > 0) {
      for (const upload of uploads) {
        if (upload.size > MAX_UPLOAD_BYTES) {
          throw new ElfinderError(["errUploadFileSize", upload.name || "upload"]);
        }
      }
    }

    const chunk = formData.get("chunk");
    const cid = formData.get("cid");
    const range = formData.get("range");
    const uploadPathValues = formData
      .getAll("upload_path[]")
      .filter((value): value is string => typeof value === "string");

    if (
      typeof chunk === "string" &&
      chunk.length > 0 &&
      typeof range === "string" &&
      range.length > 0 &&
      uploads.length > 0
    ) {
      const upload = uploads[0];
      const destinationDir = await uploadDestination(uploadTarget, target, uploadPathValues);

      // `cid` and `chunk` are client-supplied. Neither may widen the path: both
      // are reduced to a single segment and the result is re-checked against
      // CHUNK_DIR before anything is written.
      const chunkName = safeSegment(chunk);
      if (!chunkName) {
        throw new ElfinderError("errInvName");
      }

      const cidSegment = typeof cid === "string" ? safeSegment(cid) : null;
      const chunkNamespace = cidSegment ?? encodeHash(relFromAbs(destinationDir));
      const chunkTempDir = path.resolve(CHUNK_DIR, chunkNamespace);
      assertWithin(CHUNK_DIR, chunkTempDir);
      await fs.mkdir(chunkTempDir, { recursive: true });

      const chunkPath = path.resolve(chunkTempDir, chunkName);
      assertWithin(chunkTempDir, chunkPath);
      await fs.writeFile(chunkPath, Buffer.from(await upload.arrayBuffer()));

      const rangeParts = range
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));
      const total = rangeParts.length >= 3 ? rangeParts[2] : Number.POSITIVE_INFINITY;

      // A chunked upload declares its full size up front, which is the only chance to
      // refuse an oversized file before writing all of it: the per-file check above
      // only ever sees one slice.
      if (MAX_UPLOAD_BYTES > 0 && Number.isFinite(total) && total > MAX_UPLOAD_BYTES) {
        await rmWithRetry(chunkTempDir, { recursive: true, force: true }).catch(() => {});
        throw new ElfinderError(["errUploadFileSize", chunkName]);
      }

      const chunkStat = await fs.stat(chunkPath);

      // Completion is judged by how many bytes have actually landed, not by this
      // chunk's offset. Chunks are uploaded in parallel, so the slice covering the end
      // of the file can arrive before the middle ones and would otherwise trigger a
      // merge over an incomplete set, truncating the result.
      const partsOnDisk = await chunkPartSizes(chunkTempDir, chunkName);
      const bytesOnDisk = partsOnDisk.reduce((sum, size) => sum + size, 0);
      const isLastChunk = Number.isFinite(total) && bytesOnDisk >= total;

      if (!isLastChunk) {
        return NextResponse.json({ added: [] });
      }

      // All parts have landed, so report completion and stop. The merge happens on the
      // request the client sends next, carrying these two values back as `chunk` and
      // `upload[]`. Returning the pair on every intermediate chunk, as this used to,
      // made the client ask to merge after each slice.
      const pathDerivedFilename = uploadPathValues.length > 0 ? uploadPathValues[0] : "";
      const realFilename = chooseUploadFilename([
        pathDerivedFilename,
        upload.name || "",
        chunkBaseName(chunkName),
      ]);
      return NextResponse.json({
        added: [],
        _chunkmerged: chunkBaseName(chunkName),
        _name: realFilename,
      });
    }

    // Chunk merge request: `chunk` is set but there is no range and no file, because
    // the client sends the name string it was given rather than another slice.
    if (typeof chunk === "string" && chunk.length > 0) {
      return mergeChunks({
        base: chunk,
        cid: typeof cid === "string" ? cid : null,
        nameHints: formData
          .getAll("upload[]")
          .filter((value): value is string => typeof value === "string"),
        uploadTarget,
        target,
        uploadPathValues,
      });
    }

    const added: ElfinderFile[] = [];

    for (const [index, upload] of uploads.entries()) {
      const rawUploadPath = uploadPathValues[index];
      const uploadSubdir = rawUploadPath
        ? normalizeRelativePath(path.posix.dirname(rawUploadPath))
        : "";
      const uploadFilename = chooseUploadFilename([rawUploadPath, upload.name]);
      const uploadPath = normalizeRelativePath(
        uploadSubdir ? `${uploadSubdir}/${uploadFilename}` : uploadFilename,
      );
      const relative = normalizeRelativePath(target ? `${target}/${uploadPath}` : uploadPath);
      const absolute = await resolveWithinRoot(relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const data = Buffer.from(await upload.arrayBuffer());
      await fs.writeFile(absolute, data);
      added.push(await toFileInfo(relative));
    }

    return NextResponse.json({ added });
  }

  /**
   * Runs the caller's `authorize` hook and returns the session it yields.
   *
   * A missing hook leaves the connector open, which is the documented default.
   * Anything falsy is a denial: a callback that forgets to return a value must not
   * accidentally grant access. Every failure becomes an ElfinderAuthError, the one
   * case answered with HTTP 403 rather than the 200 envelope.
   */
  async function resolveSession(req: NextRequest): Promise<unknown> {
    if (!AUTHORIZE) {
      return undefined;
    }
    let session: unknown;
    try {
      session = await AUTHORIZE(req);
    } catch (error) {
      throw new ElfinderAuthError(
        error instanceof ElfinderError ? error.payload : "errAccess",
        { cause: error },
      );
    }
    if (session === null || session === undefined || session === false) {
      throw new ElfinderAuthError();
    }
    return session;
  }

  /** Establishes the request scope, so permission lookups can find the session. */
  async function withScope<T>(req: NextRequest, run: () => Promise<T>): Promise<T> {
    const session = await resolveSession(req);
    const connectorUrl = `${req.nextUrl.basePath}${req.nextUrl.pathname}`;
    return scopeStorage.run(
      { session, cache: new Map(), connectorUrl, headers: req.headers },
      run,
    );
  }

  async function GET(req: NextRequest) {
    try {
      return await withScope(req, async () => {
        await ensureUploadDir();
        const params = req.nextUrl.searchParams;
        return await executeCommand(
          params.get("cmd"),
          toParamBagFromSearchParams(params),
          req.headers.get("range"),
        );
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  async function POST(req: NextRequest) {
    try {
      return await withScope(req, () => handlePost(req));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  async function handlePost(req: NextRequest) {
    {
      await ensureUploadDir();
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        const cmd = String(formData.get("cmd") || "upload");
        if (cmd === "upload") {
          return await handleUpload(formData);
        }
        return await executeCommand(cmd, toParamBagFromFormData(formData));
      }

      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const cmd = typeof body.cmd === "string" ? body.cmd : null;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(key, String(item));
          }
        } else if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
      return await executeCommand(cmd, toParamBagFromSearchParams(params));
    }
  }

  return { GET, POST, runtime: "nodejs" as const };
}
