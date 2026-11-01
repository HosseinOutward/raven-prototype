export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const IMAGE_MAX_BYTES = 512 * 1024;

/** Why the server would refuse this picture, or an empty string when it would take it. */
export function imageProblem(file: File): string {
  if (!IMAGE_TYPES.includes(file.type)) return "Choose a PNG, JPEG or WebP image.";
  if (file.size > IMAGE_MAX_BYTES) return "That image is larger than 512 KB. Choose a smaller one.";
  return "";
}
