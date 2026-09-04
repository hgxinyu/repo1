export function shouldOpenCurrentWeeklyGuide(search) {
  return new URLSearchParams(String(search || "")).get("guide") === "weekly-current";
}

export function currentWeeklyGuideOpenMode(search) {
  return shouldOpenCurrentWeeklyGuide(search) ? "current-only" : null;
}

export function localizedGuideImageList(card, language) {
  const source = card || {};
  const localized = language === "en" ? (source.imagesEn || source.imageEn) : "";
  const value = localized || source.images || source.image || "";
  return String(value).split("|").map((item) => item.trim()).filter(Boolean);
}

export function localizedCurrentGuideImageList(card, language) {
  const source = card || {};
  const localized = language === "en" ? source.imageEn : "";
  const value = localized || source.image || "";
  return String(value).split("|").map((item) => item.trim()).filter(Boolean).slice(0, 1);
}

export function localizedGuidePickerItems(card, language) {
  const source = card || {};
  const images = localizedGuideImageList(source, language);
  const localizedLabels = language === "en" ? source.labelsEn : source.labels;
  const fallbackLabels = language === "en" ? source.labels : source.labelsEn;
  const labels = String(localizedLabels || fallbackLabels || "").split("|").map((item) => item.trim());
  return images.map((image, index) => ({
    image,
    label: labels[index] || String(index + 1)
  }));
}
