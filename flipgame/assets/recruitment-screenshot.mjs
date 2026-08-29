const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_SCREENSHOT_TYPES = new Set(["image/jpeg", "image/png"]);

export function recruitmentScreenshotIssue(file) {
  if (!file) return "required";
  if (!ACCEPTED_SCREENSHOT_TYPES.has(String(file.type || "").toLowerCase())) return "type";
  if (!Number.isFinite(file.size) || file.size > MAX_SCREENSHOT_BYTES) return "size";
  return "";
}
