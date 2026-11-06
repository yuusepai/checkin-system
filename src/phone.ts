/**
 * Normalizes Vietnamese and international phone numbers into a canonical digit string.
 * Handles common Excel pitfalls:
 * - Leading zero stripped by Excel numeric formatting (e.g. "912345678" -> "0912345678")
 * - Country code prefixes ("+84912345678", "84912345678", "0084912345678" -> "0912345678")
 * - Separators ("0912.345.678", "0912 345 678", "0912-345-678" -> "0912345678")
 */
export function normalizePhone(input: unknown): string {
  if (input === null || input === undefined) return "";
  let raw = String(input).trim();
  if (!raw) return "";

  // Handle scientific notation if Excel exported a large number
  if (/^\d+(\.\d+)?e\+\d+$/i.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      raw = Math.round(num).toString();
    }
  }

  let digits = raw.replace(/\D+/g, "");
  if (!digits) return "";

  if (digits.startsWith("0084") && digits.length >= 12) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("84") && (digits.length === 11 || digits.length === 12)) {
    digits = "0" + digits.slice(2);
  } else if (digits.length === 9 && /^[35789]/.test(digits)) {
    // Excel stripped leading 0 on a 10-digit VN mobile number
    digits = "0" + digits;
  }

  return digits;
}

export function isValidPhone(normalized: string): boolean {
  // Accept standard 10-11 digit VN numbers starting with 0, or 8-15 digit hotline/international numbers
  return /^0\d{8,10}$/.test(normalized) || /^\d{8,15}$/.test(normalized);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "su-kien-" + Date.now().toString(36);
}
