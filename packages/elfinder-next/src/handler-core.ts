import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import mime from "mime-types";
import AdmZip from "adm-zip";
import sharp from "sharp";
import type { ElfinderContext } from "./context.js";
import { ElfinderError, toErrorResponse } from "./errors.js";
import type { ElfinderFile, ElfinderHandlers } from "./types.js";

// libvips keeps input file handles in its cache; on Windows that blocks unlink (EBUSY).
sharp.cache({ files: 0 });

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

type ZipAdapter = {
  addLocalFolder: (localPath: string, zipPath?: string) => void;
  addLocalFile: (
    localPath: string,
    zipPath?: string,
    zipName?: string,
    comment?: string,
  ) => void;
  writeZip: (targetFileName?: string) => void;
  extractAllTo: (targetPath: string, overwrite?: boolean) => void;
};

export function createElfinderHandlers(ctx: ElfinderContext): ElfinderHandlers {
  const {
    uploadDir: UPLOAD_DIR,
    rootName: ROOT_NAME,
    volumeId: VOLUME_ID,
    rootHash: ROOT_HASH,
    tmbDir: TMB_DIR,
    chunkDir: CHUNK_DIR,
    publicUrl: PUBLIC_URL,
    tmbUrl: TMB_URL,
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

  function decodeHash(hash?: string | null): string {
    if (!hash || hash === ROOT_HASH) {
      return "";
    }
    if (!hash.startsWith(VOLUME_ID)) {
      return "";
    }
    try {
      const encoded = hash
        .slice(VOLUME_ID.length)
        .replace(/ /g, "+")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = encoded + "=".repeat((4 - (encoded.length % 4 || 4)) % 4);
      return normalizeRelativePath(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return "";
    }
  }

  function resolveWithinRoot(relativePath: string): string {
    const safeRelative = normalizeRelativePath(relativePath);
    const absolute = path.resolve(UPLOAD_DIR, safeRelative);
    const rootPrefix = `${UPLOAD_DIR}${path.sep}`;
    if (absolute !== UPLOAD_DIR && !absolute.startsWith(rootPrefix)) {
      throw new ElfinderError("errAccess");
    }
    return absolute;
  }

  async function ensureUploadDir(): Promise<void> {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.mkdir(TMB_DIR, { recursive: true });
    await fs.mkdir(CHUNK_DIR, { recursive: true });
  }

  function isImageMime(mimeType: string): boolean {
    return mimeType.startsWith("image/");
  }

  function tmbFilenameFromHash(hash: string): string {
    return `${hash}.png`;
  }

  function detectMimeFromName(name: string): string {
    const byLookup = mime.lookup(name);
    if (byLookup) {
      return byLookup;
    }
    const ext = path.posix.extname(name).toLowerCase();
    if (ext === ".pdf") {
      return "application/pdf";
    }
    return "application/octet-stream";
  }

  function looksLikeElfinderHash(value: string): boolean {
    return /^v\d+_[A-Za-z0-9\-_]+$/.test(value);
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

  async function ensureThumbForFile(relativePath: string): Promise<string | null> {
    const normalized = normalizeRelativePath(relativePath);
    const hash = encodeHash(normalized);
    const thumbName = tmbFilenameFromHash(hash);
    const thumbPath = path.resolve(TMB_DIR, thumbName);

    try {
      await fs.access(thumbPath);
      return thumbName;
    } catch {
      // thumbnail does not exist yet
    }

    try {
      // Read into a buffer so sharp never holds a path-based lock on the source file.
      const input = await fs.readFile(resolveWithinRoot(normalized));
      await sharp(input)
        .resize(48, 48, { fit: "inside", withoutEnlargement: true })
        .png()
        .toFile(thumbPath);
      return thumbName;
    } catch {
      return null;
    }
  }

  async function removeThumbForHash(hash: string): Promise<void> {
    const thumbPath = path.resolve(TMB_DIR, tmbFilenameFromHash(hash));
    try {
      await rmWithRetry(thumbPath, { force: true });
    } catch {
      // thumbnail may not exist
    }
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
    const absolutePath = resolveWithinRoot(normalized);
    const stat = await fs.stat(absolutePath);
    const isDir = stat.isDirectory();
    const parent = normalizeRelativePath(path.posix.dirname(normalized));

    const info: ElfinderFile = {
      name: normalized ? path.posix.basename(normalized) : ROOT_NAME,
      size: stat.size,
      hash: encodeHash(normalized),
      mime: isDir
        ? "directory"
        : detectMimeFromName(path.posix.basename(normalized)),
      ts: Math.floor(stat.mtimeMs / 1000),
      read: 1,
      write: 1,
      locked: 0,
      volumeid: VOLUME_ID,
    };

    if (normalized) {
      info.phash = encodeHash(parent === "." ? "" : parent);
    } else {
      info.phash = "";
      info.options = {
        disabled: ["chmod", "netmount", "size"],
        archivers: {
          create: [],
          extract: [],
        },
        url: PUBLIC_URL,
        tmbUrl: TMB_URL,
        separator: "/",
      };
    }

    if (isDir) {
      const dirs = await hasSubDirs(absolutePath);
      if (dirs) {
        info.dirs = 1;
      }
    } else if (isImageMime(info.mime)) {
      const thumb = await ensureThumbForFile(normalized);
      info.tmb = thumb ?? "1";
    }

    return info;
  }

  async function listDirectory(relativeDir: string): Promise<ElfinderFile[]> {
    const baseRelative = normalizeRelativePath(relativeDir);
    const absoluteDir = resolveWithinRoot(baseRelative);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.name !== ".tmb" && entry.name !== ".chunks")
        .map(async (entry) => {
          const childRelative = normalizeRelativePath(
            baseRelative ? `${baseRelative}/${entry.name}` : entry.name,
          );
          return toFileInfo(childRelative);
        }),
    );
    return files;
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

  async function movePath(src: string, dst: string) {
    try {
      await fs.rename(src, dst);
    } catch {
      await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
      await rmWithRetry(src, { recursive: true, force: true });
    }
  }

  async function walkRecursive(
    base: string,
    visitor: (fullPath: string) => Promise<void>,
  ) {
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      const current = path.join(base, entry.name);
      await visitor(current);
      if (entry.isDirectory()) {
        await walkRecursive(current, visitor);
      }
    }
  }

  function relFromAbs(absolutePath: string): string {
    return normalizeRelativePath(path.relative(UPLOAD_DIR, absolutePath));
  }

  async function handleOpen(params: ParamBag) {
    const init = params.get("init") === "1";
    let target = decodeHash(params.get("target"));
    if (init && !params.get("target")) {
      target = "";
    }
    if (target) {
      try {
        await fs.stat(resolveWithinRoot(target));
      } catch {
        target = "";
      }
    }
    const cwd = await toFileInfo(target);
    const children = await listDirectory(target);
    const files = init ? [await toFileInfo(""), ...children] : children;

    return NextResponse.json({
      ...(init ? { api: "2.1" } : {}),
      cwd,
      files,
      options: {
        uiCmdMap: [],
        tmbUrl: TMB_URL,
      },
    });
  }

  async function handleTree(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    const files = await listDirectory(target);
    return NextResponse.json({
      tree: files.filter((item) => item.mime === "directory"),
    });
  }

  async function handleParents(params: ParamBag) {
    const target = decodeHash(params.get("target"));
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
        .filter((item) => item.mime === "directory")
        .forEach((item) => tree.set(item.hash, item));
      if (!parent || parent === "." || parent === current) {
        break;
      }
      current = parent;
    }

    return NextResponse.json({ tree: Array.from(tree.values()) });
  }

  async function handleMkdir(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    const name = (params.get("name") || "New Folder").trim();
    if (!name) {
      throw new ElfinderError("errInvName");
    }
    const targetRelative = normalizeRelativePath(target ? `${target}/${name}` : name);
    const absolute = resolveWithinRoot(targetRelative);
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
      const absolute = resolveWithinRoot(relative);
      await rmWithRetry(absolute, { recursive: true, force: true });
      await removeThumbForHash(hash);
      removed.push(hash);
    }

    return NextResponse.json({ removed });
  }

  async function handleRename(params: ParamBag) {
    const targetHash = params.get("target");
    const name = (params.get("name") || "").trim();
    if (!targetHash || !name) {
      throw new ElfinderError("errInvName");
    }

    const oldRelative = decodeHash(targetHash);
    if (!oldRelative) {
      throw new ElfinderError("errPerm");
    }

    const parent = normalizeRelativePath(path.posix.dirname(oldRelative));
    const newRelative = normalizeRelativePath(parent ? `${parent}/${name}` : name);
    await fs.rename(resolveWithinRoot(oldRelative), resolveWithinRoot(newRelative));

    return NextResponse.json({
      removed: [targetHash],
      added: [await toFileInfo(newRelative)],
    });
  }

  async function handleFile(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }

    const absolute = resolveWithinRoot(target);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new ElfinderError("errNotFile");
    }

    const data = await fs.readFile(absolute);
    const filename = path.posix.basename(target);
    const contentType = mime.lookup(filename) || "application/octet-stream";
    const download = params.get("download") === "1";

    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.byteLength),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      },
    });
  }

  async function handleLs(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    const list = (await listDirectory(target)).map((item) => item.name);
    return NextResponse.json({ list });
  }

  async function handleMkfile(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    const name = (params.get("name") || "newfile.txt").trim();
    const relative = normalizeRelativePath(target ? `${target}/${name}` : name);
    await fs.writeFile(resolveWithinRoot(relative), "");
    return NextResponse.json({ added: [await toFileInfo(relative)] });
  }

  async function handleGet(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    const content = await fs.readFile(resolveWithinRoot(target), "utf8");
    return NextResponse.json({ content });
  }

  async function handlePut(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    const content = params.get("content") ?? "";
    await fs.writeFile(resolveWithinRoot(target), content, "utf8");
    return NextResponse.json({ changed: [await toFileInfo(target)] });
  }

  async function handleInfo(params: ParamBag) {
    const targets = getTargets(params);
    const files = await Promise.all(
      targets
        .map((hash) => decodeHash(hash))
        .filter(Boolean)
        .map((relative) => toFileInfo(relative)),
    );
    return NextResponse.json({ files });
  }

  async function handleDuplicate(params: ParamBag) {
    const targets = getTargets(params);
    const added: ElfinderFile[] = [];
    for (const targetHash of targets) {
      const sourceRel = decodeHash(targetHash);
      if (!sourceRel) {
        continue;
      }
      const sourceAbs = resolveWithinRoot(sourceRel);
      const ext = path.posix.extname(sourceRel);
      const base = path.posix.basename(sourceRel, ext);
      const parent = normalizeRelativePath(path.posix.dirname(sourceRel));
      const copyName = `${base}(copy)${ext}`;
      const destRel = normalizeRelativePath(parent ? `${parent}/${copyName}` : copyName);
      await fs.cp(sourceAbs, resolveWithinRoot(destRel), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      added.push(await toFileInfo(destRel));
    }
    return NextResponse.json({ added });
  }

  async function handlePaste(params: ParamBag) {
    const dst = decodeHash(params.get("dst"));
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
      const sourceAbs = resolveWithinRoot(sourceRel);
      const sourceName = path.posix.basename(sourceRel);
      const finalName = renames.has(sourceName) ? suffixName(sourceName, suffix) : sourceName;
      const destRel = normalizeRelativePath(dst ? `${dst}/${finalName}` : finalName);
      const destAbs = resolveWithinRoot(destRel);

      if (cut) {
        await movePath(sourceAbs, destAbs);
        removed.push(targetHash);
      } else {
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

    const base = resolveWithinRoot(target);
    const files: ElfinderFile[] = [];
    await walkRecursive(base, async (fullPath) => {
      if (path.basename(fullPath).toLowerCase().includes(q.toLowerCase())) {
        files.push(await toFileInfo(relFromAbs(fullPath)));
      }
    });

    return NextResponse.json({ files });
  }

  async function handleSize(params: ParamBag) {
    const targets = getTargets(params);
    let total = 0;
    for (const targetHash of targets) {
      const rel = decodeHash(targetHash);
      if (!rel) {
        continue;
      }
      const abs = resolveWithinRoot(rel);
      const st = await fs.stat(abs);
      total += st.size;
    }
    return NextResponse.json({ size: String(total) });
  }

  async function handleTmb(params: ParamBag) {
    const images: Record<string, string> = {};

    const targets = getTargets(params);
    if (targets.length > 0) {
      for (const targetHash of targets) {
        const relative = decodeHash(targetHash);
        if (!relative) {
          continue;
        }
        try {
          const info = await toFileInfo(relative);
          if (info.tmb && info.tmb !== "1") {
            images[targetHash] = info.tmb;
          }
        } catch {
          // ignore invalid target
        }
      }
      return NextResponse.json({ images });
    }

    const current = decodeHash(params.get("current"));
    const files = await listDirectory(current);
    for (const item of files) {
      if (item.mime === "directory" || !isImageMime(item.mime)) {
        continue;
      }
      const relative = decodeHash(item.hash);
      if (!relative) {
        continue;
      }
      const thumb = await ensureThumbForFile(relative);
      if (thumb) {
        images[item.hash] = thumb;
      }
    }
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
    const target = decodeHash(params.get("target"));
    const name = (params.get("name") || "archive.zip").trim();
    const archiveRel = normalizeRelativePath(target ? `${target}/${name}` : name);
    const zip = new (AdmZip as unknown as new () => ZipAdapter)();
    for (const targetHash of getTargets(params)) {
      const rel = decodeHash(targetHash);
      if (!rel) {
        continue;
      }
      const abs = resolveWithinRoot(rel);
      await addPathToZip(zip, abs, path.posix.basename(rel));
    }
    zip.writeZip(resolveWithinRoot(archiveRel));
    return NextResponse.json({ added: [await toFileInfo(archiveRel)] });
  }

  async function handleExtract(params: ParamBag) {
    const target = decodeHash(params.get("target"));
    if (!target) {
      throw new ElfinderError("errFileNotFound");
    }
    const makedir = isTruthy(params.get("makedir"));
    const zipAbs = resolveWithinRoot(target);
    const zip = new (AdmZip as unknown as new (path: string) => ZipAdapter)(zipAbs);
    const sourceParent = normalizeRelativePath(path.posix.dirname(target));
    const sourceBase = path.posix.basename(target, path.posix.extname(target));
    const outputRel = makedir
      ? normalizeRelativePath(sourceParent ? `${sourceParent}/${sourceBase}` : sourceBase)
      : sourceParent;
    const outputAbs = resolveWithinRoot(outputRel);
    await fs.mkdir(outputAbs, { recursive: true });
    zip.extractAllTo(outputAbs, true);

    const added: ElfinderFile[] = [];
    const entries = await fs.readdir(outputAbs, { withFileTypes: true });
    for (const entry of entries) {
      const rel = normalizeRelativePath(
        outputRel ? `${outputRel}/${entry.name}` : entry.name,
      );
      added.push(await toFileInfo(rel));
    }

    return NextResponse.json({ added });
  }

  async function handleZipdl(params: ParamBag) {
    const targets = getTargets(params);
    if (targets.length === 0) {
      throw new ElfinderError("errCmdParams");
    }
    const first = decodeHash(targets[0]);
    const parent = normalizeRelativePath(path.posix.dirname(first));
    const parentName = parent ? path.posix.basename(parent) : ROOT_NAME;
    const filename = `${parentName}.zip`;
    const zipRel = normalizeRelativePath(parent ? `${parent}/${filename}` : filename);

    const zip = new (AdmZip as unknown as new () => ZipAdapter)();
    for (const targetHash of targets) {
      const rel = decodeHash(targetHash);
      if (!rel) {
        continue;
      }
      await addPathToZip(zip, resolveWithinRoot(rel), path.posix.basename(rel));
    }
    zip.writeZip(resolveWithinRoot(zipRel));

    return NextResponse.json({
      zipdl: {
        file: encodeHash(zipRel),
        name: filename,
        mime: "application/zip",
      },
    });
  }

  async function handleDim(params: ParamBag) {
    void params;
    return NextResponse.json({ dim: "unknown" });
  }

  async function handleResize(params: ParamBag) {
    void params;
    return NextResponse.json({ error: ["errCmdNoSupport"] });
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

  async function executeCommand(cmd: string | null, params: ParamBag) {
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
        return handleFile(params);
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
        return handleZipdl(params);
      case "dim":
        return handleDim(params);
      case "resize":
        return handleResize(params);
      default:
        return NextResponse.json({ error: ["errUnknownCmd"] });
    }
  }

  async function handleUpload(formData: FormData) {
    const target = decodeHash(formData.get("target") as string | null);
    const uploadTarget = resolveWithinRoot(target);
    await fs.mkdir(uploadTarget, { recursive: true });

    const uploads = formData.getAll("upload[]").filter((f): f is File => f instanceof File);
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
      let destinationDir = uploadTarget;
      if (uploadPathValues.length > 0) {
        const firstPathDir = normalizeRelativePath(path.posix.dirname(uploadPathValues[0]));
        if (firstPathDir) {
          destinationDir = resolveWithinRoot(
            target ? `${target}/${firstPathDir}` : firstPathDir,
          );
          await fs.mkdir(destinationDir, { recursive: true });
        }
      }

      const chunkNamespace =
        typeof cid === "string" && cid.trim().length > 0
          ? cid.trim()
          : encodeHash(relFromAbs(destinationDir));
      const chunkTempDir = path.resolve(CHUNK_DIR, chunkNamespace);
      await fs.mkdir(chunkTempDir, { recursive: true });

      const chunkPath = path.resolve(chunkTempDir, path.posix.basename(chunk));
      await fs.writeFile(chunkPath, Buffer.from(await upload.arrayBuffer()));

      const rangeParts = range
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));
      const start = rangeParts[0] ?? 0;
      const total = rangeParts.length >= 3 ? rangeParts[2] : Number.POSITIVE_INFINITY;
      const chunkStat = await fs.stat(chunkPath);
      const isLastChunk = Number.isFinite(total) && start + chunkStat.size >= total;

      if (!isLastChunk) {
        const realFilename = chunk.replace(/\.\d+_\d+\.part$/, "");
        return NextResponse.json({
          added: [],
          _chunkmerged: chunk,
          _name: realFilename,
        });
      }

      const chunkDerivedFilename = chunk.replace(/\.\d+_\d+\.part$/, "");
      const pathDerivedFilename = uploadPathValues.length > 0 ? uploadPathValues[0] : "";
      const uploadDerivedFilename = upload.name || "";
      const realFilename = chooseUploadFilename([
        pathDerivedFilename,
        uploadDerivedFilename,
        chunkDerivedFilename,
      ]);
      const escapedFilename = realFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const partPattern = new RegExp(`^${escapedFilename}\\.\\d+_\\d+\\.part$`);
      const chunkPrefix = chunk.replace(/\.\d+_\d+\.part$/, "");
      const escapedChunkPrefix = chunkPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const chunkPattern = new RegExp(`^${escapedChunkPrefix}\\.\\d+_\\d+\\.part$`);
      const allChunkFiles = await fs.readdir(chunkTempDir);
      const parts = allChunkFiles
        .filter((name) => partPattern.test(name) || chunkPattern.test(name))
        .sort((a, b) => {
          const aMatch = a.match(/\.(\d+)_\d+\.part$/);
          const bMatch = b.match(/\.(\d+)_\d+\.part$/);
          const aNum = aMatch ? Number(aMatch[1]) : 0;
          const bNum = bMatch ? Number(bMatch[1]) : 0;
          return aNum - bNum;
        });

      if (parts.length === 0) {
        throw new ElfinderError("errUploadTemp");
      }

      const finalAbsolute = path.resolve(destinationDir, path.posix.basename(realFilename));
      await fs.rm(finalAbsolute, { force: true });
      await fs.writeFile(finalAbsolute, Buffer.alloc(0));
      for (const partName of parts) {
        const partBuffer = await fs.readFile(path.resolve(chunkTempDir, partName));
        await fs.appendFile(finalAbsolute, partBuffer);
      }
      await Promise.all(
        parts.map((partName) => fs.rm(path.resolve(chunkTempDir, partName), { force: true })),
      );

      const finalRelative = relFromAbs(finalAbsolute);
      return NextResponse.json({ added: [await toFileInfo(finalRelative)] });
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
      const absolute = resolveWithinRoot(relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const data = Buffer.from(await upload.arrayBuffer());
      await fs.writeFile(absolute, data);
      added.push(await toFileInfo(relative));
    }

    return NextResponse.json({ added });
  }

  async function GET(req: NextRequest) {
    try {
      await ensureUploadDir();
      const params = req.nextUrl.searchParams;
      return await executeCommand(params.get("cmd"), toParamBagFromSearchParams(params));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  async function POST(req: NextRequest) {
    try {
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
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  return { GET, POST, runtime: "nodejs" as const };
}
