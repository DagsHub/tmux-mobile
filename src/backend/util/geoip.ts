import geoip from "geoip-lite";

// Note: IP geolocation is displayed to the operator to help identify incoming connections.
// Operators should be aware of applicable privacy regulations (e.g. GDPR) when logging or
// storing this data outside of the approval TUI.
export const resolveGeo = (ip: string): string => {
  const result = geoip.lookup(ip);
  if (!result) {
    return "Unknown";
  }

  const parts = [result.city, result.region, result.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Unknown";
};
