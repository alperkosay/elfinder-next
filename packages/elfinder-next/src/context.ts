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
};

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
    publicUrl: publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`,
    tmbUrl: tmbUrl.endsWith("/") ? tmbUrl : `${tmbUrl}/`,
  };
}
