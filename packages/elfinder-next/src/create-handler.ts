import { resolveContext } from "./context.js";
import { createElfinderHandlers } from "./handler-core.js";
import type { ElfinderHandlers, ElfinderOptions } from "./types.js";

/**
 * Creates Next.js App Router route handlers for the elFinder 2.1 connector API.
 *
 * @example
 * ```ts
 * // app/api/elfinder/route.ts
 * import { createElfinderHandler } from "elfinder-next";
 *
 * export const { GET, POST, runtime } = createElfinderHandler({
 *   uploadDir: "./public/uploads",
 *   publicUrl: "/uploads/",
 *   tmbUrl: "/uploads/.tmb/",
 * });
 * ```
 */
export function createElfinderHandler(options?: ElfinderOptions): ElfinderHandlers {
  const ctx = resolveContext(options);
  return createElfinderHandlers(ctx);
}
