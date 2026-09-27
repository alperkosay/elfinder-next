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
 *   uploadDir: process.env.ELFINDER_DIR, // absolute path on persistent storage
 * });
 * ```
 *
 * @example Authorizing requests, and scoping what each caller may do. The session
 * type flows from `authorize`'s return type into `permissions`.
 * ```ts
 * export const { GET, POST, runtime } = createElfinderHandler({
 *   uploadDir: "/srv/files",
 *   authorize: async (request) => {
 *     const user = await getUser(request);
 *     return user ? { id: user.id, role: user.role } : null;
 *   },
 *   permissions: (relativePath, session) => ({
 *     write: session.role === "editor",
 *     locked: relativePath === "system",
 *   }),
 * });
 * ```
 */
export function createElfinderHandler<Session = unknown>(
  options?: ElfinderOptions<Session>,
): ElfinderHandlers {
  const ctx = resolveContext(options);
  return createElfinderHandlers(ctx);
}
