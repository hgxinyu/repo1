export function shouldOpenCurrentWeeklyGuide(search) {
  return new URLSearchParams(String(search || "")).get("guide") === "weekly-current";
}

export function localizedGuideImageList(card, language) {
  const source = card || {};
  const localized = language === "en" ? (source.imagesEn || source.imageEn) : "";
  const value = localized || source.images || source.image || "";
  return String(value).split("|").map((item) => item.trim()).filter(Boolean);
}
