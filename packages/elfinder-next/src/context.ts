import path from "path";
import type { ElfinderOptions } from "./types.js";

export type ElfinderContext = {
  uploadDir: string;
  rootName: string;
  volumeId: string;
  rootHash: string;
  tmbDir: string;
  chunkDir: string;
  publicUrl: string;
  tmbUrl: string;
  maxArchiveEntries: number;
  maxArchiveBytes: number;
};

/**
 * Ensures a URL prefix ends in a slash, while leaving an empty string empty.
 *
 * An empty prefix is meaningful: it tells elFinder that files have no public URL,
 * so the client addresses them through the connector's `file` command instead.
 * Coercing `""` to `"/"` would instead claim that files are served from the site
 * root, which is how uploads end up unreachable behind a wrong URL.
 */
function normalizeUrlPrefix(raw: string): string {
  if (raw === "") {
    return "";
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function resolveContext(options: ElfinderOptions = {}): ElfinderContext {
  const uploadDir = path.resolve(
    options.uploadDir ?? path.join(process.cwd(), "public", "uploads"),
  );
  const volumeId = options.volumeId ?? "v1_";
  const publicUrl = options.publicUrl ?? "/uploads/";
  const tmbUrl = options.tmbUrl ?? "/uploads/.tmb/";

  return {
    uploadDir,
    rootName: options.rootName ?? "uploads",
    volumeId,
    rootHash: `${volumeId}Lw`,
    tmbDir: path.resolve(uploadDir, ".tmb"),
    chunkDir: path.resolve(uploadDir, ".chunks"),
    publicUrl: normalizeUrlPrefix(publicUrl),
    tmbUrl: normalizeUrlPrefix(tmbUrl),
    maxArchiveEntries: options.maxArchiveEntries ?? 10_000,
    maxArchiveBytes: options.maxArchiveBytes ?? 1024 * 1024 * 1024,
  };
}
