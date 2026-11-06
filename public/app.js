// ============================================================================
// Client-side Utilities (Phone normalization, Canvas image compression, Retry)
// ============================================================================

function normalizePhone(input) {
  if (input === null || input === undefined) return "";
  let raw = String(input).trim();
  if (!raw) return "";
  if (/^\d+(\.\d+)?e\+\d+$/i.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) raw = Math.round(num).toString();
  }
  let digits = raw.replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("0084") && digits.length >= 12) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("84") && (digits.length === 11 || digits.length === 12)) {
    digits = "0" + digits.slice(2);
  } else if (digits.length === 9 && /^[35789]/.test(digits)) {
    digits = "0" + digits;
  }
  return digits;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} - ${pad(
      d.getDate()
    )}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

const ADMIN_AUTH_KEY = "checkin_admin_password";

async function fetchJsonWithRetry(url, options = {}, retries = 3) {
  let lastErr;
  const mergedHeaders = { ...(options.headers || {}) };
  if (String(url).startsWith("/api/admin/")) {
    const savedPwd = sessionStorage.getItem(ADMIN_AUTH_KEY) || "";
    if (savedPwd && !mergedHeaders["x-admin-password"]) {
      mergedHeaders["x-admin-password"] = savedPwd;
    }
  }
  const reqOptions = { ...options, headers: mergedHeaders };
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, reqOptions);
      const data = await res.json().catch(() => ({}));
      if (res.status >= 500 && i < retries) {
        const delay = 100 + Math.floor(Math.random() * 250) * (i + 1);
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, delay);
        await promise;
        continue;
      }
      return { status: res.status, ok: res.ok, data };
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        const delay = 120 + Math.floor(Math.random() * 250) * (i + 1);
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, delay);
        await promise;
        continue;
      }
    }
  }
  throw lastErr || new Error("Không thể kết nối máy chủ, vui lòng thử lại.");
}

async function compressImageFile(file, maxWidth, maxHeight, quality = 0.85, preferPng = false) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("Không đọc được file ảnh"));
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error("Định dạng ảnh không hợp lệ"));
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      const ratio = Math.min(maxWidth / w, maxHeight / h, 1);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const mime = preferPng ? "image/png" : "image/jpeg";
      resolve(canvas.toDataURL(mime, quality));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  return promise;
}

// ============================================================================
// Router Entrypoint
// ============================================================================
const appEl = document.getElementById("app");
const path = window.location.pathname;
const eventMatch = /^\/e\/([a-z0-9-]+)\/?$/i.exec(path);

if (eventMatch) {
  initGuestCheckinApp(eventMatch[1].toLowerCase());
} else {
  initAdminApp();
}

// ============================================================================
// 1. MOBILE GUEST CHECK-IN APP (/e/:slug)
// ============================================================================
function isDayOpenClient(day, mode, todayVN, dayIndex = 0) {
  if (mode === "single") return true;
  if (day.active === false) return false;
  if (day.date && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && todayVN) {
    return day.date <= todayVN;
  }
  return dayIndex === 0;
}

function addDaysYMD(ymd, offsetDays) {
  const baseMs = ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd)
    ? Date.parse(`${ymd}T00:00:00Z`)
    : Date.now() + 7 * 3600_000;
  return new Date(baseMs + offsetDays * 86400_000).toISOString().slice(0, 10);
}

async function initGuestCheckinApp(slug) {
  const state = {
    slug,
    loadingEvent: true,
    event: null,
    errorEvent: null,
    phone: "",
    submitting: false,
    submittingDayKey: null,
    lookupResult: null,
    verifiedGuest: null,
    flashMessage: null,
    walkinName: "",
  };
  function getDefaultOpenDayKey(ev, daysList) {
    const today = ev.todayVN || new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    // Prefer the day matching today's exact date that isn't checked in yet
    const exactToday = daysList.find((d) => d.date === today && !d.checkedIn && d.isOpen);
    if (exactToday) return exactToday.key;
    // Otherwise first open unchecked day
    const firstOpenUnchecked = daysList.find((d) => d.isOpen && !d.checkedIn);
    if (firstOpenUnchecked) return firstOpenUnchecked.key;
    // Otherwise first open day
    const firstOpen = daysList.find((d) => d.isOpen);
    return firstOpen ? firstOpen.key : daysList[0]?.key || "day-1";
  }

  function renderGuest() {
    if (state.loadingEvent) {
      appEl.innerHTML = `
        <div class="guest-shell">
          <div class="guest-card" style="justify-content:center;align-items:center;padding:40px;text-align:center;">
            <div style="font-size:16px;font-weight:700;color:var(--text-muted);">Đang tải thông tin sự kiện...</div>
          </div>
        </div>
      `;
      return;
    }

    if (state.errorEvent || !state.event) {
      appEl.innerHTML = `
        <div class="guest-shell">
          <div class="guest-card" style="padding:32px 20px;text-align:center;">
            <div class="status-banner error">
              <div class="status-icon">⚠️</div>
              <h2 class="status-title">Không tìm thấy sự kiện</h2>
              <p class="status-desc">${escapeHtml(state.errorEvent || "Mã QR hoặc đường dẫn sự kiện không tồn tại.")}</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const ev = state.event;
    const todayVN = ev.todayVN || new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const themeColor = ev.themeColor || "#2563eb";
    document.documentElement.style.setProperty("--primary", themeColor);
    document.title = `${ev.title} - Check-in`;

    const initials = ev.title
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase();

    const modeBadge =
      ev.mode === "single"
        ? `<span>📅 Sự kiện 1 ngày</span>`
        : `<span>🗓️ Sự kiện ${ev.days.length} ngày</span>`;

    const lookup = state.lookupResult;
    const isPhoneVerified = Boolean(lookup && lookup.ok && lookup.allowedToCheckin);
    // Guest info card is ONLY shown when check-in just succeeded (verifiedGuest)
    const guest = state.verifiedGuest;

    const days = isPhoneVerified
      ? ev.days.map((d, idx) => {
          const fromLookup = lookup.days?.find((ld) => ld.key === d.key);
          return {
            key: d.key,
            label: d.label,
            date: d.date,
            isOpen:
              fromLookup !== undefined
                ? fromLookup.isOpen
                : isDayOpenClient(d, ev.mode, todayVN, idx),
            checkedIn: Boolean(fromLookup?.checkedIn),
            checkedInAt: fromLookup?.checkedInAt || null,
          };
        })
      : [];
    let resultHtml = "";

    if (state.flashMessage) {
      resultHtml += `
        <div class="status-banner ${state.flashMessage.type}" data-testid="checkin-status-banner">
          <div class="status-icon">${
            state.flashMessage.type === "success" ? "✅" : "❌"
          }</div>
          <h3 class="status-title">${escapeHtml(state.flashMessage.title)}</h3>
          <p class="status-desc">${escapeHtml(state.flashMessage.desc)}</p>
        </div>
      `;
    }

    if (guest) {
      const fieldEntries = Object.entries(guest.fields || {}).filter(
        ([, val]) => val !== null && val !== undefined && String(val).trim() !== ""
      );
      resultHtml += `
        <div class="guest-info-card" data-testid="guest-info-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">
            <h3 class="guest-info-name" style="margin:0;">👤 ${escapeHtml(
              guest.name || "Thông tin Khách mời"
            )}</h3>
            <span class="guest-ticket-badge">📱 ${escapeHtml(guest.phone)}</span>
          </div>
          ${
            fieldEntries.length > 0
              ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 12px;font-size:13.5px;">
                  ${fieldEntries
                    .map(
                      ([colName, val]) => `
                        <div>
                          <div style="font-size:11.5px;color:var(--text-light);font-weight:600;">${escapeHtml(
                            colName
                          )}</div>
                          <div style="font-weight:700;color:var(--text);">${escapeHtml(val)}</div>
                        </div>
                      `
                    )
                    .join("")}
                </div>`
              : `<div class="guest-info-meta"><span>📱 SĐT: <strong>${escapeHtml(
                  guest.phone
                )}</strong></span></div>`
          }
        </div>
      `;
    }

    // Multi-day list: ONLY visible after phone is verified as belonging to the event's guest list
    let multiDayHtml = "";
    if (ev.mode === "multi" && isPhoneVerified) {
      multiDayHtml = `
          <div class="field-label" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <span>CHỌN NGÀY CHECK-IN:</span>
            <span style="font-size:12px;font-weight:600;color:var(--text-muted);">
              Mỗi ngày chỉ check-in 1 lần
            </span>
          </div>
          <div class="day-list" data-testid="multi-day-list">
            ${days
              .map((d) => {
                const busy = state.submittingDayKey === d.key;

                // 1. Already checked in on this day -> show "Đã check-in Ngày X" (clicking again triggers duplicate warning)
                if (d.checkedIn) {
                  return `
                    <div class="day-card is-checked" data-day-key="${escapeHtml(
                      d.key
                    )}" data-checkin-day="${escapeHtml(
                      d.key
                    )}" data-checked="true" style="cursor:pointer;">
                      <div class="day-card-left">
                        <div class="day-card-title">${escapeHtml(d.label)}</div>
                        <div class="day-card-sub">
                          Đã check-in lúc <strong>${escapeHtml(
                            formatDateTime(d.checkedInAt)
                          )}</strong>
                        </div>
                      </div>
                      <span class="day-checked-pill" data-testid="badge-checked-${escapeHtml(
                        d.key
                      )}">
                        ✅ Đã check-in ${escapeHtml(d.label)}
                      </span>
                    </div>
                  `;
                }

                // 2. Future day not open yet ("sang ngày tiếp theo mới mở")
                if (!d.isOpen) {
                  return `
                    <div class="day-card" data-day-key="${escapeHtml(
                      d.key
                    )}" data-open="false" style="opacity:0.65;background:var(--surface-muted);">
                      <div class="day-card-left">
                        <div class="day-card-title">${escapeHtml(d.label)}</div>
                        <div class="day-card-sub">
                          🔒 Chưa mở${d.date ? ` (Mở ngày ${escapeHtml(d.date)})` : " (Sang ngày tiếp theo mới mở)"}
                        </div>
                      </div>
                      <button type="button" class="btn btn-outline btn-sm" disabled data-testid="btn-locked-${escapeHtml(
                        d.key
                      )}">
                        🔒 Chưa mở
                      </button>
                    </div>
                  `;
                }

                // 3. Open day & not checked in yet -> button to Check-in
                return `
                  <div class="day-card" data-day-key="${escapeHtml(
                    d.key
                  )}" data-checked="false" data-open="true">
                    <div class="day-card-left">
                      <div class="day-card-title">${escapeHtml(d.label)}</div>
                      <div class="day-card-sub">${
                        d.date
                          ? `📅 ${escapeHtml(d.date)} • Đang mở check-in`
                          : "Đang mở check-in"
                      }</div>
                    </div>
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      style="height:44px;padding:0 16px;font-size:14px;"
                      data-checkin-day="${escapeHtml(d.key)}"
                      ${busy ? "disabled" : ""}
                    >
                      ${busy ? "Đang xử lý..." : `Check-in ${escapeHtml(d.label)}`}
                    </button>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
    }

    const checkedToday = days.some((d) => d.checkedIn && d.isOpen);

    appEl.innerHTML = `
      <div class="guest-shell">
        <div class="guest-card">
          <!-- Banner -->
          <div class="event-banner-wrap">
            ${
              ev.bannerUrl
                ? `<img class="event-banner-img" src="${escapeHtml(
                    ev.bannerUrl
                  )}" alt="Banner sự kiện" />`
                : `<svg viewBox="0 0 800 300" width="100%" height="100%" preserveAspectRatio="none" style="display:block;">
                    <defs>
                      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stop-color="${escapeHtml(themeColor)}" />
                        <stop offset="100%" stop-color="#0f172a" />
                      </linearGradient>
                    </defs>
                    <rect width="800" height="300" fill="url(#bgGrad)" />
                    <circle cx="700" cy="40" r="160" fill="rgba(255,255,255,0.08)" />
                    <circle cx="120" cy="260" r="120" fill="rgba(255,255,255,0.06)" />
                  </svg>`
            }
            <div class="event-banner-overlay"></div>
          </div>

          <!-- Header with Logo & Title -->
          <div class="event-header-block">
            <div class="event-logo-row">
              <div class="event-logo-box" data-testid="event-logo">
                ${
                  ev.logoUrl
                    ? `<img src="${escapeHtml(ev.logoUrl)}" alt="Logo" />`
                    : `<span>${escapeHtml(initials || "QR")}</span>`
                }
              </div>
              <div class="event-mode-pill">${modeBadge}</div>
            </div>
            <h1 class="event-title" data-testid="event-title">${escapeHtml(ev.title)}</h1>
            ${
              ev.subtitle
                ? `<p class="event-subtitle">${escapeHtml(ev.subtitle)}</p>`
                : ""
            }
            ${
              ev.location
                ? `<div class="event-location">📍 <span>${escapeHtml(ev.location)}</span></div>`
                : ""
            }
          </div>

          <!-- Body -->
          <div class="guest-body">
            <form id="guest-checkin-form" style="margin:0;display:flex;flex-direction:column;gap:12px;">
              <div>
                <label class="field-label" for="guest-phone-input">
                  NHẬP SỐ ĐIỆN THOẠI ĐỂ CHECK-IN
                </label>
                <div class="phone-input-group">
                  <input
                    id="guest-phone-input"
                    class="phone-input"
                    type="tel"
                    inputmode="numeric"
                    autocomplete="tel"
                    placeholder="Nhập SĐT (VD: 0912345678)"
                    value="${escapeHtml(state.phone)}"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                id="guest-submit-btn"
                class="btn btn-primary btn-block"
                style="height:54px;font-size:17px;"
                ${state.submitting ? "disabled" : ""}
              >
                ${
                  state.submitting
                    ? "Đang xử lý..."
                    : "✅ ĐIỂM DANH / CHECK-IN NGAY"
                }
              </button>
            </form>

            ${resultHtml}
            ${multiDayHtml}
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById("guest-checkin-form");
    const phoneInput = document.getElementById("guest-phone-input");
    const lookupBtn = document.getElementById("guest-lookup-btn");

    if (phoneInput) {
      phoneInput.addEventListener("input", (e) => {
        state.phone = e.target.value;
        const norm = normalizePhone(state.phone);
        if (state.lookupResult && state.lookupResult.phone !== norm) {
          state.lookupResult = null;
          state.verifiedGuest = null;
          state.flashMessage = null;
          renderGuest();
          const el = document.getElementById("guest-phone-input");
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }
      });
    }

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        doCheckin();
      });
    }

    document.querySelectorAll("[data-checkin-day]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dayKey = btn.getAttribute("data-checkin-day");
        doCheckin(dayKey);
      });
    });
  }

  async function loadEvent() {
    state.loadingEvent = true;
    renderGuest();
    try {
      const { ok, data } = await fetchJsonWithRetry(`/api/events/${slug}/public`);
      if (!ok || !data.ok) {
        state.errorEvent = data.error || "Sự kiện không tồn tại.";
      } else {
        state.event = data.event;
      }
    } catch (err) {
      state.errorEvent = err.message || "Lỗi kết nối mạng.";
    } finally {
      state.loadingEvent = false;
      renderGuest();
    }
  }

  async function doLookup(rawPhone) {
    const cleaned = normalizePhone(rawPhone);
    state.verifiedGuest = null;
    if (!cleaned) {
      state.lookupResult = null;
      state.flashMessage = {
        type: "error",
        title: "Vui lòng nhập số điện thoại",
        desc: "Hãy nhập số điện thoại của bạn vào ô bên trên.",
      };
      renderGuest();
      return;
    }

    state.flashMessage = null;
    try {
      const { data } = await fetchJsonWithRetry(
        `/api/events/${slug}/lookup?phone=${encodeURIComponent(cleaned)}`
      );
      state.phone = cleaned;
      if (!data.ok || !data.allowedToCheckin) {
        state.lookupResult = null;
        state.flashMessage = {
          type: "error",
          title: "Không tìm thấy SĐT",
          desc: data.reason || "Số điện thoại này không có trong danh sách khách mời của sự kiện.",
        };
      } else {
        state.lookupResult = data;
      }
    } catch (err) {
      state.lookupResult = null;
      state.flashMessage = {
        type: "error",
        title: "Lỗi kết nối",
        desc: err.message || "Vui lòng thử lại.",
      };
    } finally {
      renderGuest();
    }
  }

  async function doCheckin(dayKey) {
    const cleaned = normalizePhone(state.phone);
    if (!cleaned) {
      state.flashMessage = {
        type: "error",
        title: "Chưa nhập số điện thoại",
        desc: "Vui lòng nhập số điện thoại của bạn trước khi bấm Check-in.",
      };
      renderGuest();
      document.getElementById("guest-phone-input")?.focus();
      return;
    }

    state.submitting = true;
    state.submittingDayKey = dayKey;
    state.flashMessage = null;
    state.verifiedGuest = null;
    renderGuest();

    try {
      const { data } = await fetchJsonWithRetry(`/api/events/${slug}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: cleaned,
          dayKey,
          walkinName: state.walkinName,
        }),
      });

      state.phone = data.phone || cleaned;
      if (data.status === "NOT_IN_GUEST_LIST") {
        state.lookupResult = null;
        state.verifiedGuest = null;
        state.flashMessage = {
          type: "error",
          title: "Không tìm thấy SĐT",
          desc: data.message || "Số điện thoại này không có trong danh sách khách mời của sự kiện.",
        };
      } else if (data.status === "CHECKED_IN") {
        state.lookupResult = {
          ok: true,
          allowedToCheckin: true,
          phone: state.phone,
          days: data.days || [],
        };
        state.verifiedGuest = data.guest || null;
        state.flashMessage = {
          type: "success",
          title: data.message || "Check-in thành công!",
          desc: `SĐT ${state.phone} đã check-in thành công lúc ${formatDateTime(
            data.checkedInAt
          )}.`,
        };
      } else if (data.status === "ALREADY_CHECKED_IN") {
        state.lookupResult = {
          ok: true,
          allowedToCheckin: true,
          phone: state.phone,
          days: data.days || [],
        };
        // Do NOT show guest info when check-in is rejected as duplicate!
        state.verifiedGuest = null;
        state.flashMessage = {
          type: "error",
          title: "Số điện thoại này đã check-in hôm nay rồi!",
          desc: `${data.message} (Đã điểm danh lúc ${formatDateTime(data.checkedInAt)})`,
        };
      } else if (data.status === "DAY_NOT_OPEN") {
        state.verifiedGuest = null;
        state.flashMessage = {
          type: "error",
          title: "Ngày này chưa mở Check-in",
          desc: data.message || "Sang ngày tiếp theo mới mở check-in.",
        };
      } else {
        state.lookupResult = null;
        state.verifiedGuest = null;
        state.flashMessage = {
          type: "error",
          title: "Không thể Check-in",
          desc: data.message || "Số điện thoại không hợp lệ.",
        };
      }
    } catch (err) {
      state.verifiedGuest = null;
      state.flashMessage = {
        type: "error",
        title: "Lỗi kết nối",
        desc: err.message || "Vui lòng bấm thử lại.",
      };
    } finally {
      state.submitting = false;
      state.submittingDayKey = null;
      renderGuest();
    }
  }

  loadEvent();
}

// ============================================================================
// 2. ADMIN DASHBOARD APP (/ or /admin)
// ============================================================================
async function initAdminApp() {
  const state = {
    authenticated: Boolean(sessionStorage.getItem(ADMIN_AUTH_KEY)),
    loginError: "",
    showChangePassword: false,
    events: [],
    selectedSlug: null,
    activeTab: "qr", // "qr" | "guests" | "report" | "settings"
    report: null,
    loading: false,
    creatingNew: false,
    searchQuery: "",
    filterDay: "all",
    toast: null,
    rawExcelObjects: null,
    excelAllHeaders: [],
    selectedPhoneCol: "",
    excelOtherCols: [],
    parsedExcelRows: null,
    parsedExcelFileName: "",
    uploadingGuests: false,
    formDraft: null,
  };
  function showToast(msg, type = "success") {
    state.toast = { msg, type };
    renderAdmin();
    setTimeout(() => {
      if (state.toast?.msg === msg) {
        state.toast = null;
        renderAdmin();
      }
    }, 3500);
  }

  function createDefaultDraft() {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const tomorrow = addDaysYMD(today, 1);
    return {
      slug: "",
      title: "",
      subtitle: "",
      location: "",
      mode: "multi",
      multiRule: "once_per_day",
      requireGuestList: true,
      themeColor: "#2563eb",
      days: [
        { key: "day-1", label: "Ngày 1", date: today, active: true },
        { key: "day-2", label: "Ngày 2", date: tomorrow, active: true },
      ],
      logoUrl: "",
      bannerUrl: "",
      logoDataUrl: null,
      bannerDataUrl: null,
      removeLogo: false,
      removeBanner: false,
    };
  }

  function loadDraftFromEvent(ev) {
    if (!ev) {
      state.formDraft = createDefaultDraft();
      return;
    }
    state.formDraft = {
      slug: ev.slug,
      title: ev.title,
      subtitle: ev.subtitle || "",
      location: ev.location || "",
      mode: ev.mode || "single",
      multiRule: ev.multiRule || "once_per_day",
      requireGuestList: ev.requireGuestList !== false,
      themeColor: ev.themeColor || "#2563eb",
      days:
        Array.isArray(ev.days) && ev.days.length > 0
          ? ev.days.map((d) => ({ ...d }))
          : [{ key: "day-1", label: "Ngày 1", date: "", active: true }],
      logoUrl: ev.logoUrl || "",
      bannerUrl: ev.bannerUrl || "",
      logoDataUrl: null,
      bannerDataUrl: null,
      removeLogo: false,
      removeBanner: false,
    };
  }

  async function fetchEventsList(selectSlug) {
    state.loading = true;
    renderAdmin();
    try {
      const { status, data } = await fetchJsonWithRetry("/api/admin/events");
      if (status === 401) {
        sessionStorage.removeItem(ADMIN_AUTH_KEY);
        state.authenticated = false;
        return;
      }
      state.authenticated = true;
      state.events = data.events || [];
      if (selectSlug) {
        state.selectedSlug = selectSlug;
        state.creatingNew = false;
      } else if (!state.selectedSlug && state.events.length > 0) {
        state.selectedSlug = state.events[0].slug;
      }

      if (state.selectedSlug && !state.creatingNew) {
        await fetchEventReport(state.selectedSlug);
      } else if (state.events.length === 0) {
        state.creatingNew = true;
        state.formDraft = createDefaultDraft();
      }
    } finally {
      state.loading = false;
      renderAdmin();
    }
  }

  async function fetchEventReport(slug) {
    const { ok, data } = await fetchJsonWithRetry(`/api/admin/events/${slug}/report`);
    if (ok && data.ok) {
      state.report = data;
      const idx = state.events.findIndex((e) => e.slug === slug);
      if (idx >= 0 && data.meta) state.events[idx] = data.meta;
      loadDraftFromEvent(data.meta);
    }
  }

  function renderEventForm(isNew) {
    const d = state.formDraft || createDefaultDraft();
    const previewLogo = d.logoDataUrl || (!d.removeLogo ? d.logoUrl : "");
    const previewBanner = d.bannerDataUrl || (!d.removeBanner ? d.bannerUrl : "");

    return `
      <form id="admin-event-form" style="display:flex;flex-direction:column;gap:16px;">
        <div class="form-grid">
          <div class="form-full">
            <label class="field-label">Tên sự kiện *</label>
            <input
              id="ev-title"
              class="input"
              type="text"
              placeholder="VD: Hội nghị Khách hàng Thường niên 2026"
              value="${escapeHtml(d.title)}"
              required
            />
          </div>

          <div>
            <label class="field-label">Mã đường dẫn (Slug QR)</label>
            <input
              id="ev-slug"
              class="input"
              type="text"
              placeholder="Tự động tạo từ tên sự kiện"
              value="${escapeHtml(d.slug)}"
              ${!isNew ? "readonly style='background:#f1f5f9;color:#64748b;'" : ""}
            />
          </div>

          <div>
            <label class="field-label">Màu chủ đạo giao diện</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input
                id="ev-color"
                type="color"
                value="${escapeHtml(d.themeColor || "#2563eb")}"
                style="width:48px;height:42px;border:1px solid var(--border);border-radius:8px;cursor:pointer;padding:2px;"
              />
              <input
                id="ev-color-text"
                class="input"
                type="text"
                value="${escapeHtml(d.themeColor || "#2563eb")}"
              />
            </div>
          </div>

          <div>
            <label class="field-label">Mô tả ngắn / Thời gian</label>
            <input
              id="ev-subtitle"
              class="input"
              type="text"
              placeholder="VD: 08:00 - 17:00 | Tháng 11/2026"
              value="${escapeHtml(d.subtitle)}"
            />
          </div>

          <div>
            <label class="field-label">Địa điểm tổ chức</label>
            <input
              id="ev-location"
              class="input"
              type="text"
              placeholder="VD: Trung tâm Hội nghị Quốc gia"
              value="${escapeHtml(d.location)}"
            />
          </div>

          <!-- Logo Upload -->
          <div class="media-upload-box">
            <label class="field-label" style="margin:0;">Logo Sự kiện (Hiển thị trên đầu trang Check-in)</label>
            ${
              previewLogo
                ? `<div style="display:flex;align-items:center;gap:10px;">
                    <img class="media-preview-img" src="${escapeHtml(previewLogo)}" alt="Logo preview" />
                    <button type="button" id="btn-remove-logo" class="btn btn-danger-outline btn-sm">Xóa Logo</button>
                  </div>`
                : `<div style="font-size:12px;color:var(--text-muted);">Chưa có logo (Sẽ hiển thị chữ viết tắt sự kiện)</div>`
            }
            <input id="ev-logo-file" type="file" accept="image/*" style="font-size:12.5px;" />
            <input
              id="ev-logo-url"
              class="input"
              type="text"
              placeholder="Hoặc dán trực tiếp URL ảnh Logo..."
              value="${escapeHtml(d.logoUrl.startsWith("/api/") ? "" : d.logoUrl)}"
            />
          </div>

          <!-- Banner Upload -->
          <div class="media-upload-box">
            <label class="field-label" style="margin:0;">Banner Sự kiện (Ảnh bìa ngang trên điện thoại)</label>
            ${
              previewBanner
                ? `<div style="display:flex;align-items:center;gap:10px;">
                    <img class="media-preview-img" src="${escapeHtml(previewBanner)}" alt="Banner preview" />
                    <button type="button" id="btn-remove-banner" class="btn btn-danger-outline btn-sm">Xóa Banner</button>
                  </div>`
                : `<div style="font-size:12px;color:var(--text-muted);">Chưa có banner (Sẽ dùng nền chuyển sắc mặc định)</div>`
            }
            <input id="ev-banner-file" type="file" accept="image/*" style="font-size:12.5px;" />
            <input
              id="ev-banner-url"
              class="input"
              type="text"
              placeholder="Hoặc dán trực tiếp URL ảnh Banner..."
              value="${escapeHtml(d.bannerUrl.startsWith("/api/") ? "" : d.bannerUrl)}"
            />
          </div>

          <!-- Check-in Mode: Single-day vs Multi-day -->
          <div class="form-full" style="background:var(--surface-muted);padding:16px;border-radius:12px;border:1px solid var(--border);">
            <label class="field-label" style="margin-bottom:10px;">CHẾ ĐỘ NGÀY CHECK-IN *</label>
            <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:14px;">
              <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
                <input type="radio" name="ev-mode" value="single" ${
                  d.mode === "single" ? "checked" : ""
                } />
                <span>Sự kiện Check-in 1 Ngày (Mỗi SĐT 1 lần duy nhất)</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
                <input type="radio" name="ev-mode" value="multi" ${
                  d.mode === "multi" ? "checked" : ""
                } />
                <span>Sự kiện Nhiều Ngày (Khách chọn ngày; đã check-in Ngày 1 sẽ hiện Đã check-in Ngày 1)</span>
              </label>
            </div>

            ${
              d.mode === "multi"
                ? `
                  <div style="margin-bottom:12px;">
                    <label class="field-label">Quy tắc cho sự kiện nhiều ngày:</label>
                    <select id="ev-multi-rule" class="select">
                      <option value="once_per_day" ${
                        d.multiRule === "once_per_day" ? "selected" : ""
                      }>
                        Mỗi SĐT được check-in tối đa 1 lần cho MỖI ngày (Ngày 1 xong, Ngày 2 chọn Ngày 2)
                      </option>
                      <option value="once_per_event" ${
                        d.multiRule === "once_per_event" ? "selected" : ""
                      }>
                        Mỗi SĐT chỉ được chọn 1 ngày duy nhất trong cả sự kiện
                      </option>
                    </select>
                  </div>

                  <div style="display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                      <span style="font-size:13px;font-weight:700;">Danh sách các ngày của sự kiện:</span>
                      <button type="button" id="btn-add-day" class="btn btn-outline btn-sm">➕ Thêm ngày</button>
                    </div>
                    ${d.days
                      .map(
                        (day, idx) => `
                          <div style="display:flex;gap:8px;align-items:center;">
                            <input
                              class="input day-label-input"
                              data-idx="${idx}"
                              type="text"
                              placeholder="Tên ngày (VD: Ngày ${idx + 1})"
                              value="${escapeHtml(day.label)}"
                              required
                            />
                            <input
                              class="input day-date-input"
                              data-idx="${idx}"
                              type="date"
                              value="${escapeHtml(day.date || "")}"
                              style="max-width:170px;"
                            />
                            ${
                              d.days.length > 1
                                ? `<button type="button" class="btn btn-danger-outline btn-sm btn-remove-day" data-idx="${idx}">Xóa</button>`
                                : ""
                            }
                          </div>
                        `
                      )
                      .join("")}
                  </div>
                `
                : `
                  <div style="display:flex;gap:8px;align-items:center;">
                    <input
                      class="input day-label-input"
                      data-idx="0"
                      type="text"
                      placeholder="Nhãn ngày (VD: Ngày sự kiện)"
                      value="${escapeHtml(d.days[0]?.label || "Ngày sự kiện")}"
                    />
                    <input
                      class="input day-date-input"
                      data-idx="0"
                      type="date"
                      value="${escapeHtml(d.days[0]?.date || "")}"
                      style="max-width:180px;"
                    />
                  </div>
                `
            }
          </div>

          <div class="form-full">
            <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;font-size:14px;">
              <input id="ev-require-list" type="checkbox" ${
                d.requireGuestList ? "checked" : ""
              } style="width:18px;height:18px;" />
              <span>Chỉ cho phép SĐT nằm trong danh sách Excel đã tải lên được Check-in (Bỏ chọn nếu cho phép khách tự do Walk-in)</span>
            </label>
          </div>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;">
          ${
            isNew && state.events.length > 0
              ? `<button type="button" id="btn-cancel-new" class="btn btn-outline btn-sm">Hủy</button>`
              : ""
          }
          <button type="submit" class="btn btn-primary" style="height:44px;">
            💾 ${isNew ? "Tạo Sự Kiện & Sinh Mã QR" : "Lưu Cấu Hình Sự Kiện"}
          </button>
        </div>
      </form>
    `;
  }

  function renderAdmin() {
    if (!state.authenticated) {
      appEl.innerHTML = `
        <div class="guest-shell">
          <div class="guest-card" style="max-width:420px;margin:40px auto;padding:28px 24px;">
            <div style="text-align:center;margin-bottom:20px;">
              <div class="admin-brand-icon" style="width:52px;height:52px;font-size:20px;margin:0 auto 12px;">🔒</div>
              <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;">Đăng nhập Quản trị Sự kiện</h2>
              <p style="margin:0;font-size:13.5px;color:var(--text-muted);">
                Vui lòng nhập mật khẩu Quản trị viên để truy cập hệ thống
              </p>
            </div>
            ${
              state.loginError
                ? `<div class="status-banner error" style="margin-bottom:16px;padding:12px;">
                    <div style="font-weight:700;font-size:13.5px;">❌ ${escapeHtml(state.loginError)}</div>
                  </div>`
                : ""
            }
            <form id="admin-login-form" style="display:flex;flex-direction:column;gap:14px;">
              <div>
                <label class="field-label" for="admin-password-input">MẬT KHẨU QUẢN TRỊ VIÊN</label>
                <input
                  id="admin-password-input"
                  class="input"
                  type="password"
                  placeholder="Nhập mật khẩu Admin..."
                  required
                  autofocus
                />
              </div>
              <button type="submit" id="admin-login-btn" class="btn btn-primary btn-block" style="height:46px;font-size:15px;">
                🔑 Đăng nhập Quản trị
              </button>
            </form>
          </div>
        </div>
      `;

      const handleAdminLogin = async (e) => {
        if (e) e.preventDefault();
        const pwd = document.getElementById("admin-password-input")?.value || "";
        if (!pwd) return;
        const { ok, data } = await fetchJsonWithRetry("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd }),
        });
        if (ok && data.ok) {
          sessionStorage.setItem(ADMIN_AUTH_KEY, data.token || pwd);
          state.authenticated = true;
          state.loginError = "";
          await fetchEventsList();
        } else {
          state.loginError = data.error || "Mật khẩu không chính xác!";
          renderAdmin();
        }
      };

      document.getElementById("admin-login-form")?.addEventListener("submit", handleAdminLogin);
      document.getElementById("admin-login-btn")?.addEventListener("click", handleAdminLogin);
      return;
    }

    const selectedEvent = state.report?.meta || state.events.find((e) => e.slug === state.selectedSlug);
    const checkinUrl = selectedEvent ? `${window.location.origin}/e/${selectedEvent.slug}` : "";
    const qrSvgUrl = selectedEvent
      ? `/api/events/${selectedEvent.slug}/qr.svg?url=${encodeURIComponent(checkinUrl)}`
      : "";

    let rightPanelHtml = "";

    if (state.creatingNew || !selectedEvent) {
      rightPanelHtml = `
        <div class="panel">
          <h2 class="panel-title">✨ Tạo Sự Kiện Check-in Mới</h2>
          ${renderEventForm(true)}
        </div>
      `;
    } else {
      const stats = state.report?.stats || {
        totalGuests: selectedEvent.totalGuests || 0,
        uniqueCheckedInPhones: 0,
        totalCheckinLogs: selectedEvent.totalCheckins || 0,
        byDay: {},
      };

      let tabContentHtml = "";

      if (state.activeTab === "qr") {
        tabContentHtml = `
          <div class="form-grid" style="align-items:center;">
            <div class="qr-showcase">
              <img id="qr-preview-img" src="${escapeHtml(qrSvgUrl)}" alt="QR Code sự kiện" />
              <div style="margin-top:12px;font-weight:800;font-size:16px;">${escapeHtml(
                selectedEvent.title
              )}</div>
              <div style="font-size:13px;color:var(--text-muted);margin-top:4px;word-break:break-all;">
                <a href="${escapeHtml(checkinUrl)}" target="_blank" style="color:var(--primary);font-weight:700;">
                  ${escapeHtml(checkinUrl)}
                </a>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px;">
                <a href="${escapeHtml(checkinUrl)}" target="_blank" class="btn btn-primary btn-sm">
                  📱 Mở trang Check-in
                </a>
                <button type="button" id="btn-copy-link" class="btn btn-outline btn-sm">
                  📋 Copy Link
                </button>
                <button type="button" id="btn-download-qr-png" class="btn btn-outline btn-sm">
                  ⬇️ Tải QR (PNG)
                </button>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:12px;">
              <div class="kpi-grid" style="margin:0;">
                <div class="kpi-card">
                  <div class="kpi-label">Khách trong danh sách</div>
                  <div class="kpi-val">${stats.totalGuests}</div>
                </div>
                <div class="kpi-card">
                  <div class="kpi-label">SĐT đã Check-in</div>
                  <div class="kpi-val" style="color:var(--success);">${stats.uniqueCheckedInPhones}</div>
                </div>
              </div>

              <div class="guest-info-card">
                <div style="font-weight:800;margin-bottom:6px;">📌 Tóm tắt cấu hình sự kiện:</div>
                <ul style="margin:0;padding-left:18px;font-size:13.5px;color:var(--text-muted);display:flex;flex-direction:column;gap:4px;">
                  <li>Chế độ: <strong>${
                    selectedEvent.mode === "single"
                      ? "Check-in 1 ngày"
                      : `Check-in nhiều ngày (${selectedEvent.days.length} ngày)`
                  }</strong></li>
                  <li>Các ngày: <strong>${selectedEvent.days
                    .map((d) => escapeHtml(d.label))
                    .join(", ")}</strong></li>
                  <li>Danh sách khách: <strong>${
                    selectedEvent.requireGuestList
                      ? "Bắt buộc SĐT nằm trong file Excel"
                      : "Mở tự do (Cho phép cả SĐT ngoài Excel)"
                  }</strong></li>
                  <li>Logo & Banner: <strong>${
                    selectedEvent.logoUrl ? "Đã có Logo" : "Logo mặc định"
                  } • ${selectedEvent.bannerUrl ? "Đã có Banner" : "Banner mặc định"}</strong></li>
                </ul>
              </div>
            </div>
          </div>
        `;
      } else if (state.activeTab === "guests") {
        const existingCols =
          Array.isArray(selectedEvent.excelColumns) && selectedEvent.excelColumns.length > 0
            ? selectedEvent.excelColumns
            : ["Họ và tên", "Ghi chú"];

        tabContentHtml = `
          <div style="display:flex;flex-direction:column;gap:18px;">
            <div class="media-upload-box" style="padding:18px;">
              <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;">
                <div>
                  <h3 style="margin:0 0 4px;font-size:16px;">📤 Tải File Excel Linh Hoạt — Tự Động Map Mọi Cột Theo SĐT</h3>
                  <p style="margin:0;font-size:13px;color:var(--text-muted);">
                    Bạn có thể tải lên file Excel (<code>.xlsx, .xls, .csv</code>) với <strong>bất kỳ cấu trúc cột nào</strong>. Hệ thống lấy <strong>Số điện thoại làm khóa chính</strong> và tự động map toàn bộ các cột còn lại theo SĐT đó.
                  </p>
                </div>
                <button type="button" id="btn-download-template" class="btn btn-outline btn-sm">
                  📥 Tải file Excel mẫu (.xlsx)
                </button>
              </div>

              <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
                <input
                  id="excel-file-input"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  style="font-size:14px;"
                />
              </div>

              ${
                state.rawExcelObjects && state.excelAllHeaders.length > 0
                  ? `
                    <div style="margin-top:12px;background:#fff;border:1.5px solid var(--primary);border-radius:12px;padding:14px;">
                      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);">
                        <div style="min-width:240px;flex:1;">
                          <label class="field-label" for="excel-phone-col-select">
                            🔑 Chọn cột chứa Số điện thoại (Khóa chính để map):
                          </label>
                          <select id="excel-phone-col-select" class="select">
                            ${state.excelAllHeaders
                              .map(
                                (h) => `
                                  <option value="${escapeHtml(h)}" ${
                                  h === state.selectedPhoneCol ? "selected" : ""
                                }>
                                    Cột: ${escapeHtml(h)}
                                  </option>
                                `
                              )
                              .join("")}
                          </select>
                        </div>
                        <div style="flex:2;min-width:240px;">
                          <div class="field-label">📋 Các cột thông tin đi kèm (Tự động gắn theo SĐT):</div>
                          <div style="display:flex;flex-wrap:wrap;gap:6px;">
                            ${
                              state.excelOtherCols.length > 0
                                ? state.excelOtherCols
                                    .map(
                                      (col) =>
                                        `<span class="guest-ticket-badge" style="padding:4px 10px;">${escapeHtml(
                                          col
                                        )}</span>`
                                    )
                                    .join("")
                                : `<span style="font-size:12.5px;color:var(--text-muted);">Chỉ có duy nhất cột SĐT</span>`
                            }
                          </div>
                        </div>
                      </div>

                      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;">
                        <div>
                          <strong>📄 File: ${escapeHtml(state.parsedExcelFileName)}</strong> —
                          Hợp lệ <strong style="color:var(--primary);">${
                            state.parsedExcelRows?.length || 0
                          }</strong> SĐT.
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:8px;">
                          <button
                            type="button"
                            id="btn-confirm-import-merge"
                            class="btn btn-primary btn-sm"
                            ${
                              state.uploadingGuests || !state.parsedExcelRows?.length
                                ? "disabled"
                                : ""
                            }
                          >
                            ${
                              state.uploadingGuests
                                ? "Đang tải lên..."
                                : `✅ Map & Gộp ${state.parsedExcelRows?.length || 0} SĐT`
                            }
                          </button>
                          <button
                            type="button"
                            id="btn-confirm-import-replace"
                            class="btn btn-danger-outline btn-sm"
                            ${
                              state.uploadingGuests || !state.parsedExcelRows?.length
                                ? "disabled"
                                : ""
                            }
                          >
                            Thay thế toàn bộ danh sách cũ
                          </button>
                        </div>
                      </div>

                      <div class="table-wrap" style="max-height:240px;overflow-y:auto;">
                        <table>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>🔑 SĐT Chuẩn hóa (${escapeHtml(state.selectedPhoneCol)})</th>
                              ${state.excelOtherCols
                                .map((c) => `<th>${escapeHtml(c)}</th>`)
                                .join("")}
                            </tr>
                          </thead>
                          <tbody>
                            ${(state.parsedExcelRows || [])
                              .slice(0, 15)
                              .map(
                                (r, i) => `
                                  <tr>
                                    <td>${i + 1}</td>
                                    <td><strong>${escapeHtml(r.phone)}</strong></td>
                                    ${state.excelOtherCols
                                      .map(
                                        (c) =>
                                          `<td>${escapeHtml(r.fields?.[c] || "—")}</td>`
                                      )
                                      .join("")}
                                  </tr>
                                `
                              )
                              .join("")}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  `
                  : ""
              }
            </div>

            <!-- Dynamic manual add / update by phone -->
            <form id="manual-guest-form" class="guest-info-card" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
              <div style="flex:1;min-width:140px;">
                <label class="field-label">🔑 SĐT Khách *</label>
                <input id="manual-phone" class="input" type="tel" placeholder="0912345678" required />
              </div>
              ${existingCols
                .map(
                  (col) => `
                    <div style="flex:1;min-width:140px;">
                      <label class="field-label">${escapeHtml(col)}</label>
                      <input
                        class="input manual-dyn-field"
                        data-col-name="${escapeHtml(col)}"
                        type="text"
                        placeholder="Nhập ${escapeHtml(col)}..."
                      />
                    </div>
                  `
                )
                .join("")}
              <button type="submit" class="btn btn-outline btn-sm" style="height:42px;">➕ Thêm / Cập nhật theo SĐT</button>
            </form>
          </div>
        `;
      } else if (state.activeTab === "report") {
        const allGuests = state.report?.guests || [];
        const colSet = new Set(selectedEvent.excelColumns || []);
        for (const g of allGuests) {
          for (const k of Object.keys(g.fields || {})) {
            if (k) colSet.add(k);
          }
        }
        const dynamicCols = Array.from(colSet);

        const q = state.searchQuery.trim().toLowerCase();
        const filteredGuests = allGuests.filter((g) => {
          if (q) {
            const fieldVals = Object.values(g.fields || {}).join(" ");
            const hay = `${g.phone} ${g.name || ""} ${fieldVals}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          if (state.filterDay === "checked_any") {
            return Object.keys(g.checkins || {}).length > 0;
          }
          if (state.filterDay === "unchecked_all") {
            return Object.keys(g.checkins || {}).length === 0;
          }
          if (state.filterDay !== "all") {
            return Boolean(g.checkins?.[state.filterDay]);
          }
          return true;
        });
        tabContentHtml = `
          <div>
            <div class="kpi-grid">
              <div class="kpi-card">
                <div class="kpi-label">Tổng danh sách</div>
                <div class="kpi-val">${stats.totalGuests}</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Khách đã Check-in</div>
                <div class="kpi-val" style="color:var(--success);">${stats.uniqueCheckedInPhones}</div>
              </div>
              ${selectedEvent.days
                .map(
                  (d) => `
                    <div class="kpi-card">
                      <div class="kpi-label">${escapeHtml(d.label)}</div>
                      <div class="kpi-val" style="color:var(--primary);">${
                        stats.byDay?.[d.key] ?? 0
                      }</div>
                    </div>
                  `
                )
                .join("")}
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="display:flex;flex-wrap:wrap;gap:8px;flex:1;">
                <input
                  id="report-search-input"
                  class="input"
                  type="search"
                  placeholder="Tìm theo SĐT, Họ tên, Mã vé..."
                  value="${escapeHtml(state.searchQuery)}"
                  style="max-width:260px;"
                />
                <select id="report-filter-select" class="select" style="max-width:210px;">
                  <option value="all" ${state.filterDay === "all" ? "selected" : ""}>Tất cả khách (${
          allGuests.length
        })</option>
                  <option value="checked_any" ${
                    state.filterDay === "checked_any" ? "selected" : ""
                  }>Đã check-in (${stats.uniqueCheckedInPhones})</option>
                  <option value="unchecked_all" ${
                    state.filterDay === "unchecked_all" ? "selected" : ""
                  }>Chưa check-in</option>
                  ${selectedEvent.days
                    .map(
                      (d) => `
                        <option value="${escapeHtml(d.key)}" ${
                        state.filterDay === d.key ? "selected" : ""
                      }>Đã check-in ${escapeHtml(d.label)} (${stats.byDay?.[d.key] ?? 0})</option>
                      `
                    )
                    .join("")}
                </select>
              </div>
              <div style="display:flex;gap:8px;">
                <button type="button" id="btn-refresh-report" class="btn btn-outline btn-sm">🔄 Làm mới</button>
                <button type="button" id="btn-export-excel" class="btn btn-primary btn-sm">📊 Xuất kết quả Excel (.xlsx)</button>
                <button type="button" id="btn-reset-checkins" class="btn btn-danger-outline btn-sm">Reset Check-in</button>
              </div>
            </div>

            <div class="table-wrap" style="max-height:480px;overflow-y:auto;">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>🔑 ${escapeHtml(selectedEvent.phoneColumnName || "Số điện thoại")}</th>
                    ${dynamicCols.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}
                    ${selectedEvent.days
                      .map((d) => `<th>${escapeHtml(d.label)}</th>`)
                      .join("")}
                  </tr>
                </thead>
                <tbody>
                  ${
                    filteredGuests.length === 0
                      ? `<tr><td colspan="${
                          2 + dynamicCols.length + selectedEvent.days.length
                        }" style="text-align:center;padding:24px;color:var(--text-muted);">Chưa có dữ liệu khớp bộ lọc.</td></tr>`
                      : filteredGuests
                          .slice(0, 500)
                          .map(
                            (g, idx) => `
                              <tr>
                                <td>${idx + 1}</td>
                                <td><strong>${escapeHtml(g.phone)}</strong></td>
                                ${dynamicCols
                                  .map(
                                    (col) =>
                                      `<td>${escapeHtml(g.fields?.[col] || "—")}</td>`
                                  )
                                  .join("")}
                                ${selectedEvent.days
                                  .map((d) => {
                                    const ts = g.checkins?.[d.key];
                                    return ts
                                      ? `<td><span class="day-checked-pill" style="padding:3px 9px;font-size:12px;">✅ ${escapeHtml(
                                          formatDateTime(ts)
                                        )}</span></td>`
                                      : `<td style="color:#94a3b8;">Chưa check-in</td>`;
                                  })
                                  .join("")}
                              </tr>
                            `
                          )
                          .join("")
                  }
                </tbody>
              </table>
            </div>
          </div>
        `;
      } else if (state.activeTab === "settings") {
        tabContentHtml = `
          <div>
            ${renderEventForm(false)}
            <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;color:var(--text-muted);">Xóa vĩnh viễn sự kiện này và toàn bộ danh sách:</span>
              <button type="button" id="btn-delete-event" class="btn btn-danger-outline btn-sm">🗑️ Xóa sự kiện</button>
            </div>
          </div>
        `;
      }

      rightPanelHtml = `
        <div class="panel">
          <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;">
            <div>
              <h2 style="margin:0;font-size:20px;font-weight:800;">${escapeHtml(
                selectedEvent.title
              )}</h2>
              <div style="font-size:13px;color:var(--text-muted);">
                Slug: <code>/e/${escapeHtml(selectedEvent.slug)}</code> •
                ${
                  selectedEvent.mode === "single"
                    ? "Sự kiện 1 ngày"
                    : `Sự kiện ${selectedEvent.days.length} ngày`
                }
              </div>
            </div>
            <a href="/e/${escapeHtml(
              selectedEvent.slug
            )}" target="_blank" class="btn btn-primary btn-sm">
              📱 Xem Trang Check-in
            </a>
          </div>

          <div class="tabs-bar">
            <button type="button" class="tab-btn ${
              state.activeTab === "qr" ? "active" : ""
            }" data-tab="qr">
              🔳 Mã QR & Link
            </button>
            <button type="button" class="tab-btn ${
              state.activeTab === "guests" ? "active" : ""
            }" data-tab="guests">
              📥 Tải File Excel Khách (${stats.totalGuests})
            </button>
            <button type="button" class="tab-btn ${
              state.activeTab === "report" ? "active" : ""
            }" data-tab="report">
              📊 Danh sách & Kết quả Check-in (${stats.totalCheckinLogs})
            </button>
            <button type="button" class="tab-btn ${
              state.activeTab === "settings" ? "active" : ""
            }" data-tab="settings">
              ⚙️ Cấu hình (Logo, Banner, Ngày)
            </button>
          </div>

          ${tabContentHtml}
        </div>
      `;
    }

    appEl.innerHTML = `
      <div class="admin-shell">
        <div class="admin-topbar">
          <div class="admin-brand">
            <div class="admin-brand-icon">QR</div>
            <div>
              <div style="font-weight:800;font-size:18px;">Hệ thống Quản lý QR Check-in Sự Kiện</div>
              <div style="font-size:12.5px;color:var(--text-muted);">
                Cloudflare Edge + SQLite Durable Objects • Chịu tải 1.000+ check-in đồng thời
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button type="button" id="btn-new-event" class="btn btn-primary btn-sm">
              ➕ Tạo Sự Kiện Mới
            </button>
            <button type="button" id="btn-toggle-change-pwd" class="btn btn-outline btn-sm">
              🔑 Đổi mật khẩu
            </button>
            <button type="button" id="btn-admin-logout" class="btn btn-danger-outline btn-sm">
              🚪 Đăng xuất
            </button>
          </div>
        </div>

        ${
          state.showChangePassword
            ? `<div class="panel" style="margin-bottom:16px;border:1px solid var(--primary);background:var(--primary-soft);">
                <form id="admin-change-pwd-form" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
                  <div style="flex:1 1 180px;">
                    <label class="field-label">Mật khẩu hiện tại</label>
                    <input id="pwd-current" type="password" class="input" placeholder="Nhập mật khẩu hiện tại" required />
                  </div>
                  <div style="flex:1 1 180px;">
                    <label class="field-label">Mật khẩu mới (tối thiểu 4 ký tự)</label>
                    <input id="pwd-new" type="password" class="input" placeholder="Nhập mật khẩu mới" required />
                  </div>
                  <button type="submit" class="btn btn-primary btn-sm" style="height:42px;">Lưu mật khẩu mới</button>
                  <button type="button" id="btn-cancel-change-pwd" class="btn btn-outline btn-sm" style="height:42px;">Đóng</button>
                </form>
              </div>`
            : ""
        }
        ${
          state.toast
            ? `<div class="status-banner ${state.toast.type}" style="margin-bottom:16px;padding:12px 16px;">
                <strong>${escapeHtml(state.toast.msg)}</strong>
              </div>`
            : ""
        }

        <div class="admin-grid">
          <div class="panel">
            <div class="panel-title">
              <span>Danh sách Sự kiện (${state.events.length})</span>
            </div>
            <div class="event-nav-list">
              ${
                state.events.length === 0
                  ? `<div style="font-size:13px;color:var(--text-muted);padding:12px 0;">Chưa có sự kiện nào. Hãy tạo sự kiện đầu tiên!</div>`
                  : state.events
                      .map(
                        (ev) => `
                          <button
                            type="button"
                            class="event-nav-item ${
                              !state.creatingNew && ev.slug === state.selectedSlug ? "active" : ""
                            }"
                            data-select-slug="${escapeHtml(ev.slug)}"
                          >
                            <div class="event-nav-name">${escapeHtml(ev.title)}</div>
                            <div class="event-nav-stats">
                              <span>${
                                ev.mode === "single" ? "1 ngày" : `${ev.days.length} ngày`
                              }</span>
                              <span>✅ ${ev.totalCheckins || 0} / ${ev.totalGuests || 0} khách</span>
                            </div>
                          </button>
                        `
                      )
                      .join("")
              }
            </div>
          </div>

          ${rightPanelHtml}
        </div>
      </div>
    `;

    bindAdminEvents();
  }

  function syncDraftFromDom() {
    if (!state.formDraft) return;
    const d = state.formDraft;
    const titleEl = document.getElementById("ev-title");
    const slugEl = document.getElementById("ev-slug");
    const subEl = document.getElementById("ev-subtitle");
    const locEl = document.getElementById("ev-location");
    const colorTextEl = document.getElementById("ev-color-text");
    const reqListEl = document.getElementById("ev-require-list");
    const multiRuleEl = document.getElementById("ev-multi-rule");
    const logoUrlEl = document.getElementById("ev-logo-url");
    const bannerUrlEl = document.getElementById("ev-banner-url");

    if (titleEl) d.title = titleEl.value;
    if (slugEl) d.slug = slugEl.value;
    if (subEl) d.subtitle = subEl.value;
    if (locEl) d.location = locEl.value;
    if (colorTextEl) d.themeColor = colorTextEl.value;
    if (reqListEl) d.requireGuestList = reqListEl.checked;
    if (multiRuleEl) d.multiRule = multiRuleEl.value;
    if (logoUrlEl && logoUrlEl.value.trim()) d.logoUrl = logoUrlEl.value.trim();
    if (bannerUrlEl && bannerUrlEl.value.trim()) d.bannerUrl = bannerUrlEl.value.trim();

    document.querySelectorAll(".day-label-input").forEach((input) => {
      const idx = Number(input.getAttribute("data-idx"));
      if (d.days[idx]) d.days[idx].label = input.value;
    });
    document.querySelectorAll(".day-date-input").forEach((input) => {
      const idx = Number(input.getAttribute("data-idx"));
      if (d.days[idx]) d.days[idx].date = input.value;
    });
  }

  function bindAdminEvents() {
    document.getElementById("btn-new-event")?.addEventListener("click", () => {
      state.creatingNew = true;
      state.formDraft = createDefaultDraft();
      renderAdmin();
    });

    document.getElementById("btn-toggle-change-pwd")?.addEventListener("click", () => {
      state.showChangePassword = !state.showChangePassword;
      renderAdmin();
    });

    document.getElementById("btn-cancel-change-pwd")?.addEventListener("click", () => {
      state.showChangePassword = false;
      renderAdmin();
    });

    document.getElementById("admin-change-pwd-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById("pwd-current")?.value || "";
      const newPassword = document.getElementById("pwd-new")?.value || "";
      const { ok, data } = await fetchJsonWithRetry("/api/admin/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (ok && data.ok) {
        sessionStorage.setItem(ADMIN_AUTH_KEY, data.token || newPassword.trim());
        state.showChangePassword = false;
        showToast("Đã đổi mật khẩu Quản trị viên thành công!");
      } else {
        showToast(data.error || "Không thể đổi mật khẩu.", "error");
      }
    });

    document.getElementById("btn-admin-logout")?.addEventListener("click", () => {
      sessionStorage.removeItem(ADMIN_AUTH_KEY);
      state.authenticated = false;
      state.showChangePassword = false;
      renderAdmin();
    });

    document.getElementById("btn-cancel-new")?.addEventListener("click", () => {
      state.creatingNew = false;
      if (state.report?.meta) loadDraftFromEvent(state.report.meta);
      renderAdmin();
    });

    document.querySelectorAll("[data-select-slug]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const slug = btn.getAttribute("data-select-slug");
        state.selectedSlug = slug;
        state.creatingNew = false;
        state.parsedExcelRows = null;
        await fetchEventReport(slug);
        renderAdmin();
      });
    });

    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.getAttribute("data-tab");
        renderAdmin();
      });
    });

    // Event Form bindings
    const eventForm = document.getElementById("admin-event-form");
    if (eventForm) {
      document.querySelectorAll('input[name="ev-mode"]').forEach((radio) => {
        radio.addEventListener("change", (e) => {
          syncDraftFromDom();
          state.formDraft.mode = e.target.value;
          if (state.formDraft.mode === "multi" && state.formDraft.days.length < 2) {
            const d1Date =
              state.formDraft.days[0]?.date ||
              new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
            state.formDraft.days = [
              { key: "day-1", label: "Ngày 1", date: d1Date, active: true },
              { key: "day-2", label: "Ngày 2", date: addDaysYMD(d1Date, 1), active: true },
            ];
          }
          renderAdmin();
        });
      });

      document.getElementById("ev-color")?.addEventListener("input", (e) => {
        const val = e.target.value;
        state.formDraft.themeColor = val;
        const txt = document.getElementById("ev-color-text");
        if (txt) txt.value = val;
      });

      document.getElementById("btn-add-day")?.addEventListener("click", () => {
        syncDraftFromDom();
        const nextNum = state.formDraft.days.length + 1;
        const prevDate =
          state.formDraft.days[state.formDraft.days.length - 1]?.date ||
          new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        state.formDraft.days.push({
          key: `day-${Date.now().toString(36)}-${nextNum}`,
          label: `Ngày ${nextNum}`,
          date: addDaysYMD(prevDate, 1),
          active: true,
        });
        renderAdmin();
      });

      document.querySelectorAll(".btn-remove-day").forEach((btn) => {
        btn.addEventListener("click", () => {
          syncDraftFromDom();
          const idx = Number(btn.getAttribute("data-idx"));
          state.formDraft.days.splice(idx, 1);
          renderAdmin();
        });
      });

      document.getElementById("ev-logo-file")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        syncDraftFromDom();
        try {
          state.formDraft.logoDataUrl = await compressImageFile(file, 360, 360, 0.9, true);
          state.formDraft.removeLogo = false;
          renderAdmin();
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      document.getElementById("ev-banner-file")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        syncDraftFromDom();
        try {
          state.formDraft.bannerDataUrl = await compressImageFile(file, 1200, 600, 0.85, false);
          state.formDraft.removeBanner = false;
          renderAdmin();
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      document.getElementById("btn-remove-logo")?.addEventListener("click", () => {
        syncDraftFromDom();
        state.formDraft.logoDataUrl = null;
        state.formDraft.logoUrl = "";
        state.formDraft.removeLogo = true;
        renderAdmin();
      });

      document.getElementById("btn-remove-banner")?.addEventListener("click", () => {
        syncDraftFromDom();
        state.formDraft.bannerDataUrl = null;
        state.formDraft.bannerUrl = "";
        state.formDraft.removeBanner = true;
        renderAdmin();
      });

      eventForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        syncDraftFromDom();
        const d = state.formDraft;
        const { ok, data } = await fetchJsonWithRetry("/api/admin/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        });
        if (!ok || !data.ok) {
          showToast(data.error || "Không thể lưu sự kiện", "error");
          return;
        }
        state.creatingNew = false;
        state.selectedSlug = data.event.slug;
        state.activeTab = "qr";
        await fetchEventsList(data.event.slug);
        showToast("Đã lưu thông tin sự kiện thành công!");
      });
    }

    // QR actions
    document.getElementById("btn-copy-link")?.addEventListener("click", async () => {
      const link = `${window.location.origin}/e/${state.selectedSlug}`;
      await navigator.clipboard?.writeText(link);
      showToast("Đã copy link Check-in vào bộ nhớ tạm!");
    });

    document.getElementById("btn-download-qr-png")?.addEventListener("click", () => {
      const img = document.getElementById("qr-preview-img");
      if (!img) return;
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 1024;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 1024, 1024);
      ctx.drawImage(img, 0, 0, 1024, 1024);
      const a = document.createElement("a");
      a.download = `qr-${state.selectedSlug}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    });

    // Excel Template & Upload
    document.getElementById("btn-download-template")?.addEventListener("click", () => {
      if (!window.XLSX) return;
      const rows = [
        {
          "Số điện thoại": "0912345678",
          "Họ và tên": "Nguyễn Văn An",
          "Công ty": "Tập đoàn ABC",
          "Chức vụ": "Giám đốc",
          "Mã vé": "VIP-001",
          "Ghi chú": "Khách VIP bàn 1",
        },
        {
          "Số điện thoại": "0987654321",
          "Họ và tên": "Trần Thị Bình",
          "Công ty": "Công ty XYZ",
          "Chức vụ": "Trưởng phòng",
          "Mã vé": "STD-002",
          "Ghi chú": "",
        },
      ];
      const ws = window.XLSX.utils.json_to_sheet(rows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "DanhSachKhach");
      window.XLSX.writeFile(wb, `mau-danh-sach-checkin-${state.selectedSlug || "su-kien"}.xlsx`);
    });

    function rebuildParsedExcelFromRaw(phoneCol) {
      const rawObjects = state.rawExcelObjects || [];
      const allHeaders = state.excelAllHeaders || [];
      const otherCols = allHeaders.filter((h) => h !== phoneCol);
      state.selectedPhoneCol = phoneCol;
      state.excelOtherCols = otherCols;

      const byPhone = new Map();
      for (const row of rawObjects) {
        const rawPhoneVal = row[phoneCol];
        const normPhone = normalizePhone(rawPhoneVal);
        if (!normPhone || normPhone.length < 8) continue;

        const prev = byPhone.get(normPhone) || { phone: normPhone, fields: {} };
        for (const col of otherCols) {
          const val = String(row[col] ?? "").trim();
          if (val !== "") {
            prev.fields[col] = val;
          }
        }
        byPhone.set(normPhone, prev);
      }
      state.parsedExcelRows = Array.from(byPhone.values());
    }

    document.getElementById("excel-file-input")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file || !window.XLSX) return;
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: "array" });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rawObjects = window.XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

      const headerSet = new Set();
      for (const r of rawObjects) {
        for (const k of Object.keys(r)) {
          if (k && !k.startsWith("__EMPTY")) headerSet.add(k);
        }
      }
      const allHeaders = Array.from(headerSet);
      state.rawExcelObjects = rawObjects;
      state.excelAllHeaders = allHeaders;
      state.parsedExcelFileName = file.name;

      // Auto-detect phone column
      let detectedPhoneCol =
        allHeaders.find((h) => {
          const norm = h
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d");
          return (
            norm.includes("sdt") ||
            norm.includes("dien thoai") ||
            norm.includes("phone") ||
            norm.includes("mobile") ||
            norm.includes("tel") ||
            norm.includes("so dt")
          );
        }) || "";

      if (!detectedPhoneCol && rawObjects.length > 0) {
        let bestCol = allHeaders[0] || "";
        let bestScore = -1;
        for (const h of allHeaders) {
          let score = 0;
          for (const r of rawObjects.slice(0, 30)) {
            const cand = normalizePhone(r[h]);
            if (/^0\d{8,10}$/.test(cand)) score++;
          }
          if (score > bestScore) {
            bestScore = score;
            bestCol = h;
          }
        }
        detectedPhoneCol = bestCol;
      }

      rebuildParsedExcelFromRaw(detectedPhoneCol);
      renderAdmin();
    });

    document.getElementById("excel-phone-col-select")?.addEventListener("change", (e) => {
      rebuildParsedExcelFromRaw(e.target.value);
      renderAdmin();
    });

    async function runBulkImport(mode) {
      if (!state.parsedExcelRows || !state.selectedSlug) return;
      state.uploadingGuests = true;
      renderAdmin();
      try {
        const rows = state.parsedExcelRows;
        const batchSize = 1000;
        let totalImported = 0;
        for (let i = 0; i < rows.length; i += batchSize) {
          const chunk = rows.slice(i, i + batchSize);
          const chunkMode = i === 0 ? mode : "merge";
          const { ok, data } = await fetchJsonWithRetry(
            `/api/admin/events/${state.selectedSlug}/guests/import`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                guests: chunk,
                mode: chunkMode,
                excelColumns: state.excelOtherCols,
                phoneColumnName: state.selectedPhoneCol,
              }),
            }
          );
          if (ok && data.ok) {
            totalImported += data.imported || 0;
          }
        }
        state.rawExcelObjects = null;
        state.parsedExcelRows = null;
        await fetchEventReport(state.selectedSlug);
        state.activeTab = "report";
        showToast(`Đã map & tải lên thành công ${totalImported} SĐT cùng ${state.excelOtherCols.length} cột dữ liệu!`);
      } catch (err) {
        showToast(err.message || "Lỗi khi nhập file Excel", "error");
      } finally {
        state.uploadingGuests = false;
        renderAdmin();
      }
    }

    document
      .getElementById("btn-confirm-import-merge")
      ?.addEventListener("click", () => runBulkImport("merge"));
    document
      .getElementById("btn-confirm-import-replace")
      ?.addEventListener("click", () => runBulkImport("replace"));

    document.getElementById("manual-guest-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const phone = document.getElementById("manual-phone")?.value || "";
      const fields = {};
      document.querySelectorAll(".manual-dyn-field").forEach((inp) => {
        const col = inp.getAttribute("data-col-name");
        const val = inp.value.trim();
        if (col && val) fields[col] = val;
      });
      const { ok, data } = await fetchJsonWithRetry(
        `/api/admin/events/${state.selectedSlug}/guests/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guests: [{ phone, fields }],
            mode: "merge",
          }),
        }
      );
      if (ok && data.ok && data.imported > 0) {
        await fetchEventReport(state.selectedSlug);
        renderAdmin();
        showToast(`Đã cập nhật thông tin cho SĐT ${normalizePhone(phone)}!`);
      } else {
        showToast("SĐT không hợp lệ!", "error");
      }
    });

    // Report search, filter, export, reset
    document.getElementById("report-search-input")?.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderAdmin();
      const el = document.getElementById("report-search-input");
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });

    document.getElementById("report-filter-select")?.addEventListener("change", (e) => {
      state.filterDay = e.target.value;
      renderAdmin();
    });

    document.getElementById("btn-refresh-report")?.addEventListener("click", async () => {
      if (!state.selectedSlug) return;
      await fetchEventReport(state.selectedSlug);
      renderAdmin();
      showToast("Đã cập nhật dữ liệu mới nhất!");
    });

    document.getElementById("btn-export-excel")?.addEventListener("click", () => {
      if (!window.XLSX || !state.report?.meta) return;
      const ev = state.report.meta;
      const guests = state.report.guests || [];
      const colSet = new Set(ev.excelColumns || []);
      for (const g of guests) {
        for (const k of Object.keys(g.fields || {})) {
          if (k) colSet.add(k);
        }
      }
      const dynamicCols = Array.from(colSet);
      const phoneHeader = ev.phoneColumnName || "Số điện thoại";

      const exportRows = guests.map((g, i) => {
        const row = {
          STT: i + 1,
          [phoneHeader]: g.phone,
        };
        for (const col of dynamicCols) {
          row[col] = g.fields?.[col] || "";
        }
        for (const d of ev.days) {
          row[`Trạng thái ${d.label}`] = g.checkins?.[d.key] ? "Đã check-in" : "Chưa check-in";
          row[`Thời gian ${d.label}`] = g.checkins?.[d.key]
            ? formatDateTime(g.checkins[d.key])
            : "";
        }
        return row;
      });
      const ws = window.XLSX.utils.json_to_sheet(exportRows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "KetQuaCheckin");
      window.XLSX.writeFile(wb, `ket-qua-checkin-${ev.slug}.xlsx`);
    });

    document.getElementById("btn-reset-checkins")?.addEventListener("click", async () => {
      if (!state.selectedSlug) return;
      const { ok } = await fetchJsonWithRetry(
        `/api/admin/events/${state.selectedSlug}/reset-checkins`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (ok) {
        await fetchEventReport(state.selectedSlug);
        renderAdmin();
        showToast("Đã đặt lại toàn bộ lượt check-in của sự kiện.");
      }
    });


    document.getElementById("btn-delete-event")?.addEventListener("click", async () => {
      if (!state.selectedSlug) return;
      const slugToDelete = state.selectedSlug;
      state.selectedSlug = null;
      await fetchJsonWithRetry(`/api/admin/events/${slugToDelete}`, { method: "DELETE" });
      await fetchEventsList();
      showToast("Đã xóa sự kiện.");
    });
  }

  if (state.authenticated) {
    fetchEventsList();
  } else {
    renderAdmin();
  }
}
