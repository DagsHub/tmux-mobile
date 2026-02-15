import geoip from "geoip-lite";

export const resolveGeo = (ip: string): string => {
  const result = geoip.lookup(ip);
  if (!result) {
    return "Unknown";
  }

  const parts = [result.city, result.region, result.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Unknown";
};
