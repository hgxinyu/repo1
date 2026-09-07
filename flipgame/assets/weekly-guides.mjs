/** Stable issue order: editing an older issue must not promote it to the current week. */
export function publishedWeeklyGuides(guides) {
  return (Array.isArray(guides) ? guides : []).filter(g => g.category === 'weekly' && g.status === 'published')
    .sort((a,b) => String(b.publishedAt || b.updatedAt || '').localeCompare(String(a.publishedAt || a.updatedAt || '')) || String(a.id).localeCompare(String(b.id)));
}
export function weeklyEdition(guide, language) {
  const english = language === 'en';
  const preferred = english ? guide.pagesEn : guide.pages;
  return {pages:preferred?.length ? preferred : (english ? guide.pages : guide.pagesEn) || [],
    notice:preferred?.length ? '' : english ? 'Chinese edition only' : '仅英文版',
    title:english && guide.titleEn ? guide.titleEn : guide.title};
}
