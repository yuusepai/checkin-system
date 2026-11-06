export interface EventDay {
  key: string;
  label: string;
  date?: string;
  active?: boolean;
}

export type EventMode = "single" | "multi";
export type MultiCheckinRule = "once_per_day" | "once_per_event";

export interface EventMeta {
  slug: string;
  title: string;
  subtitle: string;
  location: string;
  mode: EventMode;
  multiRule: MultiCheckinRule;
  requireGuestList: boolean;
  days: EventDay[];
  phoneColumnName?: string;
  excelColumns?: string[];
  hasLogo: boolean;
  hasBanner: boolean;
  logoUrl: string;
  bannerUrl: string;
  themeColor: string;
  totalGuests: number;
  totalCheckins: number;
  createdAt: string;
  updatedAt: string;
}

export interface GuestInput {
  phone: string;
  name?: string;
  fields?: Record<string, string>;
}

export interface GuestRecord {
  phone: string;
  rawPhone: string;
  name: string;
  fields: Record<string, string>;
  importedAt: string;
}

export interface CheckinRecord {
  id: number;
  phone: string;
  dayKey: string;
  guestName: string;
  checkedInAt: string;
}

export interface DayCheckinStatus {
  key: string;
  label: string;
  date?: string;
  isOpen: boolean;
  checkedIn: boolean;
  checkedInAt: string | null;
}

export interface LookupResponse {
  ok: boolean;
  foundInGuestList: boolean;
  allowedToCheckin: boolean;
  reason?: string;
  phone: string;
  guest: {
    phone: string;
    name: string;
    fields: Record<string, string>;
  } | null;
  days: DayCheckinStatus[];
  allCheckedIn: boolean;
}

export interface CheckinResponse {
  ok: boolean;
  status:
    | "CHECKED_IN"
    | "ALREADY_CHECKED_IN"
    | "DAY_NOT_OPEN"
    | "NOT_IN_GUEST_LIST"
    | "INVALID_DAY"
    | "ERROR";
  message: string;
  phone: string;
  dayKey: string;
  dayLabel: string;
  checkedInAt: string | null;
  guest: {
    phone: string;
    name: string;
    fields: Record<string, string>;
  } | null;
  days: DayCheckinStatus[];
}
