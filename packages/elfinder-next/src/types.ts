/**
 * What the current caller may do with one path.
 *
 * Every field is optional; anything omitted takes the permissive default, so a
 * callback can grant or revoke one thing without restating the rest.
 */
export type ElfinderPermission = {
  /** May be listed, downloaded and previewed. Default: `true` */
  read?: boolean;
  /** May be created, modified, moved into or deleted. Default: `true` */
  write?: boolean;
  /** Cannot be renamed or deleted, even where `write` is granted. Default: `false` */
  locked?: boolean;
};

export type ElfinderFile = {
  name: string;
  size: number;
  hash: string;
  phash?: string;
  mime: string;
  ts: number;
  read: 0 | 1;
  write: 0 | 1;
  locked: 0 | 1;
  dirs?: 1;
  volumeid: string;
  tmb?: string;
  options?: {
    disabled: string[];
    archivers: {
      create: string[];
      extract: string[];
    };
    url: string;
    tmbUrl: string;
    separator: "/";
  };
};

export type ElfinderOptions<Session = unknown> = {
  /** Absolute or cwd-relative path where files are stored. Default: `public/uploads` */
  uploadDir?: string;
  /** Display name for the volume root. Default: `uploads` */
  rootName?: string;
  /** Volume id prefix used in hashes. Default: `v1_` */
  volumeId?: string;
  /**
   * Public URL prefix for uploaded files. Default: `/uploads/`
   *
   * Set to `""` when the files are not served statically — for example when
   * `uploadDir` lives outside `public/`, as it must under `output: "standalone"`
   * or on a read-only serverless filesystem. elFinder then addresses files
   * through the connector's `file` command instead of a static path.
   */
  publicUrl?: string;
  /** Public URL prefix for thumbnails. Default: `/uploads/.tmb/`; `""` for none. */
  tmbUrl?: string;
  /**
   * Largest number of entries an archive may declare before `extract` refuses
   * it. Guards against archives built to exhaust inodes. Default: `10000`
   */
  maxArchiveEntries?: number;
  /**
   * Largest total uncompressed size, in bytes, that `extract` will unpack.
   * Guards against compression bombs. Default: 1 GiB
   */
  maxArchiveBytes?: number;
  /**
   * How long an in-progress chunked upload may sit untouched before its parts are
   * deleted, in milliseconds. A cancelled or abandoned upload leaves parts behind
   * that nothing else ever revisits. Default: 24 hours
   */
  chunkTtlMs?: number;
  /**
   * Largest single upload, in bytes. Reported to elFinder as `uplMaxSize` so the
   * client can refuse an oversized file before sending it, and enforced on arrival
   * so a client that ignores it cannot fill the disk. `0` removes the limit.
   * Default: 256 MiB
   */
  maxUploadBytes?: number;
  /**
   * Most files elFinder should put in one upload request, reported as `uplMaxFile`.
   * The client batches larger selections rather than failing. `0` removes the limit.
   * Default: `20`
   */
  maxUploadFiles?: number;
  /**
   * Most matches `search` will return before it stops walking. Keeps a search over a
   * large volume from becoming a slow request with an unrenderable response.
   * Default: `500`
   */
  maxSearchResults?: number;
  /**
   * Decides whether a request may reach the connector at all, and returns whatever
   * the `permissions` callback needs to know about the caller.
   *
   * Returning `null` or `undefined`, or throwing, denies the request with HTTP 403.
   * A caller who is authenticated but carries no data should return something
   * truthy such as `true` or `{}` — "no session" is treated as a denial so that a
   * callback which forgets to return cannot accidentally grant access.
   *
   * Omitting this leaves the connector open. Authorization is not optional in
   * production: without it, anyone who can reach the route can read and write the
   * whole volume.
   *
   * @example
   * ```ts
   * authorize: async (request) => {
   *   const user = await getUser(request);
   *   return user ? { id: user.id, role: user.role } : null;
   * }
   * ```
   */
  authorize?: (
    request: import("next/server").NextRequest,
  ) => Session | null | undefined | Promise<Session | null | undefined>;
  /**
   * Decides what the caller may do with one path, relative to the volume root.
   * The root itself is `""`.
   *
   * Called for each entry in a listing and before each operation, and memoized per
   * request, so it should be cheap. Each path is asked about independently: to make
   * a whole subtree read-only, match on the prefix.
   *
   * Creating or deleting an entry requires `write` on its parent directory as well,
   * so denying `write` on a folder is enough to make its contents immutable.
   *
   * @example
   * ```ts
   * permissions: (relativePath, session) => ({
   *   write: session.role === "editor" && !relativePath.startsWith("archive/"),
   *   locked: relativePath === "system",
   * })
   * ```
   */
  permissions?: (
    relativePath: string,
    session: Session,
  ) => ElfinderPermission | Promise<ElfinderPermission>;
};

export type ElfinderHandlers = {
  GET: (req: import("next/server").NextRequest) => Promise<import("next/server").NextResponse>;
  POST: (req: import("next/server").NextRequest) => Promise<import("next/server").NextResponse>;
  runtime: "nodejs";
};
