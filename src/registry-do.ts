import { DurableObject } from "cloudflare:workers";
import type { EventMeta } from "./types";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function timingSafeStringMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

export class RegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          slug TEXT PRIMARY KEY,
          meta_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_attempts (
          ip TEXT PRIMARY KEY,
          failed_count INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
    });
  }

  private ensureAuthTablesSync(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        failed_count INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  private getAdminPasswordSync(): string {
    this.ensureAuthTablesSync();
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'admin_password'")
      .toArray();
    if (rows.length > 0 && rows[0].value) {
      return rows[0].value;
    }
    return "admin123";
  }

  private createSessionTokenSync(): string {
    const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at < ?", now);
    this.ctx.storage.sql.exec(
      "INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)",
      token,
      now + SESSION_TTL_MS
    );
    return token;
  }

  async loginAdmin(
    password: string,
    clientIp: string
  ): Promise<{
    ok: boolean;
    locked?: boolean;
    remainingAttempts?: number;
    retryAfterSec?: number;
    token?: string;
    error?: string;
  }> {
    this.ensureAuthTablesSync();
    const ip = (clientIp || "unknown").slice(0, 64);
    const now = Date.now();

    const attemptRows = this.ctx.storage.sql
      .exec<{ failed_count: number; locked_until: number; updated_at: number }>(
        "SELECT failed_count, locked_until, updated_at FROM login_attempts WHERE ip = ?",
        ip
      )
      .toArray();

    const current = attemptRows[0];
    if (current && current.locked_until > now) {
      const retryAfterSec = Math.ceil((current.locked_until - now) / 1000);
      const retryMin = Math.ceil(retryAfterSec / 60);
      return {
        ok: false,
        locked: true,
        retryAfterSec,
        error: `Bạn đã nhập sai mật khẩu quá ${MAX_FAILED_ATTEMPTS} lần. Hệ thống tạm khóa đăng nhập từ thiết bị/IP này trong ${retryMin} phút để chống dò mật khẩu!`,
      };
    }

    const expected = this.getAdminPasswordSync();
    const isMatch = Boolean(password) && (await timingSafeStringMatch(password, expected));

    if (!isMatch) {
      const resetExpiredWindow = current && now - current.updated_at > LOCKOUT_MS;
      const nextCount = (resetExpiredWindow ? 0 : current?.failed_count ?? 0) + 1;
      const lockedUntil = nextCount >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : 0;

      this.ctx.storage.sql.exec(
        `INSERT INTO login_attempts (ip, failed_count, locked_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           failed_count = excluded.failed_count,
           locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`,
        ip,
        nextCount >= MAX_FAILED_ATTEMPTS ? 0 : nextCount,
        lockedUntil,
        now
      );

      if (lockedUntil > now) {
        return {
          ok: false,
          locked: true,
          retryAfterSec: Math.ceil(LOCKOUT_MS / 1000),
          error: `Nhập sai ${MAX_FAILED_ATTEMPTS}/${MAX_FAILED_ATTEMPTS} lần! Đã tạm khóa đăng nhập 15 phút để chống dò mật khẩu.`,
        };
      }

      const remainingAttempts = MAX_FAILED_ATTEMPTS - nextCount;
      return {
        ok: false,
        remainingAttempts,
        error: `Mật khẩu không chính xác! (Còn ${remainingAttempts} lần thử trước khi khóa 15 phút)`,
      };
    }

    // Success -> clear failed attempts & issue 256-bit session token
    this.ctx.storage.sql.exec("DELETE FROM login_attempts WHERE ip = ?", ip);
    const token = this.createSessionTokenSync();
    return { ok: true, token };
  }

  async verifyAdminToken(token: string): Promise<boolean> {
    if (!token) return false;
    this.ensureAuthTablesSync();
    const now = Date.now();
    const sessionRows = this.ctx.storage.sql
      .exec<{ token: string }>(
        "SELECT token FROM admin_sessions WHERE token = ? AND expires_at > ?",
        token,
        now
      )
      .toArray();
    if (sessionRows.length > 0) return true;
    const expected = this.getAdminPasswordSync();
    return timingSafeStringMatch(token, expected);
  }

  async changeAdminPassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: boolean; token?: string; error?: string }> {
    const expected = this.getAdminPasswordSync();
    const isMatch =
      Boolean(currentPassword) && (await timingSafeStringMatch(currentPassword, expected));
    if (!isMatch) {
      return { ok: false, error: "Mật khẩu hiện tại không đúng." };
    }
    const cleaned = String(newPassword ?? "").trim();
    if (cleaned.length < 4) {
      return { ok: false, error: "Mật khẩu mới phải có ít nhất 4 ký tự." };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('admin_password', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      cleaned
    );
    // Revoke all old sessions and issue a fresh session token
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions");
    const token = this.createSessionTokenSync();
    return { ok: true, token };
  }

  async listEvents(): Promise<EventMeta[]> {
    const rows = this.ctx.storage.sql
      .exec<{ meta_json: string }>("SELECT meta_json FROM events ORDER BY created_at DESC")
      .toArray();
    return rows.map((r) => JSON.parse(r.meta_json) as EventMeta);
  }

  async getEvent(slug: string): Promise<EventMeta | null> {
    const rows = this.ctx.storage.sql
      .exec<{ meta_json: string }>("SELECT meta_json FROM events WHERE slug = ?", slug)
      .toArray();
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].meta_json) as EventMeta;
  }

  async upsertEvent(meta: EventMeta): Promise<EventMeta> {
    const now = new Date().toISOString();
    const updated: EventMeta = {
      ...meta,
      updatedAt: meta.updatedAt || now,
      createdAt: meta.createdAt || now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO events (slug, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`,
      updated.slug,
      JSON.stringify(updated),
      updated.createdAt,
      updated.updatedAt
    );
    return updated;
  }

  async updateCounts(slug: string, totalGuests: number, totalCheckins: number): Promise<void> {
    const existing = await this.getEvent(slug);
    if (!existing) return;
    existing.totalGuests = totalGuests;
    existing.totalCheckins = totalCheckins;
    existing.updatedAt = new Date().toISOString();
    await this.upsertEvent(existing);
  }

  async deleteEvent(slug: string): Promise<boolean> {
    this.ctx.storage.sql.exec("DELETE FROM events WHERE slug = ?", slug);
    return true;
  }
}
