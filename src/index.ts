import QRCode from "qrcode";
import { RegistryDO } from "./registry-do";
import { EventDO } from "./event-do";
import { slugify } from "./phone";
import type { EventDay, EventMeta, GuestInput } from "./types";

export { RegistryDO, EventDO };

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function withDoRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries && (msg.includes("overloaded") || msg.includes("Network") || msg.includes("reset"))) {
        const delayMs = 40 + Math.floor(Math.random() * 120) * (attempt + 1);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, delayMs);
        await promise;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Edge isolate rate-limit map: protects Durable Objects from bot spam on the same phone
// while allowing 1,000+ concurrent guests on the same venue Wi-Fi IP without false positives.
const edgePhoneBuckets = new Map<string, { count: number; resetAt: number }>();

function allowEdgePhoneRequest(slug: string, rawPhone: string, maxPerMin = 20): boolean {
  const key = `${slug}:${rawPhone.replace(/\D+/g, "").slice(-10)}`;
  if (key.endsWith(":")) return true;
  const now = Date.now();
  if (edgePhoneBuckets.size > 5000) edgePhoneBuckets.clear();
  const entry = edgePhoneBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    edgePhoneBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxPerMin;
}

function buildPublicEventCacheKey(origin: string, slug: string): Request {
  return new Request(`${origin}/api/events/${slug}/public`, { method: "GET" });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // =========================================================================
      // PUBLIC GUEST ENDPOINTS (/api/events/:slug/...)
      // =========================================================================
      const publicEventMatch = /^\/api\/events\/([a-z0-9-]+)\/(public|lookup|checkin|qr\.svg|media\/(logo|banner))$/i.exec(
        path
      );

      if (publicEventMatch) {
        const slug = publicEventMatch[1].toLowerCase();
        const action = publicEventMatch[2].toLowerCase();
        const eventStub = env.EVENT_DO.getByName(slug);

        // 1. GET /api/events/:slug/public (Cached at Cloudflare Edge PoP + purged on Admin save)
        if (action === "public" && request.method === "GET") {
          const cache = caches.default;
          const cacheKey = buildPublicEventCacheKey(url.origin, slug);
          const cached = await cache.match(cacheKey);
          if (cached) {
            const hit = new Response(cached.body, cached);
            hit.headers.set("x-cf-edge-cache", "HIT");
            return hit;
          }

          const meta = await withDoRetry(() => eventStub.getPublicMeta());
          if (!meta) {
            return jsonResponse({ ok: false, error: "Sự kiện không tồn tại." }, 404);
          }
          const response = jsonResponse({ ok: true, event: meta }, 200, {
            "cache-control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
            "x-cf-edge-cache": "MISS",
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }

        // 2. GET /api/events/:slug/media/logo | banner (Edge-cached binary response)
        if ((action === "media/logo" || action === "media/banner") && request.method === "GET") {
          const mediaType = (publicEventMatch[3]?.toLowerCase() || "logo") as "logo" | "banner";
          const cache = caches.default;
          const cacheKey = new Request(url.toString(), { method: "GET" });
          const cached = await cache.match(cacheKey);
          if (cached) return cached;

          const media = await withDoRetry(() => eventStub.getMedia(mediaType));
          if (!media) {
            return new Response("Not found", { status: 404 });
          }

          const bytes = base64ToUint8Array(media.dataBase64);
          const response = new Response(bytes, {
            status: 200,
            headers: {
              "content-type": media.contentType,
              "cache-control": "public, max-age=86400, immutable",
            },
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }

        // 3. GET /api/events/:slug/qr.svg (Cached at Cloudflare Edge PoP)
        if (action === "qr.svg" && request.method === "GET") {
          const cache = caches.default;
          const cacheKey = new Request(url.toString(), { method: "GET" });
          const cached = await cache.match(cacheKey);
          if (cached) return cached;

          const targetUrl = url.searchParams.get("url") || `${url.origin}/e/${slug}`;
          const svg = await QRCode.toString(targetUrl, {
            type: "svg",
            width: 512,
            margin: 2,
            errorCorrectionLevel: "M",
            color: {
              dark: "#0f172a",
              light: "#ffffff",
            },
          });
          const response = new Response(svg, {
            status: 200,
            headers: {
              "content-type": "image/svg+xml; charset=utf-8",
              "cache-control": "public, max-age=86400, s-maxage=604800",
            },
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }

        // 4. GET /api/events/:slug/lookup?phone=...
        if (action === "lookup" && request.method === "GET") {
          const phone = url.searchParams.get("phone") || "";
          const result = await withDoRetry(() => eventStub.lookupPhone(phone));
          return jsonResponse(result);
        }

        // 5. POST /api/events/:slug/checkin
        if (action === "checkin" && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as {
            phone?: string;
            dayKey?: string;
            walkinName?: string;
          };
          const rawPhone = String(body.phone ?? "");
          if (!allowEdgePhoneRequest(slug, rawPhone, 20)) {
            return jsonResponse(
              {
                ok: false,
                status: "ERROR",
                message: "Bạn thao tác quá nhanh. Vui lòng đợi ít giây rồi thử lại.",
              },
              429
            );
          }
          const result = await withDoRetry(() =>
            eventStub.checkin({
              phone: String(body.phone ?? ""),
              dayKey: body.dayKey ? String(body.dayKey) : undefined,
              walkinName: body.walkinName ? String(body.walkinName) : undefined,
            })
          );
          return jsonResponse(
            result,
            result.ok ||
              result.status === "ALREADY_CHECKED_IN" ||
              result.status === "DAY_NOT_OPEN"
              ? 200
              : 400
          );
        }
      }

      // =========================================================================
      // ADMIN ENDPOINTS (/api/admin/...)
      // =========================================================================
      if (path.startsWith("/api/admin/")) {
        const registryStub = env.REGISTRY_DO.getByName("global");

        // POST /api/admin/login (with IP brute-force protection)
        if (path === "/api/admin/login" && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { password?: string };
          const cfIp = request.headers.get("cf-connecting-ip") || "";
          const clientIp =
            (cfIp && cfIp !== "127.0.0.1" && cfIp !== "::1" ? cfIp : "") ||
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            cfIp ||
            "local";
          const loginRes = await registryStub.loginAdmin(
            String(body.password ?? ""),
            clientIp
          );
          if (!loginRes.ok) {
            return jsonResponse(loginRes, loginRes.locked ? 429 : 401);
          }
          return jsonResponse(loginRes);
        }

        // Require x-admin-password / session token header on all other /api/admin/* routes
        const adminToken =
          request.headers.get("x-admin-password") ||
          (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const isAuthorized = await registryStub.verifyAdminToken(adminToken);
        if (!isAuthorized) {
          return jsonResponse(
            {
              ok: false,
              error: "UNAUTHORIZED",
              message: "Vui lòng đăng nhập mật khẩu Quản trị viên.",
            },
            401
          );
        }

        // POST /api/admin/change-password
        if (path === "/api/admin/change-password" && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as {
            currentPassword?: string;
            newPassword?: string;
          };
          const res = await registryStub.changeAdminPassword(
            String(body.currentPassword ?? ""),
            String(body.newPassword ?? "")
          );
          return jsonResponse(res, res.ok ? 200 : 400);
        }

        // GET /api/admin/events
        if (path === "/api/admin/events" && request.method === "GET") {
          const events = await registryStub.listEvents();
          return jsonResponse({ ok: true, events });
        }

      // POST /api/admin/events (Create or Update event)
      if (path === "/api/admin/events" && request.method === "POST") {
        const body = (await request.json()) as {
          slug?: string;
          title?: string;
          subtitle?: string;
          location?: string;
          mode?: "single" | "multi";
          multiRule?: "once_per_day" | "once_per_event";
          requireGuestList?: boolean;
          days?: EventDay[];
          logoUrl?: string;
          bannerUrl?: string;
          logoDataUrl?: string | null;
          bannerDataUrl?: string | null;
          removeLogo?: boolean;
          removeBanner?: boolean;
          themeColor?: string;
        };

        const title = String(body.title ?? "").trim();
        if (!title) {
          return jsonResponse({ ok: false, error: "Vui lòng nhập tên sự kiện." }, 400);
        }

        const slug = slugify(body.slug?.trim() || title);
        const eventStub = env.EVENT_DO.getByName(slug);
        const existing = await eventStub.getPublicMeta();
        const now = new Date().toISOString();

        const mode = body.mode === "multi" ? "multi" : "single";
        const multiRule =
          mode === "single"
            ? "once_per_event"
            : body.multiRule === "once_per_event"
            ? "once_per_event"
            : "once_per_day";

        let days: EventDay[] = Array.isArray(body.days) ? body.days : [];
        if (mode === "single") {
          days = [
            {
              key: "day-1",
              label: days[0]?.label?.trim() || "Ngày sự kiện",
              date: days[0]?.date || now.slice(0, 10),
              active: true,
            },
          ];
        } else {
          if (days.length === 0) {
            days = [
              { key: "day-1", label: "Ngày 1", date: now.slice(0, 10), active: true },
              { key: "day-2", label: "Ngày 2", date: "", active: true },
            ];
          } else {
            days = days.map((d, idx) => ({
              key: d.key?.trim() || `day-${idx + 1}`,
              label: d.label?.trim() || `Ngày ${idx + 1}`,
              date: d.date?.trim() || "",
              active: d.active !== false,
            }));
          }
        }

        const metaInput: EventMeta = {
          slug,
          title,
          subtitle: String(body.subtitle ?? existing?.subtitle ?? "").trim(),
          location: String(body.location ?? existing?.location ?? "").trim(),
          mode,
          multiRule,
          requireGuestList:
            typeof body.requireGuestList === "boolean"
              ? body.requireGuestList
              : existing?.requireGuestList ?? true,
          days,
          hasLogo: existing?.hasLogo ?? false,
          hasBanner: existing?.hasBanner ?? false,
          logoUrl:
            body.logoUrl !== undefined ? String(body.logoUrl).trim() : existing?.logoUrl ?? "",
          bannerUrl:
            body.bannerUrl !== undefined
              ? String(body.bannerUrl).trim()
              : existing?.bannerUrl ?? "",
          themeColor: String(body.themeColor ?? existing?.themeColor ?? "#2563eb").trim(),
          totalGuests: existing?.totalGuests ?? 0,
          totalCheckins: existing?.totalCheckins ?? 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        const savedMeta = await eventStub.saveEventConfig({
          meta: metaInput,
          logoDataUrl: body.logoDataUrl,
          bannerDataUrl: body.bannerDataUrl,
          removeLogo: body.removeLogo,
          removeBanner: body.removeBanner,
        });

        await registryStub.upsertEvent(savedMeta);
        ctx.waitUntil(caches.default.delete(buildPublicEventCacheKey(url.origin, slug)));
        return jsonResponse({ ok: true, event: savedMeta });
      }

      // Admin event-scoped routes: /api/admin/events/:slug...
      const adminEventMatch =
        /^\/api\/admin\/events\/([a-z0-9-]+)(?:\/(report|guests\/import|reset-checkins))?$/i.exec(
          path
        );

      if (adminEventMatch) {
        const slug = adminEventMatch[1].toLowerCase();
        const subAction = (adminEventMatch[2] || "").toLowerCase();
        const eventStub = env.EVENT_DO.getByName(slug);

        // DELETE /api/admin/events/:slug
        if (!subAction && request.method === "DELETE") {
          await eventStub.destroyEvent();
          await registryStub.deleteEvent(slug);
          ctx.waitUntil(caches.default.delete(buildPublicEventCacheKey(url.origin, slug)));
          return jsonResponse({ ok: true });
        }

        // GET /api/admin/events/:slug/report
        if (subAction === "report" && request.method === "GET") {
          const report = await eventStub.getAdminReport();
          if (!report.meta) {
            return jsonResponse({ ok: false, error: "Sự kiện không tồn tại." }, 404);
          }
          await registryStub.updateCounts(
            slug,
            report.stats.totalGuests,
            report.stats.totalCheckinLogs
          );
          return jsonResponse({ ok: true, ...report });
        }

        // POST /api/admin/events/:slug/guests/import
        if (subAction === "guests/import" && request.method === "POST") {
          const body = (await request.json()) as {
            guests?: GuestInput[];
            mode?: "merge" | "replace";
            excelColumns?: string[];
            phoneColumnName?: string;
          };
          const guests = Array.isArray(body.guests) ? body.guests : [];
          const importMode = body.mode === "replace" ? "replace" : "merge";

          const result = await eventStub.importGuests(
            guests,
            importMode,
            body.excelColumns,
            body.phoneColumnName
          );
          if (result.meta) {
            await registryStub.upsertEvent(result.meta);
          }
          ctx.waitUntil(caches.default.delete(buildPublicEventCacheKey(url.origin, slug)));
          return jsonResponse({
            ok: true,
            imported: result.imported,
            skipped: result.skipped,
            totalGuests: result.totalGuests,
            event: result.meta,
          });
        }

        // POST /api/admin/events/:slug/reset-checkins
        if (subAction === "reset-checkins" && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as {
            dayKey?: string;
            phone?: string;
          };
          const res = await eventStub.resetCheckins(body.dayKey, body.phone);
          const meta = await eventStub.getPublicMeta();
          if (meta) {
            await registryStub.upsertEvent(meta);
          }
          return jsonResponse({ ok: true, totalCheckins: res.totalCheckins, event: meta });
        }
      }
      }

      // SPA navigation fallback for /admin or /e/:slug
      if (path.startsWith("/api/")) {
        return jsonResponse({ ok: false, error: "API route not found" }, 404);
      }

      // Fallback to Static Assets binding for SPA paths
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(
        JSON.stringify({
          message: "Unhandled Worker error",
          path,
          method: request.method,
          error: e instanceof Error ? e.message : String(e),
        })
      );
      return jsonResponse(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Lỗi hệ thống, vui lòng thử lại.",
        },
        500
      );
    }
  },
} satisfies ExportedHandler<Env>;
