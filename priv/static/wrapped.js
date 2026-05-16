(function () {
  "use strict";

  const React = window.React;
  const NE    = window.NexusExtensions;
  const NET   = window.NexusExtensionTemplates;

  if (!React || !NE) {
    console.warn("[Wrapped] NexusExtensions not available — bundle loaded too early.");
    return;
  }

  const { useState, useEffect, useRef, useCallback } = React;
  const e = React.createElement;

  // ── API helper ────────────────────────────────────────────────────────────
  // All calls go through /ext/wrapped/api/...
  // Auth token is read from localStorage exactly as Nexus's own api.js does.

  const BASE = "/ext/wrapped/api";

  function apiFetch(path, opts = {}) {
    const token = localStorage.getItem("nexus_token");
    return fetch(BASE + path, {
      ...opts,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": token ? `Bearer ${token}` : "",
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(r => r.json());
  }

  // ── history.pushState patch ───────────────────────────────────────────────
  // Required: the structured clone algorithm strips functions (React components)
  // from navigation state. This patch sanitises the state object before it
  // reaches the browser, preventing the infinite loading spinner on back/forward.

  (function () {
    const orig = window.history.pushState.bind(window.history);

    function sanitize(obj) {
      if (obj === null || typeof obj !== "object") return obj;
      if (typeof obj === "function") return undefined;
      if (Array.isArray(obj)) return obj.map(sanitize).filter(v => v !== undefined);
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = sanitize(obj[k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }

    window.history.pushState = function (state, title, url) {
      try {
        JSON.stringify(state);
        return orig(state, title, url);
      } catch (_) {
        return orig(sanitize(state), title, url);
      }
    };
  })();

  // matchRoute patch: re-attach the live component if it was stripped by
  // pushState/popstate JSON serialisation.
  (function () {
    const origMatch = NE.matchRoute.bind(NE);
    NE.matchRoute = function (pathname) {
      const result = origMatch(pathname);
      if (result && !result.component) {
        const live = NE._routes && NE._routes.find(r => r.regex && r.regex.test(pathname));
        if (live && live.component) result.component = live.component;
      }
      return result;
    };
  })();

  // ── Navigation helper ─────────────────────────────────────────────────────

  function navToWrapped(year, username) {
    const match = NE.matchRoute(`/wrapped/${year}/${username}`);
    if (window._nexusNavigate) {
      window._nexusNavigate("ext-route", match || {});
    }
  }

  // =========================================================================
  // ADMIN PANEL
  // =========================================================================
  //
  // The Generation tab is fully custom — action buttons with live status.
  // Visibility, Content, and Notifications tabs delegate to TabbedPanel's
  // field renderer via SimpleSettingsPanel so they auto-integrate with the
  // top-bar Save Changes button.
  //
  // We build our own tab shell that matches the visual style of TabbedPanel
  // exactly (same tab button styles read from AdminExtensions.jsx source),
  // but the Generation tab renders custom JSX while the other tabs render
  // SimpleSettingsPanel instances.

  // ── Generation tab ────────────────────────────────────────────────────────

  function GenerationTab() {
    const currentYear = new Date().getFullYear();
    const [year, setYear]               = useState(String(currentYear));
    const [status, setStatus]           = useState(null);   // {total_active, generated, pending, pct_complete}
    const [statusLoading, setStatusLoading] = useState(false);
    const [genLoading, setGenLoading]   = useState(false);
    const [genResult, setGenResult]     = useState(null);   // {enqueued, year}
    const [genError, setGenError]       = useState(null);
    const [simLoading, setSimLoading]   = useState(false);
    const [simError, setSimError]       = useState(null);

    // Poll generation status when a batch is running
    const pollRef = useRef(null);

    const loadStatus = useCallback(() => {
      if (!year) return;
      setStatusLoading(true);
      apiFetch(`/admin/status/${year}`)
        .then(d => { if (d.data) setStatus(d.data); })
        .catch(() => {})
        .finally(() => setStatusLoading(false));
    }, [year]);

    useEffect(() => {
      loadStatus();
    }, [year, loadStatus]);

    // Start polling when pending > 0
    useEffect(() => {
      if (status && status.pending > 0 && !pollRef.current) {
        pollRef.current = setInterval(loadStatus, 3000);
      }
      if (status && status.pending === 0 && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      };
    }, [status, loadStatus]);

    const generateAll = () => {
      setGenLoading(true); setGenError(null); setGenResult(null);
      apiFetch("/admin/generate", {
        method: "POST",
        body:   { year: Number(year) },
      })
        .then(d => {
          if (d.data) { setGenResult(d.data); loadStatus(); }
          else setGenError(d.error || "Failed to enqueue generation");
        })
        .catch(() => setGenError("Network error"))
        .finally(() => setGenLoading(false));
    };

    const simulate = () => {
      setSimLoading(true); setSimError(null);
      apiFetch("/admin/simulate", {
        method: "POST",
        body:   { year: Number(year) },
      })
        .then(d => {
          if (d.data) {
            // Navigate to the admin's own Wrapped so they can preview it
            navToWrapped(d.data.year, d.data.username);
          } else {
            setSimError(d.error || "Simulation failed");
          }
        })
        .catch(() => setSimError("Network error"))
        .finally(() => setSimLoading(false));
    };

    const progressPct = status ? Math.min(100, status.pct_complete || 0) : 0;
    const isRunning   = status && status.pending > 0;

    return e("div", null,

      // Year selector
      e("div", { style: { marginBottom: 24 } },
        e("label", {
          style: { fontSize: 12, color: "var(--t4)", display: "block",
                   marginBottom: 6, fontWeight: 500 },
        }, "Year"),
        e("input", {
          type:      "number",
          className: "fi",
          value:     year,
          onChange:  ev => setYear(ev.target.value),
          style:     { maxWidth: 120 },
          min:       2020,
          max:       currentYear + 1,
        })
      ),

      // Status card
      status && e("div", {
        style: {
          background: "var(--s3)", border: "0.5px solid var(--b1)",
          borderRadius: 10, padding: "14px 16px", marginBottom: 20,
        },
      },
        e("div", {
          style: { display: "flex", gap: 20, flexWrap: "wrap", marginBottom: isRunning ? 12 : 0 },
        },
          ...[
            ["Total active users", status.total_active],
            ["Generated",          status.generated],
            ["Pending",            status.pending],
          ].map(([label, val]) =>
            e("div", { key: label },
              e("div", { style: { fontSize: 20, fontWeight: 600, color: "var(--t1)", lineHeight: 1 } },
                val ?? "—"),
              e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 3 } }, label)
            )
          )
        ),

        isRunning && e("div", null,
          e("div", {
            style: {
              height: 4, borderRadius: 2, background: "var(--b1)",
              overflow: "hidden",
            },
          },
            e("div", {
              style: {
                height: "100%", borderRadius: 2,
                background: "var(--ac)",
                width: `${progressPct}%`,
                transition: "width 0.4s ease",
              },
            })
          ),
          e("div", {
            style: { fontSize: 11, color: "var(--t4)", marginTop: 5 },
          }, `${progressPct}% complete — generating…`)
        )
      ),

      // Action buttons
      e("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 } },

        // Generate all users
        e("button", {
          onClick:  generateAll,
          disabled: genLoading || isRunning,
          style: {
            fontSize: 13, padding: "8px 18px", borderRadius: 8, fontFamily: "inherit",
            fontWeight: 500, cursor: (genLoading || isRunning) ? "default" : "pointer",
            opacity: (genLoading || isRunning) ? 0.6 : 1,
            background: "var(--ac)", border: "none", color: "var(--ac-on)",
          },
        },
          e("i", { className: `fa-solid fa-wand-magic-sparkles`, style: { marginRight: 7, fontSize: 12 } }),
          genLoading ? "Enqueueing…" : isRunning ? "Running…" : "Generate all users"
        ),

        // Simulate for me
        e("button", {
          onClick:  simulate,
          disabled: simLoading,
          style: {
            fontSize: 13, padding: "8px 18px", borderRadius: 8, fontFamily: "inherit",
            fontWeight: 500, cursor: simLoading ? "default" : "pointer",
            opacity: simLoading ? 0.6 : 1,
            background: "rgba(96,165,250,0.1)",
            border: "0.5px solid rgba(96,165,250,0.35)",
            color: "#60a5fa",
          },
        },
          e("i", { className: "fa-solid fa-flask", style: { marginRight: 7, fontSize: 12 } }),
          simLoading ? "Simulating…" : "Simulate for me"
        ),

        // Refresh status
        e("button", {
          onClick:  loadStatus,
          disabled: statusLoading,
          style: {
            fontSize: 13, padding: "8px 14px", borderRadius: 8, fontFamily: "inherit",
            cursor: statusLoading ? "default" : "pointer",
            opacity: statusLoading ? 0.5 : 1,
            background: "none",
            border: "0.5px solid var(--b1)",
            color: "var(--t4)",
          },
        },
          e("i", {
            className: `fa-solid fa-rotate${statusLoading ? " fa-spin" : ""}`,
            style: { fontSize: 12 },
          })
        )
      ),

      // Success message
      genResult && e("div", {
        style: {
          fontSize: 13, color: "var(--green)", marginBottom: 10,
          display: "flex", alignItems: "center", gap: 7,
        },
      },
        e("i", { className: "fa-solid fa-circle-check", style: { fontSize: 13 } }),
        `Enqueued ${genResult.enqueued} generation jobs for ${genResult.year}`
      ),

      // Error messages
      genError && e("div", {
        style: { fontSize: 13, color: "var(--red)", marginBottom: 10 },
      }, genError),

      simError && e("div", {
        style: { fontSize: 13, color: "var(--red)", marginBottom: 10 },
      }, simError),

      // Explanation
      e("div", {
        style: {
          fontSize: 12, color: "var(--t5)", lineHeight: 1.7,
          borderTop: "0.5px solid var(--b1)", paddingTop: 16, marginTop: 8,
        },
      },
        e("strong", { style: { color: "var(--t4)" } }, "Generate all users"),
        " enqueues one background job per active user for the selected year. " +
        "Jobs run via Oban — progress updates every few seconds.",
        e("br"),
        e("strong", { style: { color: "var(--t4)" } }, "Simulate for me"),
        " runs the full generation pipeline for your account synchronously and " +
        "opens your Wrapped immediately so you can preview the result."
      )
    );
  }

  // ── Admin panel root ──────────────────────────────────────────────────────
  // Renders a tab shell matching TabbedPanel's visual style exactly.
  // Generation tab: custom JSX above.
  // Other tabs: SimpleSettingsPanel scoped to their field lists.

  const ADMIN_TABS = [
    { key: "generation",    label: "Generation",    icon: "fa-wand-magic-sparkles" },
    { key: "visibility",    label: "Visibility",    icon: "fa-eye"        },
    { key: "content",       label: "Content",       icon: "fa-layer-group"},
    { key: "notifications", label: "Notifications", icon: "fa-bell"       },
  ];

  const TAB_FIELDS = {
    visibility: [
      { key: "enabled",             label: "Enable Wrapped",             type: "boolean" },
      { key: "sharing_default",     label: "Share by default",           type: "boolean" },
      { key: "min_posts_threshold", label: "Minimum posts to qualify",   type: "number"  },
    ],
    content: [
      { key: "forum_name_override",  label: "Forum name override",        type: "string"  },
      { key: "show_gamepedia_slide", label: "Show Gamepedia slide",       type: "boolean" },
      { key: "show_dms_slide",       label: "Show DMs slide",             type: "boolean" },
    ],
    notifications: [
      { key: "send_notification_email", label: "Send notification email when ready", type: "boolean" },
    ],
  };

  // Tab button style — underline style matching all Nexus admin panels in the screenshots:
  // active tab gets accent color text + 2px accent bottom border, inactive gets muted text
  function tabBtnStyle(active) {
    return {
      display: "flex", alignItems: "center", gap: 7,
      padding: "10px 18px",
      background: "none", border: "none",
      borderBottom: active ? "2px solid var(--ac)" : "2px solid transparent",
      color:        active ? "var(--ac-text)"      : "var(--t4)",
      fontWeight:   active ? 500 : 400,
      cursor: "pointer", fontFamily: "inherit",
      fontSize: 13, marginBottom: -1,
      transition: "color .1s",
      whiteSpace: "nowrap",
    };
  }

  function WrappedAdminPanel() {
    const [activeTab, setActiveTab] = useState("generation");

    return e("div", null,
      // Tab bar
      e("div", {
        style: {
          display: "flex", gap: 0, marginBottom: 24,
          borderBottom: "0.5px solid var(--b1)",
          overflowX: "auto", WebkitOverflowScrolling: "touch",
        },
      },
        ...ADMIN_TABS.map(t =>
          e("button", {
            key:     t.key,
            onClick: () => setActiveTab(t.key),
            style:   tabBtnStyle(activeTab === t.key),
          },
            e("i", { className: `fa-solid ${t.icon}`, style: { fontSize: 11 } }),
            t.label
          )
        )
      ),

      // Tab content
      activeTab === "generation" && e(GenerationTab),

      activeTab !== "generation" && TAB_FIELDS[activeTab] && e(NET.SimpleSettingsPanel, {
        slug:   "wrapped",
        fields: TAB_FIELDS[activeTab],
      })
    );
  }

  // =========================================================================
  // PROFILE TAB — "Wrapped" tab on user profiles
  // =========================================================================
  // Receives: { username, currentUser, navigate, userId, user_id }
  // Shows year cards with headline stats + link to full slide experience.

  function WrappedProfileTab({ username, currentUser, navigate }) {
    const [entries, setEntries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState(null);

    const isOwn = currentUser && currentUser.username === username;

    useEffect(() => {
      setLoading(true); setError(null); setEntries(null);

      // Own profile: GET /ext/wrapped/api/ returns all years for the current user.
      // Visitor profile: enumerate the last 5 years and collect whichever are shared.
      if (isOwn) {
        apiFetch("/")
          .then(d => {
            if (d.data) setEntries(d.data);
            else setError(d.error || "Failed to load");
          })
          .catch(() => setError("Network error"))
          .finally(() => setLoading(false));
      } else {
        // Visitor: try last 5 years and collect whichever are shared
        const thisYear = new Date().getFullYear();
        const years    = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3, thisYear - 4];
        Promise.all(
          years.map(yr =>
            apiFetch(`/${yr}/${encodeURIComponent(username)}`)
              .then(d => d.data || null)
              .catch(() => null)
          )
        ).then(results => {
          const valid = results.filter(Boolean).filter(r => r.is_shared);
          setEntries(valid.map(r => ({
            year:      r.year,
            is_shared: true,
            summary:   summarise(r.current),
          })));
        }).finally(() => setLoading(false));
      }
    }, [username, isOwn]);

    if (loading) return e("div", {
      style: { padding: "48px 0", textAlign: "center", color: "var(--t5)" },
    }, "Loading…");

    if (error) return e("div", {
      style: { padding: "48px 0", textAlign: "center", color: "var(--t5)", fontSize: 13 },
    }, error);

    if (!entries || entries.length === 0) return e("div", {
      style: { padding: "48px 0", textAlign: "center", color: "var(--t5)", fontSize: 13 },
    },
      e("i", {
        className: "fa-solid fa-wand-sparkles",
        style: { fontSize: 28, opacity: 0.3, marginBottom: 12, display: "block" },
      }),
      isOwn
        ? "No Wrapped generated yet — check back after the year ends."
        : `${username} hasn't shared any Wrapped.`
    );

    return e("div", { style: { display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 } },
      ...entries.map(entry => e(WrappedYearCard, {
        key:         entry.year,
        entry,
        isOwn,
        navigate,
        username,
      }))
    );
  }

  function summarise(data) {
    if (!data) return {};
    return {
      posts_count:    data.posts_count    || 0,
      active_days:    data.active_days    || 0,
      longest_streak: data.longest_streak || 0,
      milestones:     data.milestones     || [],
      reactions_received_total: data.reactions_received_total || 0,
      badges_earned_count:      data.badges_earned_count      || 0,
    };
  }

  function WrappedYearCard({ entry, isOwn, navigate, username }) {
    const [shareLoading, setShareLoading] = useState(false);
    const [isShared,     setIsShared]     = useState(entry.is_shared || false);

    const s = entry.summary || {};

    const toggleShare = () => {
      setShareLoading(true);
      apiFetch(`/${entry.year}/share`, { method: "PATCH" })
        .then(d => { if (d.data) setIsShared(d.data.shared); })
        .catch(() => {})
        .finally(() => setShareLoading(false));
    };

    return e("div", {
      style: {
        background: "var(--s3)", border: "0.5px solid var(--b1)",
        borderRadius: 12, padding: 20,
      },
    },
      // Header row
      e("div", {
        style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 14 },
      },
        e("div", {
          style: {
            fontSize: 22, fontWeight: 700, color: "var(--t1)",
            letterSpacing: -0.5, lineHeight: 1,
          },
        }, entry.year),

        !isOwn && isShared && e("div", {
          style: {
            fontSize: 10, padding: "2px 8px", borderRadius: 20,
            background: "rgba(52,211,153,0.1)", border: "0.5px solid rgba(52,211,153,0.25)",
            color: "#34d399",
          },
        }, "shared"),

        e("div", { style: { marginLeft: "auto" } },
          e("button", {
            onClick: () => navToWrapped(entry.year, username),
            style: {
              fontSize: 12, padding: "6px 14px", borderRadius: 8,
              background: "var(--ac)", border: "none", color: "var(--ac-on)",
              cursor: "pointer", fontFamily: "inherit", fontWeight: 500,
            },
          }, `View ${entry.year} Wrapped`)
        )
      ),

      // Headline stats
      e("div", {
        style: { display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 },
      },
        ...[
          ["fa-pen-to-square", s.posts_count,    "posts"      ],
          ["fa-calendar-days", s.active_days,     "active days"],
          ["fa-fire",          s.longest_streak,  "day streak" ],
          ["fa-heart",         s.reactions_received_total, "reactions"],
        ].map(([icon, val, label]) =>
          e("div", { key: label, style: { display: "flex", flexDirection: "column", gap: 2 } },
            e("div", {
              style: { fontSize: 18, fontWeight: 600, color: "var(--t1)", lineHeight: 1 },
            }, val ?? 0),
            e("div", {
              style: { fontSize: 11, color: "var(--t5)", display: "flex", alignItems: "center", gap: 4 },
            },
              e("i", { className: `fa-solid ${icon}`, style: { fontSize: 10 } }),
              label
            )
          )
        )
      ),

      // Milestone pills
      s.milestones && s.milestones.length > 0 && e("div", {
        style: { display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 14 },
      },
        ...s.milestones.map(m =>
          e("div", {
            key: m,
            style: {
              fontSize: 10, padding: "3px 9px", borderRadius: 20,
              background: "rgba(167,139,250,0.1)",
              border: "0.5px solid rgba(167,139,250,0.25)",
              color: "#c4b5fd",
            },
          }, m.replace(/_/g, " "))
        )
      ),

      // Share toggle (own profile only)
      isOwn && e("div", {
        style: {
          borderTop: "0.5px solid var(--b1)", paddingTop: 12, marginTop: 4,
          display: "flex", alignItems: "center", gap: 8,
        },
      },
        e("span", { style: { fontSize: 12, color: "var(--t5)" } },
          isShared ? "Shared publicly" : "Private"
        ),
        e("button", {
          onClick:  toggleShare,
          disabled: shareLoading,
          style: {
            fontSize: 11, padding: "3px 10px", borderRadius: 20,
            background: isShared ? "rgba(248,113,113,0.1)" : "rgba(52,211,153,0.1)",
            border: isShared ? "0.5px solid rgba(248,113,113,0.3)" : "0.5px solid rgba(52,211,153,0.3)",
            color: isShared ? "var(--red)" : "#34d399",
            cursor: shareLoading ? "default" : "pointer",
            fontFamily: "inherit", opacity: shareLoading ? 0.5 : 1,
          },
        }, shareLoading ? "…" : isShared ? "Make private" : "Share")
      )
    );
  }

  // =========================================================================
  // FULL-SCREEN WRAPPED ROUTE
  // =========================================================================
  // Registered at /wrapped/:year/:username
  // Placeholder — the full slide deck is built in Phase 3.
  // For now it renders a loading→data state so the backend can be verified.

  function WrappedPage({ year, username, currentUser, navigate }) {
    const [state, setState] = useState({ status: "loading" });

    useEffect(() => {
      apiFetch(`/${year}/${encodeURIComponent(username)}`)
        .then(d => {
          if (d.data) setState({ status: "ready", data: d.data });
          else setState({ status: "error", code: d.error || "unknown" });
        })
        .catch(() => setState({ status: "error", code: "network_error" }));
    }, [year, username]);

    const containerStyle = {
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: 24, background: "var(--bg)",
    };

    if (state.status === "loading") return e("div", { style: containerStyle },
      e("i", { className: "fa-solid fa-spinner fa-spin", style: { fontSize: 24, color: "var(--ac)" } })
    );

    if (state.status === "error") {
      const messages = {
        not_generated: "Wrapped hasn't been generated yet.",
        private:       "This Wrapped is private.",
        network_error: "Could not load Wrapped. Check your connection.",
      };
      return e("div", { style: { ...containerStyle, gap: 12 } },
        e("i", { className: "fa-solid fa-triangle-exclamation", style: { fontSize: 28, color: "var(--amber)" } }),
        e("div", { style: { fontSize: 15, color: "var(--t2)" } },
          messages[state.code] || "Something went wrong."
        ),
        e("button", {
          onClick: () => navigate("profile", { username }),
          style: {
            fontSize: 13, padding: "7px 18px", borderRadius: 8,
            background: "none", border: "0.5px solid var(--b1)",
            color: "var(--t4)", cursor: "pointer", fontFamily: "inherit", marginTop: 8,
          },
        }, `Back to ${username}'s profile`)
      );
    }

    // Phase 3 will replace this with the full slide deck.
    // For now render the raw data so the backend can be verified.
    const { data } = state;
    return e("div", {
      style: {
        maxWidth: 640, margin: "0 auto", padding: 24,
        background: "var(--bg)", minHeight: "100vh",
      },
    },
      e("div", { style: { fontSize: 22, fontWeight: 700, color: "var(--t1)", marginBottom: 6 } },
        `${username}'s ${data.year} Wrapped`),
      e("div", { style: { fontSize: 13, color: "var(--t5)", marginBottom: 24 } },
        "Slide deck coming in Phase 3 — backend data preview:"),
      e("pre", {
        style: {
          fontSize: 11, color: "var(--t3)", background: "var(--s2)",
          border: "0.5px solid var(--b1)", borderRadius: 8, padding: 16,
          overflowX: "auto", whiteSpace: "pre-wrap",
        },
      }, JSON.stringify(data.current, null, 2))
    );
  }

  // =========================================================================
  // REGISTRATIONS
  // =========================================================================

  // ── Route ─────────────────────────────────────────────────────────────────
  NE.registerRoute("/wrapped/:year/:username", WrappedPage, { title: "Wrapped" });

  // ── Profile tab ───────────────────────────────────────────────────────────
  WrappedProfileTab.tabId    = "wrapped";
  WrappedProfileTab.tabLabel = "Wrapped";
  NE.registerSlot("profile_tab", WrappedProfileTab, 50);

  // ── Account action ────────────────────────────────────────────────────────
  // "View My Wrapped" in the account dropdown — navigates to own profile Wrapped tab
  NE.registerAccountAction({
    id:    "wrapped-my-wrapped",
    label: "My Wrapped",
    icon:  "fa-wand-sparkles",
    priority: 80,
    onClick({ currentUser, navigate, close }) {
      close();
      navigate("profile", { username: currentUser.username, tab: "wrapped" });
    },
  });

  // ── User action ───────────────────────────────────────────────────────────
  // "View Wrapped" on another user's card popover — only if they've shared
  NE.registerUserAction({
    id:       "wrapped-view",
    label:    "View Wrapped",
    icon:     "fa-wand-sparkles",
    priority: 80,
    authOnly: false,
    onClick({ user, navigate, closeCard }) {
      closeCard();
      navigate("profile", { username: user.username, tab: "wrapped" });
    },
  });

  // ── Explore item ──────────────────────────────────────────────────────────
  // Appears in the left sidebar Explore section and the Layout admin drag list
  NE.registerExploreItem({
    id:       "wrapped",
    label:    "Wrapped",
    icon:     "fa-wand-sparkles",
    page:     "ext-route",
    props:    NE.matchRoute(`/wrapped/${new Date().getFullYear()}/${
      (() => { try { return JSON.parse(localStorage.getItem("nexus_user") || "{}").username || ""; } catch(_) { return ""; } })()
    }`) || {},
    authOnly: true,
    priority: 60,
  });

  // ── Notification type ─────────────────────────────────────────────────────
  // Registered as "wrapped_ready" — this matches n.data.ext_type for renderBody.
  // The notification icon and body text are shown in the notifications panel.
  // Clicking marks it read; the user navigates to their Wrapped via the profile tab.
  NE.registerNotificationType("wrapped_ready", {
    icon:      "fa-wand-sparkles",
    iconColor: "var(--ac)",
    renderBody(n) {
      const year = n.data && n.data.year ? n.data.year : new Date().getFullYear();
      return React.createElement(React.Fragment, null,
        React.createElement("span", { style: { color: "var(--t2)", fontWeight: 500 } },
          `Your ${year} Wrapped is ready`),
        React.createElement("span", { style: { color: "var(--t4)" } },
          " — see your year in review")
      );
    },
    // No onClick: the notification click marks it read. The user opens Wrapped
    // via the profile tab or the Explore sidebar item.
  });

  // ── Admin panel ───────────────────────────────────────────────────────────
  NE.registerAdminPanel("wrapped", {
    label:     "Wrapped",
    icon:      "fa-wand-sparkles",
    component: WrappedAdminPanel,
  });

})();
