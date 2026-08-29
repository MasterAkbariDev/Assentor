import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeProjectPath } from "../security/paths.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function isImagePath(relativePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export function imageMimeTypeForPath(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

export async function readProjectImageBase64(
  projectRoot: string,
  relativePath: string,
): Promise<{ data: string; mimeType: string }> {
  const absolute = assertSafeProjectPath(projectRoot, relativePath);
  const buffer = await fs.readFile(absolute);
  return {
    data: buffer.toString("base64"),
    mimeType: imageMimeTypeForPath(relativePath),
  };
}
