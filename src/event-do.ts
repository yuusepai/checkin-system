import { DurableObject } from "cloudflare:workers";
import { normalizePhone, isValidPhone } from "./phone";
import type {
  CheckinRecord,
  CheckinResponse,
  DayCheckinStatus,
  EventDay,
  EventMeta,
  GuestInput,
  GuestRecord,
  LookupResponse,
} from "./types";

interface MediaRow extends Record<string, SqlStorageValue> {
  type: string;
  content_type: string;
  data_base64: string;
  updated_at: string;
}

function getTodayVN(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function getVNDateFromISO(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
}

function isEventDayOpen(day: EventDay, mode: "single" | "multi", dayIndex = 0): boolean {
  if (mode === "single") return true;
  if (day.active === false) return false;
  if (day.date && /^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
    const today = getTodayVN();
    return day.date <= today;
  }
  return dayIndex === 0;
}

function extractPrimaryName(fields: Record<string, string>, fallbackName?: string): string {
  if (fallbackName && fallbackName.trim()) return fallbackName.trim();
  const entries = Object.entries(fields);
  for (const [k, v] of entries) {
    if (!v || !v.trim()) continue;
    const norm = k
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d");
    if (norm.includes("ten") || norm.includes("name") || norm.includes("khach")) {
      return v.trim();
    }
  }
  for (const [, v] of entries) {
    if (v && v.trim()) return v.trim();
  }
  return "";
}

export class EventDO extends DurableObject<Env> {
  private cachedMeta: EventMeta | null = null;
  private alarmScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media (
          type TEXT PRIMARY KEY,
          content_type TEXT NOT NULL,
          data_base64 TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS guests (
          phone TEXT PRIMARY KEY,
          raw_phone TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          fields_json TEXT NOT NULL DEFAULT '{}',
          imported_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          day_key TEXT NOT NULL,
          guest_name TEXT NOT NULL DEFAULT '',
          checked_in_at TEXT NOT NULL,
          UNIQUE(phone, day_key)
        );

        CREATE INDEX IF NOT EXISTS idx_checkins_phone ON checkins(phone);
        CREATE INDEX IF NOT EXISTS idx_checkins_day_key ON checkins(day_key);
        CREATE INDEX IF NOT EXISTS idx_checkins_time ON checkins(checked_in_at DESC);
      `);

      // Safe schema upgrade if guests table was created with older columns
      const guestCols = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(guests)")
        .toArray();
      if (!guestCols.some((c) => c.name === "fields_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE guests ADD COLUMN fields_json TEXT NOT NULL DEFAULT '{}'"
        );
      }
    });
  }

  private loadMetaSync(): EventMeta | null {
    if (this.cachedMeta) return this.cachedMeta;
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM config WHERE key = 'meta'")
      .toArray();
    if (rows.length === 0) return null;
    const meta = JSON.parse(rows[0].value) as EventMeta;
    if (!Array.isArray(meta.excelColumns)) {
      meta.excelColumns = [];
    }
    if (!meta.phoneColumnName) {
      meta.phoneColumnName = "Số điện thoại";
    }
    const counts = this.getCountsSync();
    meta.totalGuests = counts.totalGuests;
    meta.totalCheckins = counts.totalCheckins;
    this.cachedMeta = meta;
    return meta;
  }

  private getCountsSync(): { totalGuests: number; totalCheckins: number } {
    const gRow = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM guests")
      .one();
    const cRow = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM checkins")
      .one();
    return {
      totalGuests: Number(gRow?.c ?? 0),
      totalCheckins: Number(cRow?.c ?? 0),
    };
  }

  private saveMetaSync(meta: EventMeta): EventMeta {
    const counts = this.getCountsSync();
    const updated: EventMeta = {
      ...meta,
      excelColumns: Array.isArray(meta.excelColumns) ? meta.excelColumns : [],
      phoneColumnName: meta.phoneColumnName || "Số điện thoại",
      totalGuests: counts.totalGuests,
      totalCheckins: counts.totalCheckins,
      updatedAt: new Date().toISOString(),
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES ('meta', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(updated)
    );
    this.cachedMeta = updated;
    return updated;
  }

  private parseDataUrl(dataUrl: string): { contentType: string; base64: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
    if (!match) return null;
    return {
      contentType: match[1],
      base64: match[2],
    };
  }

  async saveEventConfig(input: {
    meta: EventMeta;
    logoDataUrl?: string | null;
    bannerDataUrl?: string | null;
    removeLogo?: boolean;
    removeBanner?: boolean;
  }): Promise<EventMeta> {
    const now = new Date().toISOString();
    const current = this.loadMetaSync();
    const meta: EventMeta = {
      ...input.meta,
      excelColumns: input.meta.excelColumns ?? current?.excelColumns ?? [],
      phoneColumnName: input.meta.phoneColumnName ?? current?.phoneColumnName ?? "Số điện thoại",
    };

    if (input.removeLogo) {
      this.ctx.storage.sql.exec("DELETE FROM media WHERE type = 'logo'");
      meta.hasLogo = false;
      if (meta.logoUrl.startsWith("/api/events/")) meta.logoUrl = "";
    } else if (input.logoDataUrl) {
      const parsed = this.parseDataUrl(input.logoDataUrl);
      if (parsed) {
        this.ctx.storage.sql.exec(
          `INSERT INTO media (type, content_type, data_base64, updated_at)
           VALUES ('logo', ?, ?, ?)
           ON CONFLICT(type) DO UPDATE SET
             content_type = excluded.content_type,
             data_base64 = excluded.data_base64,
             updated_at = excluded.updated_at`,
          parsed.contentType,
          parsed.base64,
          now
        );
        meta.hasLogo = true;
        meta.logoUrl = `/api/events/${meta.slug}/media/logo?v=${Date.now()}`;
      }
    }

    if (input.removeBanner) {
      this.ctx.storage.sql.exec("DELETE FROM media WHERE type = 'banner'");
      meta.hasBanner = false;
      if (meta.bannerUrl.startsWith("/api/events/")) meta.bannerUrl = "";
    } else if (input.bannerDataUrl) {
      const parsed = this.parseDataUrl(input.bannerDataUrl);
      if (parsed) {
        this.ctx.storage.sql.exec(
          `INSERT INTO media (type, content_type, data_base64, updated_at)
           VALUES ('banner', ?, ?, ?)
           ON CONFLICT(type) DO UPDATE SET
             content_type = excluded.content_type,
             data_base64 = excluded.data_base64,
             updated_at = excluded.updated_at`,
          parsed.contentType,
          parsed.base64,
          now
        );
        meta.hasBanner = true;
        meta.bannerUrl = `/api/events/${meta.slug}/media/banner?v=${Date.now()}`;
      }
    }

    return this.saveMetaSync(meta);
  }

  async getPublicMeta(): Promise<(EventMeta & { todayVN: string }) | null> {
    const meta = this.loadMetaSync();
    if (!meta) return null;
    return {
      ...meta,
      todayVN: getTodayVN(),
    };
  }

  async getMedia(
    type: "logo" | "banner"
  ): Promise<{ contentType: string; dataBase64: string; updatedAt: string } | null> {
    const rows = this.ctx.storage.sql
      .exec<MediaRow>(
        "SELECT type, content_type, data_base64, updated_at FROM media WHERE type = ?",
        type
      )
      .toArray();
    if (rows.length === 0) return null;
    return {
      contentType: rows[0].content_type,
      dataBase64: rows[0].data_base64,
      updatedAt: rows[0].updated_at,
    };
  }

  /**
   * Dynamic Excel import: maps every column by normalized phone number.
   * Supports both "replace" (fresh list + columns) and "merge" (combines/updates fields by phone).
   */
  async importGuests(
    guests: GuestInput[],
    mode: "merge" | "replace" = "merge",
    excelColumns?: string[],
    phoneColumnName?: string
  ): Promise<{ imported: number; skipped: number; totalGuests: number; meta: EventMeta | null }> {
    const meta = this.loadMetaSync();
    if (!meta) {
      throw new Error("Event not found");
    }

    if (mode === "replace") {
      this.ctx.storage.sql.exec("DELETE FROM guests");
      if (Array.isArray(excelColumns)) {
        meta.excelColumns = [...excelColumns];
      }
      if (phoneColumnName) {
        meta.phoneColumnName = phoneColumnName;
      }
    } else {
      // Merge column headers in order
      const colSet = new Set<string>(meta.excelColumns || []);
      if (Array.isArray(excelColumns)) {
        for (const c of excelColumns) {
          if (c && c.trim()) colSet.add(c.trim());
        }
      }
      meta.excelColumns = Array.from(colSet);
      if (phoneColumnName && !meta.phoneColumnName) {
        meta.phoneColumnName = phoneColumnName;
      }
    }

    // Load existing fields map when merging so multi-file uploads merge cleanly by phone
    const existingMap = new Map<string, Record<string, string>>();
    if (mode === "merge") {
      const existingRows = this.ctx.storage.sql
        .exec<{ phone: string; fields_json: string }>("SELECT phone, fields_json FROM guests")
        .toArray();
      for (const r of existingRows) {
        try {
          existingMap.set(r.phone, JSON.parse(r.fields_json || "{}"));
        } catch {
          existingMap.set(r.phone, {});
        }
      }
    }

    const colSet = new Set<string>(meta.excelColumns || []);
    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;

    for (const item of guests) {
      const normalized = normalizePhone(item.phone);
      if (!normalized || !isValidPhone(normalized)) {
        skipped++;
        continue;
      }

      const incomingFields: Record<string, string> = {};
      if (item.fields && typeof item.fields === "object") {
        for (const [k, v] of Object.entries(item.fields)) {
          const cleanKey = String(k).trim();
          const cleanVal = String(v ?? "").trim();
          if (!cleanKey) continue;
          colSet.add(cleanKey);
          if (cleanVal !== "") {
            incomingFields[cleanKey] = cleanVal;
          }
        }
      }

      const prevFields = existingMap.get(normalized) || {};
      const mergedFields: Record<string, string> = {
        ...prevFields,
        ...incomingFields,
      };
      existingMap.set(normalized, mergedFields);

      const primaryName = extractPrimaryName(mergedFields, item.name);

      this.ctx.storage.sql.exec(
        `INSERT INTO guests (phone, raw_phone, name, fields_json, imported_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET
           raw_phone = excluded.raw_phone,
           name = CASE WHEN excluded.name != '' THEN excluded.name ELSE guests.name END,
           fields_json = excluded.fields_json,
           imported_at = excluded.imported_at`,
        normalized,
        String(item.phone ?? "").trim(),
        primaryName,
        JSON.stringify(mergedFields),
        now
      );
      imported++;
    }
    if (mode === "replace") {
      this.ctx.storage.sql.exec(
        "DELETE FROM checkins WHERE phone NOT IN (SELECT phone FROM guests)"
      );
    }

    meta.excelColumns = Array.from(colSet);
    const updatedMeta = this.saveMetaSync(meta);
    return {
      imported,
      skipped,
      totalGuests: updatedMeta.totalGuests,
      meta: updatedMeta,
    };
  }

  private buildDaysStatusSync(
    meta: EventMeta,
    phone: string,
    prefetchedRows?: Array<{ day_key: string; checked_in_at: string }>
  ): DayCheckinStatus[] {
    const checkinRows =
      prefetchedRows ??
      this.ctx.storage.sql
        .exec<{ day_key: string; checked_in_at: string }>(
          "SELECT day_key, checked_in_at FROM checkins WHERE phone = ?",
          phone
        )
        .toArray();
    const map = new Map<string, string>();
    for (const r of checkinRows) {
      map.set(r.day_key, r.checked_in_at);
    }

    return meta.days.map((d, idx) => {
      const checkedInAt = map.get(d.key) ?? null;
      return {
        key: d.key,
        label: d.label,
        date: d.date,
        isOpen: isEventDayOpen(d, meta.mode, idx),
        checkedIn: Boolean(checkedInAt),
        checkedInAt,
      };
    });
  }

  private getGuestSync(phone: string): GuestRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{
        phone: string;
        raw_phone: string;
        name: string;
        fields_json: string;
        imported_at: string;
      }>(
        "SELECT phone, raw_phone, name, fields_json, imported_at FROM guests WHERE phone = ?",
        phone
      )
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    let fields: Record<string, string> = {};
    try {
      fields = JSON.parse(r.fields_json || "{}");
    } catch {
      fields = {};
    }
    return {
      phone: r.phone,
      rawPhone: r.raw_phone,
      name: r.name || extractPrimaryName(fields),
      fields,
      importedAt: r.imported_at,
    };
  }

  async lookupPhone(rawPhone: string): Promise<LookupResponse> {
    const meta = this.loadMetaSync();
    if (!meta) {
      throw new Error("Sự kiện không tồn tại");
    }

    const phone = normalizePhone(rawPhone);
    if (!phone || !isValidPhone(phone)) {
      return {
        ok: false,
        foundInGuestList: false,
        allowedToCheckin: false,
        reason: "Số điện thoại không hợp lệ. Vui lòng nhập đúng SĐT (VD: 0912345678).",
        phone,
        guest: null,
        days: [],
        allCheckedIn: false,
      };
    }

    const guest = this.getGuestSync(phone);
    const foundInGuestList = Boolean(guest);
    const allowedToCheckin = meta.requireGuestList ? foundInGuestList : true;

    if (!allowedToCheckin) {
      return {
        ok: false,
        foundInGuestList: false,
        allowedToCheckin: false,
        reason: "Số điện thoại này không có trong danh sách khách mời của sự kiện.",
        phone,
        guest: null,
        days: [],
        allCheckedIn: false,
      };
    }

    const days = this.buildDaysStatusSync(meta, phone);
    const allCheckedIn = days.length > 0 && days.every((d) => d.checkedIn);

    return {
      ok: true,
      foundInGuestList,
      allowedToCheckin: true,
      phone,
      // Do not expose guest personal info on lookup before actual check-in succeeds
      guest: null,
      days,
      allCheckedIn,
    };
  }

  async checkin(input: {
    phone: string;
    dayKey?: string;
    walkinName?: string;
  }): Promise<CheckinResponse> {
    const meta = this.loadMetaSync();
    if (!meta) {
      return {
        ok: false,
        status: "ERROR",
        message: "Sự kiện không tồn tại.",
        phone: "",
        dayKey: "",
        dayLabel: "",
        checkedInAt: null,
        guest: null,
        days: [],
      };
    }

    const phone = normalizePhone(input.phone);
    if (!phone || !isValidPhone(phone)) {
      return {
        ok: false,
        status: "ERROR",
        message: "Số điện thoại không hợp lệ. Vui lòng kiểm tra lại.",
        phone,
        dayKey: "",
        dayLabel: "",
        checkedInAt: null,
        guest: null,
        days: [],
      };
    }

    const guest = this.getGuestSync(phone);
    if (meta.requireGuestList && !guest) {
      return {
        ok: false,
        status: "NOT_IN_GUEST_LIST",
        message: "Số điện thoại này không có trong danh sách khách mời của sự kiện.",
        phone,
        dayKey: input.dayKey || "",
        dayLabel: "",
        checkedInAt: null,
        guest: null,
        days: [],
      };
    }
    const existingRows = this.ctx.storage.sql
      .exec<{ day_key: string; checked_in_at: string }>(
        "SELECT day_key, checked_in_at FROM checkins WHERE phone = ?",
        phone
      )
      .toArray();

    const todayVN = getTodayVN();
    const checkedInTodayRecord = existingRows.find(
      (r) => getVNDateFromISO(r.checked_in_at) === todayVN
    );

    let targetDayKey = input.dayKey || "";
    if (meta.mode === "single") {
      targetDayKey = meta.days[0]?.key || "day-1";
    } else if (!targetDayKey) {
      if (checkedInTodayRecord) {
        targetDayKey = checkedInTodayRecord.day_key;
      } else {
        const exactTodayDay = meta.days.find(
          (d, idx) => d.date === todayVN && isEventDayOpen(d, meta.mode, idx)
        );
        const firstOpenUnchecked = meta.days.find(
          (d, idx) =>
            isEventDayOpen(d, meta.mode, idx) &&
            !existingRows.some((r) => r.day_key === d.key)
        );
        const firstOpen = meta.days.find((d, idx) => isEventDayOpen(d, meta.mode, idx));
        targetDayKey =
          exactTodayDay?.key ||
          firstOpenUnchecked?.key ||
          firstOpen?.key ||
          meta.days[0]?.key ||
          "day-1";
      }
    }

    const dayIndex = meta.days.findIndex((d) => d.key === targetDayKey);
    const dayConfig = dayIndex >= 0 ? meta.days[dayIndex] : undefined;
    if (!dayConfig) {
      return {
        ok: false,
        status: "INVALID_DAY",
        message: "Ngày check-in không hợp lệ.",
        phone,
        dayKey: targetDayKey,
        dayLabel: "",
        checkedInAt: null,
        guest: null,
        days: this.buildDaysStatusSync(meta, phone, existingRows),
      };
    }

    // 1. Already checked in on this day OR already checked in today -> block immediately!
    const sameDayRecord = existingRows.find((r) => r.day_key === targetDayKey);
    const duplicateRecord = sameDayRecord || checkedInTodayRecord;
    if (duplicateRecord) {
      const dupDayLabel =
        meta.days.find((d) => d.key === duplicateRecord.day_key)?.label || dayConfig.label;
      return {
        ok: false,
        status: "ALREADY_CHECKED_IN",
        message:
          meta.mode === "single"
            ? `Số điện thoại ${phone} đã check-in hôm nay rồi! Không thể check-in lại.`
            : `Số điện thoại ${phone} đã check-in hôm nay (${dupDayLabel}) rồi! Mỗi ngày chỉ được check-in 1 lần.`,
        phone,
        dayKey: duplicateRecord.day_key,
        dayLabel: dupDayLabel,
        checkedInAt: duplicateRecord.checked_in_at,
        guest: null,
        days: this.buildDaysStatusSync(meta, phone, existingRows),
      };
    }

    // 2. Single-day event already checked in -> block
    if (meta.mode === "single" && existingRows.length > 0) {
      const firstRecord = existingRows[0];
      return {
        ok: false,
        status: "ALREADY_CHECKED_IN",
        message: `Số điện thoại ${phone} đã check-in hôm nay rồi! Không thể check-in lại.`,
        phone,
        dayKey: firstRecord.day_key,
        dayLabel: dayConfig.label,
        checkedInAt: firstRecord.checked_in_at,
        guest: null,
        days: this.buildDaysStatusSync(meta, phone, existingRows),
      };
    }

    // 3. Day not open yet -> block
    if (!isEventDayOpen(dayConfig, meta.mode, dayIndex)) {
      return {
        ok: false,
        status: "DAY_NOT_OPEN",
        message: `${dayConfig.label}${
          dayConfig.date ? ` (${dayConfig.date})` : ""
        } chưa mở check-in. Sang ngày tiếp theo mới mở!`,
        phone,
        dayKey: targetDayKey,
        dayLabel: dayConfig.label,
        checkedInAt: null,
        guest: null,
        days: this.buildDaysStatusSync(meta, phone, existingRows),
      };
    }

    // 4. First check-in for this day -> insert
    const now = new Date().toISOString();
    const guestName = guest?.name || String(input.walkinName ?? "").trim() || "Khách tham dự";

    this.ctx.storage.sql.exec(
      `INSERT INTO checkins (phone, day_key, guest_name, checked_in_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(phone, day_key) DO NOTHING`,
      phone,
      targetDayKey,
      guestName,
      now
    );

    if (this.cachedMeta) {
      this.cachedMeta.totalCheckins += 1;
    }

    if (!this.alarmScheduled) {
      this.alarmScheduled = true;
      await this.ctx.storage.setAlarm(Date.now() + 2000);
    }

    const days = this.buildDaysStatusSync(meta, phone, [
      ...existingRows,
      { day_key: targetDayKey, checked_in_at: now },
    ]);
    return {
      ok: true,
      status: "CHECKED_IN",
      message:
        meta.mode === "single"
          ? "Check-in thành công!"
          : `Check-in ${dayConfig.label} thành công!`,
      phone,
      dayKey: targetDayKey,
      dayLabel: dayConfig.label,
      checkedInAt: now,
      guest: guest
        ? {
            phone: guest.phone,
            name: guest.name,
            fields: guest.fields,
          }
        : {
            phone,
            name: guestName,
            fields: {},
          },
      days,
    };
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    const meta = this.loadMetaSync();
    if (!meta) return;
    const counts = this.getCountsSync();
    this.saveMetaSync(meta);
    try {
      const registry = this.env.REGISTRY_DO.getByName("global");
      await registry.updateCounts(meta.slug, counts.totalGuests, counts.totalCheckins);
    } catch (e) {
      console.error(
        JSON.stringify({
          message: "Failed to sync counts to RegistryDO in alarm",
          slug: meta.slug,
          error: e instanceof Error ? e.message : String(e),
        })
      );
    }
  }

  async getAdminReport(): Promise<{
    meta: EventMeta | null;
    stats: {
      totalGuests: number;
      uniqueCheckedInPhones: number;
      totalCheckinLogs: number;
      byDay: Record<string, number>;
    };
    guests: Array<
      GuestRecord & {
        checkins: Record<string, string>;
      }
    >;
    recentCheckins: Array<
      CheckinRecord & {
        fields: Record<string, string>;
      }
    >;
  }> {
    const meta = this.loadMetaSync();
    if (!meta) {
      return {
        meta: null,
        stats: { totalGuests: 0, uniqueCheckedInPhones: 0, totalCheckinLogs: 0, byDay: {} },
        guests: [],
        recentCheckins: [],
      };
    }

    const guestRows = this.ctx.storage.sql
      .exec<{
        phone: string;
        raw_phone: string;
        name: string;
        fields_json: string;
        imported_at: string;
      }>("SELECT phone, raw_phone, name, fields_json, imported_at FROM guests ORDER BY phone ASC")
      .toArray();

    const checkinRows = this.ctx.storage.sql
      .exec<{
        id: number;
        phone: string;
        day_key: string;
        guest_name: string;
        checked_in_at: string;
      }>(
        "SELECT id, phone, day_key, guest_name, checked_in_at FROM checkins ORDER BY checked_in_at DESC"
      )
      .toArray();

    const byDay: Record<string, number> = {};
    for (const d of meta.days) {
      byDay[d.key] = 0;
    }

    const checkinsByPhone = new Map<string, Record<string, string>>();
    for (const c of checkinRows) {
      byDay[c.day_key] = (byDay[c.day_key] ?? 0) + 1;
      let rec = checkinsByPhone.get(c.phone);
      if (!rec) {
        rec = {};
        checkinsByPhone.set(c.phone, rec);
      }
      rec[c.day_key] = c.checked_in_at;
    }

    const guestMap = new Map<string, GuestRecord>();
    const guests = guestRows.map((g) => {
      let fields: Record<string, string> = {};
      try {
        fields = JSON.parse(g.fields_json || "{}");
      } catch {
        fields = {};
      }
      const record: GuestRecord = {
        phone: g.phone,
        rawPhone: g.raw_phone,
        name: g.name || extractPrimaryName(fields),
        fields,
        importedAt: g.imported_at,
      };
      guestMap.set(g.phone, record);
      return {
        ...record,
        checkins: checkinsByPhone.get(g.phone) ?? {},
      };
    });

    for (const [phone, dayMap] of checkinsByPhone.entries()) {
      if (!guestMap.has(phone)) {
        const lastLog = checkinRows.find((c) => c.phone === phone);
        guests.push({
          phone,
          rawPhone: phone,
          name: lastLog?.guest_name || "Khách Walk-in",
          fields: {},
          importedAt: lastLog?.checked_in_at || "",
          checkins: dayMap,
        });
      }
    }

    const recentCheckins = checkinRows.slice(0, 300).map((c) => {
      const g = guestMap.get(c.phone);
      return {
        id: c.id,
        phone: c.phone,
        dayKey: c.day_key,
        guestName: g?.name || c.guest_name || "",
        checkedInAt: c.checked_in_at,
        fields: g?.fields || {},
      };
    });

    const updatedMeta = this.saveMetaSync(meta);

    return {
      meta: updatedMeta,
      stats: {
        totalGuests: guestRows.length,
        uniqueCheckedInPhones: checkinsByPhone.size,
        totalCheckinLogs: checkinRows.length,
        byDay,
      },
      guests,
      recentCheckins,
    };
  }

  async resetCheckins(dayKey?: string, phone?: string): Promise<{ totalCheckins: number }> {
    if (phone) {
      const norm = normalizePhone(phone);
      if (dayKey) {
        this.ctx.storage.sql.exec(
          "DELETE FROM checkins WHERE phone = ? AND day_key = ?",
          norm,
          dayKey
        );
      } else {
        this.ctx.storage.sql.exec("DELETE FROM checkins WHERE phone = ?", norm);
      }
    } else if (dayKey) {
      this.ctx.storage.sql.exec("DELETE FROM checkins WHERE day_key = ?", dayKey);
    } else {
      this.ctx.storage.sql.exec("DELETE FROM checkins");
    }
    const meta = this.loadMetaSync();
    if (meta) {
      this.saveMetaSync(meta);
    }
    const counts = this.getCountsSync();
    return { totalCheckins: counts.totalCheckins };
  }

  async destroyEvent(): Promise<void> {
    this.cachedMeta = null;
    await this.ctx.storage.deleteAll();
  }
}
