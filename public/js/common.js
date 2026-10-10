/* ============================================================
   Kisan Setu — shared frontend utilities
   (API wrapper, nav bar, notifications, badges, toasts)
   ============================================================ */

window.APP = {
  me: null,
  active: "",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
  });
}

function el(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function fmtMoney(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "-";
  const dt = new Date(d.length === 10 ? d + "T00:00:00" : d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "-";
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  return dt.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  const diff = Date.now() - dt.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return fmtDate(iso.slice(0, 10));
}

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

window.api = function (path, opts) {
  opts = opts || {};
  const init = Object.assign({ credentials: "include", headers: {} }, opts);
  init.headers = Object.assign({ Accept: "application/json" }, init.headers || {});
  if (
    init.body &&
    typeof init.body === "object" &&
    !(init.body instanceof FormData) &&
    init.body instanceof Object
  ) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  return fetch(path, init).then(function (res) {
    const isJson = (res.headers.get("content-type") || "").includes("json");
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        if (!res.ok) {
          const err = new Error(data && data.error ? data.error : "Request failed (HTTP " + res.status + ")");
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      })
      .catch(function (e) {
        if (e instanceof SyntaxError) {
          const err = new Error("Request failed (HTTP " + res.status + ")");
          err.status = res.status;
          err.data = {};
          throw err;
        }
        throw e;
      });
  });
};

window.showToast = function (message, type) {
  type = type || "success";
  let c = document.getElementById("toastContainer");
  if (!c) {
    c = el('<div id="toastContainer" aria-live="polite"></div>');
    document.body.appendChild(c);
  }
  const toast = el('<div class="toast toast-' + type + '" role="status">' + esc(message) + "</div>");
  c.appendChild(toast);
  requestAnimationFrame(function () {
    setTimeout(function () {
      toast.classList.add("show");
    }, 10);
  });
  setTimeout(function () {
    toast.classList.remove("show");
    setTimeout(function () {
      toast.remove();
    }, 300);
  }, 3600);
};

window.showError = function (e, fallback) {
  console.error(e);
  window.showToast((e && e.message ? e.message : fallback || "Something went wrong") , "error");
};

window.loadingSpinner = function () {
  return '<div class="loading-box"><div class="spinner" role="status" aria-label="' + esc(window.t("common.loading")) + '"></div></div>';
};

window.skeletonCards = function (count, label) {
  let html = "";
  for (let i = 0; i < (count || 3); i++) {
    html += '<div class="sk-card">' +
      '<div class="skeleton sk-line" style="width:45%"></div>' +
      '<div class="skeleton sk-line"></div>' +
      '<div class="skeleton sk-line short"></div>' +
      "</div>";
  }
  return '<div class="grid grid-3">' + html + "</div>";
};

const STATUS_BADGE_KEYS = {
  booked: "status.booked",
  "in-queue": "status.inQueue",
  weighing: "status.weighing",
  qc: "status.qc",
  approved: "status.approved",
  rejected: "status.rejected",
  cancelled: "status.cancelled",
  paid: "status.paid",
  processing: "status.processing",
  pending: "status.pending",
  open: "status.open",
  "in-progress": "status.inProgress",
  resolved: "status.resolved",
  closed: "status.closed",
  verified: "status.verified",
};

window.statusBadge = function (status) {
  const key = STATUS_BADGE_KEYS[status] || null;
  const label = key ? window.t(key) : esc(status || "-");
  const cls = "badge badge-" + esc(String(status || "").toLowerCase().replace(/\s+/g, "-"));
  return '<span class="' + cls + '">' + label + "</span>";
};

window.loadBadge = function (load) {
  load = Number(load) || 0;
  const cls = load < 50 ? "low" : load < 80 ? "mid" : "high";
  const fill = load < 50 ? "" : load < 80 ? " warn" : " hot";
  return (
    '<div class="cc-load ' + cls + '">' + load + "%</div>" +
    '<div class="load-wrap"><div class="load-fill' + fill + '" style="width:' + Math.min(100, load) + '%"></div></div>'
  );
};

window.openModal = function (html) {
  const overlay = el('<div class="modal-overlay" role="dialog" aria-modal="true"><div class="modal"></div></div>');
  overlay.querySelector(".modal").innerHTML = html;
  document.body.appendChild(overlay);
  requestAnimationFrame(function () {
    overlay.classList.add("open");
  });
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", onKey);
    }
  });
  return overlay;
};

window.closeModal = function () {
  const overlay = document.querySelector(".modal-overlay.open");
  if (!overlay) return;
  overlay.classList.remove("open");
  setTimeout(function () {
    overlay.remove();
  }, 200);
};

window.confirmDialog = function (title, message, okLabel, okClass) {
  return new Promise(function (resolve) {
    const overlay = window.openModal(
      '<div class="modal-head"><h3>' + esc(title) + '</h3><button class="modal-close" data-close="1">&times;</button></div>' +
      '<div class="modal-body"><p class="muted">' + esc(message) + "</p></div>" +
      '<div class="modal-foot">' +
      '<button class="btn btn-ghost" data-close="1">' + esc(window.t("common.cancel")) + "</button>" +
      '<button class="btn ' + (okClass || "btn-primary") + '" id="confirmOk" autofocus>' + esc(okLabel || window.t("common.confirm")) + "</button>" +
      "</div>"
    );
    function done(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.querySelector('[data-close="1"]').addEventListener("click", function () {
      done(false);
    });
    overlay.querySelector("#confirmOk").addEventListener("click", function () {
      done(true);
    });
  });
};

window.logout = function () {
  window.api("/api/logout", { method: "POST" })
    .then(function () {
      window.location.href = "/";
    })
    .catch(function () {
      window.location.href = "/";
    });
};

/* ---------- Nav bar ---------- */
function navAnchor(href, key, active) {
  return '<a href="' + href + '" class="' + (active ? "active" : "") + '">' + esc(window.t(key)) + "</a>";
}

function buildNav() {
  const root = document.getElementById("appNav");
  if (!root) return;
  const me = window.APP.me || { loggedIn: false };
  const active = window.APP.active;
  const loggedIn = !!(me && me.loggedIn);
  const isFarmer = loggedIn && me.role === "farmer";
  const isOfficer = loggedIn && me.role === "officer";

  let links = navAnchor("/", "nav.home", active === "home");
  if (isFarmer) {
    links += navAnchor("/booking", "nav.bookSlot", active === "booking") + navAnchor("/my-bookings", "nav.myBookings", active === "my-bookings") + navAnchor("/kyc", "nav.kyc", active === "kyc");
  }
  if (isOfficer) {
    links += navAnchor("/dashboard", "nav.dashboard", active === "dashboard");
  }
  if (!loggedIn) {
    links += navAnchor("/register", "nav.register", active === "register") + navAnchor("/login", "nav.login", active === "login");
  }

  let notif = "";
  if (isFarmer || isOfficer) {
    notif =
      '<div class="notif-bell" id="notifBell" title="' + esc(window.t("nav.notifications")) + '" aria-label="' + esc(window.t("nav.notifications")) + '">' +
      "🔔<span class=\"notif-count\"></span>" +
      '<div class="notif-panel" id="notifPanel">' +
      '<div class="notif-head"><strong>' + esc(window.t("nav.notifications")) + "</strong>" +
      '<button class="btn btn-sm btn-ghost" id="notifMarkRead">' + esc(window.t("nav.markAllRead")) + "</button></div>" +
      '<div class="notif-list" id="notifList"></div>' +
      "</div></div>";
  }

  let userChip = "";
  if (loggedIn) {
    userChip =
      '<span class="user-chip"><strong>' + esc(me.name || "") + "</strong> · " +
      (me.role === "officer" ? esc(window.t("role.officer")) : esc(window.t("role.farmer"))) +
      "</span>";
  }

  const langBtns = ["en", "hi", "te"].map(function (l) {
    const lbl = l === "en" ? "EN" : l === "hi" ? "हि" : "తె";
    return '<button type="button" data-lang-btn="' + l + '" data-lang="' + l + '">' + lbl + "</button>";
  }).join("");

  const logoutBtn = loggedIn ? '<button class="btn btn-sm btn-outline" id="navLogout">' + esc(window.t("nav.logout")) + "</button>" : "";

  root.innerHTML =
    '<div class="container">' +
    '<a class="brand" href="/"><span class="logo-mark">🌾</span>Kisan Setu</a>' +
    '<nav class="nav-links" aria-label="Main">' + links + "</nav>" +
    '<div class="nav-right">' +
    '<div class="lang-switch" role="group" aria-label="Language">' + langBtns + "</div>" +
    notif +
    userChip +
    logoutBtn +
    "</div>" +
    "</div>";

  // Language toggle
  root.querySelectorAll("[data-lang]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      window.setLang(btn.getAttribute("data-lang"));
      window.APP.lang = window.getLang();
      window.translatePage();
      buildNav();
      if (window.APP.me && window.APP.me.loggedIn) window.loadNotifications();
    });
  });
  document.querySelectorAll("[data-lang-btn]").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-lang") === window.getLang());
  });

  if (logoutBtn) {
    root.querySelector("#navLogout").addEventListener("click", window.logout);
  }
  if (notif) window.setupNotifications();
}

window.setupNotifications = function () {
  const bell = document.getElementById("notifBell");
  if (!bell) return;
  bell.addEventListener("click", function (e) {
    const panel = document.getElementById("notifPanel");
    if (e.target.closest("#notifMarkRead")) return;
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) window.loadNotifications();
  });
  const markAll = document.getElementById("notifMarkRead");
  if (markAll) {
    markAll.addEventListener("click", function () {
      window.api("/api/notifications/read", { method: "POST" }).then(function () {
        window.loadNotifications();
        window.transformNotifications([], "all-read");
      }).catch(function () {});
    });
  }
  document.addEventListener("click", function (e) {
    if (!bell.contains(e.target)) {
      const panel = document.getElementById("notifPanel");
      if (panel) panel.classList.remove("open");
    }
  });
};

window.loadNotifications = function () {
  const bell = document.getElementById("notifBell");
  if (!bell) return Promise.resolve();
  return window.api("/api/notifications").then(function (list) {
    const unread = list.filter(function (n) { return !n.read; }).length;
    const count = bell.querySelector(".notif-count");
    if (count) {
      count.textContent = unread;
      count.classList.toggle("show", unread > 0);
    }
    window.transformNotifications(list);
  }).catch(function () {});
};

window.transformNotifications = function (list, mode) {
  const listNode = document.getElementById("notifList");
  if (!listNode) return;
  if (mode === "all-read") {
    window.__KSNOTIFS__ = list;
    listNode.innerHTML = window.__ksNotifHtml__(true);
    return;
  }
  window.__KSNOTIFS__ = list;
  window.__ksNotifHtml__ = function (allRead) {
    const items = (window.__KSNOTIFS__ || []).slice(0, 15);
    if (!items.length) {
      return '<div class="notif-empty">' + esc(window.t("nav.noNotifications")) + "</div>";
    }
    return items.map(function (n) {
      const read = allRead || n.read;
      return '<div class="notif-item ' + (read ? "read" : "unread") + '">' +
        '<span class="dot"></span>' +
        "<div>" +
        '<div class="n-title">' + esc(n.title) + "</div>" +
        '<div class="n-body">' + esc(n.body) + "</div>" +
        '<div class="n-time">' + timeAgo(n.createdAt) + "</div>" +
        "</div></div>";
    }).join("");
  };
  listNode.innerHTML = window.__ksNotifHtml__(false);
};

window.initApp = function (options) {
  options = options || {};
  window.APP.active = options.active || "";
  window.translatePage();
  return window.api("/api/me")
    .then(function (me) {
      window.APP.me = me;
      if (options.requireRole) {
        if (!me.loggedIn) {
          window.location.href = options.loginRedirect || "/login";
          return Promise.reject("not-logged-in");
        }
        if (me.role !== options.requireRole) {
          window.location.href = me.role === "officer" ? "/dashboard" : "/my-bookings";
          return Promise.reject("wrong-role");
        }
      }
      buildNav();
      if (me.loggedIn) return window.loadNotifications();
    })
    .catch(function (e) {
      if (e === "not-logged-in" || e === "wrong-role") return;
      console.error("initApp error:", e);
      if (options.requireRole) {
        window.location.href = options.loginRedirect || "/login";
      }
    });
};