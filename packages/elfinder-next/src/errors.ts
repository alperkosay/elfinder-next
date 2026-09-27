import { NextResponse } from "next/server";

/**
 * An error carrying elFinder client message keys.
 *
 * elFinder looks each entry up in its i18n table, so `["errExists", "photo.jpg"]`
 * renders as a localized "File named photo.jpg already exists." A free-form string
 * would be shown verbatim in whatever language the server happens to speak.
 */
export class ElfinderError extends Error {
  readonly payload: string[];

  constructor(payload: string | string[], options?: { cause?: unknown }) {
    const entries = Array.isArray(payload) ? payload : [payload];
    super(entries.join(" "));
    this.name = "ElfinderError";
    this.payload = entries;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Maps Node filesystem error codes onto elFinder message keys. */
const FS_CODE_TO_MESSAGE: Record<string, string> = {
  ENOENT: "errFileNotFound",
  EEXIST: "errExists",
  EACCES: "errPerm",
  EPERM: "errPerm",
  EBUSY: "errPerm",
  EROFS: "errPerm",
  EISDIR: "errNotFile",
  ENOTDIR: "errNotFolder",
  ENOTEMPTY: "errRm",
  ENOSPC: "errUnknown",
  EMFILE: "errUnknown",
};

function fsErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

/**
 * Turns any thrown value into the elFinder error shape.
 *
 * elFinder's client treats a non-2xx response as a transport failure and reports
 * `errConnect`, discarding the body. Command errors therefore have to come back
 * with HTTP 200 and an `error` field. The raw error is logged rather than
 * returned, because Node filesystem messages embed absolute server paths.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ElfinderError) {
    return NextResponse.json({ error: error.payload });
  }

  const code = fsErrorCode(error);
  const message = code ? (FS_CODE_TO_MESSAGE[code] ?? "errUnknown") : "errUnknown";

  console.error("[elfinder-next]", error);
  return NextResponse.json({ error: [message] });
}
