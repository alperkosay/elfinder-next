export type ElfinderFile = {
  name: string;
  size: number;
  hash: string;
  phash?: string;
  mime: string;
  ts: number;
  read: 1;
  write: 1;
  locked: 0;
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

export type ElfinderOptions = {
  /** Absolute or cwd-relative path where files are stored. Default: `public/uploads` */
  uploadDir?: string;
  /** Display name for the volume root. Default: `uploads` */
  rootName?: string;
  /** Volume id prefix used in hashes. Default: `v1_` */
  volumeId?: string;
  /** Public URL prefix for uploaded files. Default: `/uploads/` */
  publicUrl?: string;
  /** Public URL prefix for thumbnails. Default: `/uploads/.tmb/` */
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
};

export type ElfinderHandlers = {
  GET: (req: import("next/server").NextRequest) => Promise<import("next/server").NextResponse>;
  POST: (req: import("next/server").NextRequest) => Promise<import("next/server").NextResponse>;
  runtime: "nodejs";
};
