import path from "path";
import type { ElfinderOptions, ElfinderPermission } from "./types.js";

/**
 * Internal, session-erased forms of the authorization callbacks.
 *
 * The public API is generic over the session type so callers get inference; the
 * handler does not care what a session is and only passes it back through, so the
 * generic is dropped at this boundary rather than threaded through every function.
 */
export type AuthorizeFn = (
  request: import("next/server").NextRequest,
) => unknown | Promise<unknown>;

export type PermissionsFn = (
  relativePath: string,
  session: unknown,
) => ElfinderPermission | Promise<ElfinderPermission>;

export type ElfinderContext = {
  uploadDir: string;
  rootName: string;
  volumeId: string;
  rootHash: string;
  tmbDir: string;
  chunkDir: string;
  tmpDir: string;
  publicUrl: string;
  tmbUrl: string;
  maxArchiveEntries: number;
  maxArchiveBytes: number;
  chunkTtlMs: number;
  maxUploadBytes: number;
  maxUploadFiles: number;
  maxSearchResults: number;
  authorize: AuthorizeFn | null;
  permissions: PermissionsFn | null;
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

export function resolveContext<Session>(
  options: ElfinderOptions<Session> = {},
): ElfinderContext {
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
    tmpDir: path.resolve(uploadDir, ".tmp"),
    publicUrl: normalizeUrlPrefix(publicUrl),
    tmbUrl: normalizeUrlPrefix(tmbUrl),
    maxArchiveEntries: options.maxArchiveEntries ?? 10_000,
    maxArchiveBytes: options.maxArchiveBytes ?? 1024 * 1024 * 1024,
    chunkTtlMs: options.chunkTtlMs ?? 24 * 60 * 60 * 1000,
    maxUploadBytes: options.maxUploadBytes ?? 256 * 1024 * 1024,
    maxUploadFiles: options.maxUploadFiles ?? 20,
    maxSearchResults: options.maxSearchResults ?? 500,
    authorize: (options.authorize as AuthorizeFn | undefined) ?? null,
    permissions: (options.permissions as PermissionsFn | undefined) ?? null,
  };
}
