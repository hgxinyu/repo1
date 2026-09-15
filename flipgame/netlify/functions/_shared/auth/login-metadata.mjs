const MAX_LOCATION_LENGTH = 128;

function textValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[<>]/gu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LOCATION_LENGTH);
  return normalized || null;
}

function countryValue(value) {
  const normalized = textValue(value);
  return normalized && /^[A-Za-z]{2}$/u.test(normalized)
    ? normalized.toUpperCase()
    : null;
}

export function normalizeLoginLocation(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    country: countryValue(input.country),
    region: textValue(input.region),
    city: textValue(input.city)
  };
}

export function readLoginLocation(context) {
  const geo = context && typeof context === "object" && context.geo && typeof context.geo === "object"
    ? context.geo
    : {};
  const country = geo.country && typeof geo.country === "object" ? geo.country.code : null;
  const subdivision = geo.subdivision && typeof geo.subdivision === "object" ? geo.subdivision : {};
  return normalizeLoginLocation({
    country,
    region: subdivision.name || subdivision.code,
    city: geo.city
  });
}
