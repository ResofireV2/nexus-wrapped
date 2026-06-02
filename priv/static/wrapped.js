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

  // ── Timezone list (mirrors Nexus Digest) ─────────────────────────────────
  const TIMEZONES = [
    { group: "UTC",          zones: ["UTC"] },
    { group: "Americas",     zones: ["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Anchorage","America/Halifax","America/Toronto","America/Vancouver","America/Sao_Paulo","America/Argentina/Buenos_Aires","America/Bogota","America/Lima","America/Mexico_City"] },
    { group: "Europe",       zones: ["Europe/London","Europe/Dublin","Europe/Paris","Europe/Berlin","Europe/Madrid","Europe/Rome","Europe/Amsterdam","Europe/Brussels","Europe/Zurich","Europe/Stockholm","Europe/Oslo","Europe/Helsinki","Europe/Warsaw","Europe/Prague","Europe/Budapest","Europe/Bucharest","Europe/Athens","Europe/Moscow"] },
    { group: "Asia/Pacific", zones: ["Asia/Dubai","Asia/Karachi","Asia/Kolkata","Asia/Dhaka","Asia/Bangkok","Asia/Singapore","Asia/Shanghai","Asia/Tokyo","Asia/Seoul","Australia/Sydney","Australia/Melbourne","Pacific/Auckland","Pacific/Honolulu"] },
    { group: "Africa",       zones: ["Africa/Johannesburg","Africa/Lagos","Africa/Nairobi","Africa/Cairo"] },
  ];

  // Save arbitrary keys to the extension settings via the Nexus core API.
  // Returns true on success, false on failure.
  async function saveSettings(patch) {
    const token = localStorage.getItem("nexus_token");
    try {
      const res = await fetch("/api/v1/admin/extensions/wrapped/settings", {
        method:  "PATCH",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ settings: patch }),
      });
      const d = await res.json();
      return !!(d.extension);
    } catch {
      return false;
    }
  }

  // Load current extension settings from the Nexus core API.
  async function loadExtSettings() {
    const token = localStorage.getItem("nexus_token");
    try {
      const res = await fetch("/api/v1/admin/extensions/wrapped", {
        headers: { "Authorization": token ? `Bearer ${token}` : "" },
      });
      const d = await res.json();
      return d.extension?.settings || {};
    } catch {
      return {};
    }
  }
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
    NE.navigate(`/ext/wrapped/${year}/${username}`);
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
    const [status, setStatus]           = useState(null);
    const [statusLoading, setStatusLoading] = useState(false);
    const [genLoading, setGenLoading]   = useState(false);
    const [genResult, setGenResult]     = useState(null);
    const [genError, setGenError]       = useState(null);
    const [simLoading, setSimLoading]   = useState(false);
    const [simError, setSimError]       = useState(null);

    // Settings state — owned by this tab, not shared with siblings.
    // Each SimpleSettingsPanel sibling tab fetches and saves its own keys
    // independently; the server merges all patches so they don't clobber each other.
    const [settings, setSettings] = useState({});
    const [loaded,   setLoaded]   = useState(false);

    const setSetting = useCallback((key, val) => {
      setSettings(prev => ({ ...prev, [key]: val }));
      if (window._nexusAdminSetDirty) window._nexusAdminSetDirty();
    }, []);

    // Load settings on mount
    useEffect(() => {
      loadExtSettings().then(s => {
        setSettings(s);
        setLoaded(true);
      });
    }, []);

    // Register save fn with the topbar Save Changes button.
    // Re-registers on every settings change so save() closes over latest state.
    // Cleanup sets saveFn to null so switching to a SimpleSettingsPanel tab
    // lets that tab register its own save fn cleanly.
    useEffect(() => {
      if (!loaded) return;
      const save = async () => {
        const ok = await saveSettings(settings);
        return ok;
      };
      window._nexusAdminSaveFn = save;
      return () => {
        if (window._nexusAdminSaveFn === save) window._nexusAdminSaveFn = null;
      };
    }, [loaded, settings]);

    // Community post state
    const [spaces, setSpaces]               = useState([]);
    const [selectedSpace, setSelectedSpace] = useState("");
    const [communityStatus, setCommunityStatus] = useState(null);
    const [communityLoading, setCommunityLoading] = useState(false);
    const [communityError, setCommunityError]     = useState(null);
    const [communityResult, setCommunityResult]   = useState(null);

    const pollRef = useRef(null);

    const defaultMsg = [
      "What a year, [forum_name].",
      "",
      "In [year], [active_members] of you showed up, shared your thoughts, started conversations, and made this place what it is. You wrote [total_posts] posts, left [total_reactions] reactions, and welcomed [new_members] new members into the community.",
      "",
      "This is your year in review.",
    ].join("\n");

    const loadStatus = useCallback(() => {
      if (!year) return;
      setStatusLoading(true);
      apiFetch(`/admin/status/${year}`)
        .then(d => { if (d.data) setStatus(d.data); })
        .catch(() => {})
        .finally(() => setStatusLoading(false));
    }, [year]);

    useEffect(() => { loadStatus(); }, [year, loadStatus]);

    // Load spaces and community status on mount
    useEffect(() => {
      fetch("/api/v1/spaces", {
        headers: { "Authorization": `Bearer ${localStorage.getItem("nexus_token")}` }
      })
        .then(r => r.json())
        .then(d => { if (d.spaces) setSpaces(d.spaces); })
        .catch(() => {});
    }, []);

    useEffect(() => {
      if (!year) return;
      apiFetch(`/admin/community_status/${year}`)
        .then(d => { if (d.data) setCommunityStatus(d.data); })
        .catch(() => {});
    }, [year]);

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
      apiFetch("/admin/generate", { method: "POST", body: { year: Number(year) } })
        .then(d => {
          if (d.data) { setGenResult(d.data); loadStatus(); }
          else setGenError(d.error || "Failed to enqueue generation");
        })
        .catch(() => setGenError("Network error"))
        .finally(() => setGenLoading(false));
    };

    const simulate = () => {
      setSimLoading(true); setSimError(null);
      apiFetch("/admin/simulate", { method: "POST", body: { year: Number(year) } })
        .then(d => {
          if (d.data) { navToWrapped(d.data.year, d.data.username); }
          else setSimError(d.error || "Simulation failed");
        })
        .catch(() => setSimError("Network error"))
        .finally(() => setSimLoading(false));
    };

    const postCommunity = () => {
      if (!selectedSpace) { setCommunityError("Select a space first"); return; }
      setCommunityLoading(true); setCommunityError(null); setCommunityResult(null);
      apiFetch("/admin/community_post", {
        method: "POST",
        body:   { year: Number(year), space_id: Number(selectedSpace) },
      })
        .then(d => {
          if (d.data) {
            setCommunityResult(d.data);
            setCommunityStatus({ exists: true, post_id: d.data.post_id });
          } else {
            setCommunityError(d.error || "Failed to create post");
          }
        })
        .catch(() => setCommunityError("Network error"))
        .finally(() => setCommunityLoading(false));
    };

    const progressPct = status ? Math.min(100, status.pct_complete || 0) : 0;
    const isRunning   = status && status.pending > 0;

    const sectionStyle = {
      marginTop: 28, paddingTop: 24,
      borderTop: "0.5px solid var(--b1)",
    };

    const labelStyle = {
      fontSize: 11, fontWeight: 500, color: "var(--t5)",
      textTransform: "uppercase", letterSpacing: "0.7px", marginBottom: 6,
    };

    const DATAPOINTS = [
      { key: "[forum_name]",    desc: "Your forum's name" },
      { key: "[year]",          desc: "The year (e.g. 2026)" },
      { key: "[total_posts]",   desc: "Total posts written" },
      { key: "[total_replies]", desc: "Total replies posted" },
      { key: "[total_reactions]",desc: "Total reactions left" },
      { key: "[new_members]",   desc: "New members who joined" },
      { key: "[active_members]",desc: "Members who posted or replied" },
    ];

    return e("div", null,

      // ── Auto-generation schedule ────────────────────────────────────────
      e("div", { style: { marginBottom: 4 } },
        e("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--t2)", marginBottom: 4 } },
          "Auto-generation Schedule"
        ),
        e("div", { style: { fontSize: 12, color: "var(--t4)", marginBottom: 16, lineHeight: 1.6 } },
          "Wrapped will be automatically generated for all eligible members at the date and time you set. " +
          "The manual buttons below can be used to run it early or re-trigger if something goes wrong."
        ),

        // Widget hide date
        e("div", { style: { marginBottom: 16 } },
          e("div", { style: labelStyle }, "Hide community widget after (YYYY-MM-DD)"),
          e("input", {
            type: "date", className: "fi",
            value: settings.widget_hide_after || "",
            onChange: ev => setSetting("widget_hide_after", ev.target.value),
            style: { maxWidth: 220 },
          }),
          e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 4 } },
            "The sidebar widget disappears after this date. Leave blank to keep it visible indefinitely."
          )
        ),

        // Default community post space
        e("div", { style: { marginBottom: 20 } },
          e("div", { style: labelStyle }, "Community post space (default)"),
          e("select", {
            className: "fi",
            value: settings.community_post_space_id || "",
            onChange: ev => setSetting("community_post_space_id", ev.target.value ? Number(ev.target.value) : null),
            style: { maxWidth: 260 },
          },
            e("option", { value: "" }, "Select a space…"),
            ...spaces.map(s => e("option", { key: s.id, value: s.id }, s.name))
          ),
          e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 4 } },
            "Default space for the optional community post. Can be overridden below."
          )
        ),

        e("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" } },
          e("div", { style: { marginBottom: 16 } },
            e("div", { style: labelStyle }, "Date"),
            e("input", {
              type: "date", className: "fi",
              value: settings.auto_generate_date || "",
              onChange: ev => setSetting("auto_generate_date", ev.target.value),
              style: { width: "100%" },
            })
          ),
          e("div", { style: { marginBottom: 16 } },
            e("div", { style: labelStyle }, "Time"),
            e("input", {
              type: "time", className: "fi",
              value: settings.auto_generate_time || "09:00",
              onChange: ev => setSetting("auto_generate_time", ev.target.value),
              style: { width: "100%" },
            })
          ),
          e("div", { style: { marginBottom: 16, gridColumn: "1 / -1" } },
            e("div", { style: labelStyle }, "Timezone"),
            e("select", {
              className: "fi",
              value: settings.auto_generate_timezone || "UTC",
              onChange: ev => setSetting("auto_generate_timezone", ev.target.value),
              style: { width: "100%" },
            },
              ...TIMEZONES.map(g =>
                e("optgroup", { key: g.group, label: g.group },
                  ...g.zones.map(z =>
                    e("option", { key: z, value: z }, z.replace(/_/g, " "))
                  )
                )
              )
            )
          )
        )
      ),

      // ── Year selector ───────────────────────────────────────────────────
      e("div", { style: sectionStyle },
        e("div", { style: { marginBottom: 24 } },
          e("label", {
            style: { fontSize: 12, color: "var(--t4)", display: "block", marginBottom: 6, fontWeight: 500 },
          }, "Year"),
          e("input", {
            type: "number", className: "fi",
            value: year, onChange: ev => setYear(ev.target.value),
            style: { maxWidth: 120 },
            min: 2020, max: currentYear + 1,
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
                e("div", { style: { fontSize: 20, fontWeight: 600, color: "var(--t1)", lineHeight: 1 } }, val ?? "—"),
                e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 3 } }, label)
              )
            )
          ),
          isRunning && e("div", null,
            e("div", {
              style: { height: 4, borderRadius: 2, background: "var(--b1)", overflow: "hidden" },
            },
              e("div", {
                style: {
                  height: "100%", borderRadius: 2, background: "var(--ac)",
                  width: `${progressPct}%`, transition: "width 0.4s ease",
                },
              })
            ),
            e("div", { style: { fontSize: 11, color: "var(--t4)", marginTop: 5 } },
              `${progressPct}% complete — generating…`)
          )
        ),

        // Action buttons
        e("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 } },
          e("button", {
            onClick: generateAll, disabled: genLoading || isRunning,
            style: {
              fontSize: 13, padding: "8px 18px", borderRadius: 8, fontFamily: "inherit",
              fontWeight: 500, cursor: (genLoading || isRunning) ? "default" : "pointer",
              opacity: (genLoading || isRunning) ? 0.6 : 1,
              background: "var(--ac)", border: "none", color: "var(--ac-on)",
            },
          },
            e("i", { className: "fa-solid fa-wand-magic-sparkles", style: { marginRight: 7, fontSize: 12 } }),
            genLoading ? "Enqueueing…" : isRunning ? "Running…" : "Generate all users"
          ),
          e("button", {
            onClick: simulate, disabled: simLoading,
            style: {
              fontSize: 13, padding: "8px 18px", borderRadius: 8, fontFamily: "inherit",
              fontWeight: 500, cursor: simLoading ? "default" : "pointer",
              opacity: simLoading ? 0.6 : 1,
              background: "rgba(96,165,250,0.1)",
              border: "0.5px solid rgba(96,165,250,0.35)", color: "#60a5fa",
            },
          },
            e("i", { className: "fa-solid fa-flask", style: { marginRight: 7, fontSize: 12 } }),
            simLoading ? "Simulating…" : "Simulate for me"
          ),
          e("button", {
            onClick: loadStatus, disabled: statusLoading,
            style: {
              fontSize: 13, padding: "8px 14px", borderRadius: 8, fontFamily: "inherit",
              cursor: statusLoading ? "default" : "pointer",
              opacity: statusLoading ? 0.5 : 1,
              background: "none", border: "0.5px solid var(--b1)", color: "var(--t4)",
            },
          },
            e("i", { className: `fa-solid fa-rotate${statusLoading ? " fa-spin" : ""}`, style: { fontSize: 12 } })
          )
        ),

        genResult && e("div", {
          style: { fontSize: 13, color: "var(--green)", marginBottom: 10, display: "flex", alignItems: "center", gap: 7 },
        },
          e("i", { className: "fa-solid fa-circle-check", style: { fontSize: 13 } }),
          `Enqueued ${genResult.enqueued} generation jobs for ${genResult.year}`
        ),
        genError && e("div", { style: { fontSize: 13, color: "var(--red)", marginBottom: 10 } }, genError),
        simError && e("div", { style: { fontSize: 13, color: "var(--red)", marginBottom: 10 } }, simError)
      ),

      // ── Intro message editor ────────────────────────────────────────────
      e("div", { style: sectionStyle },
        e("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--t2)", marginBottom: 4 } },
          "Intro Message"
        ),
        e("div", { style: { fontSize: 12, color: "var(--t4)", marginBottom: 14, lineHeight: 1.6 } },
          "This message appears as the first slide of Community Wrapped and in the community post. " +
          "Leave blank to use the default. Available datapoints:"
        ),

        // Datapoint reference pills
        e("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 } },
          ...DATAPOINTS.map(dp =>
            e("div", {
              key: dp.key,
              title: dp.desc,
              style: {
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "3px 10px", borderRadius: 20, fontSize: 12,
                background: "rgba(167,139,250,0.1)",
                border: "0.5px solid rgba(167,139,250,0.3)",
                color: "var(--ac-text)", cursor: "default",
                fontFamily: "monospace",
              },
            }, dp.key)
          )
        ),

        // Textarea — uses settings.intro_message from shared state
        e("textarea", {
          className: "fi",
          value: settings.intro_message || "",
          onChange: ev => setSetting("intro_message", ev.target.value),
          placeholder: defaultMsg,
          rows: 8,
          style: {
            width: "100%", fontSize: 13, lineHeight: 1.65,
            resize: "vertical", fontFamily: "inherit",
          },
        }),

        e("div", { style: { marginTop: 8 } },
          e("button", {
            onClick: () => setSetting("intro_message", ""),
            style: {
              fontSize: 12, padding: "7px 14px", borderRadius: 8, fontFamily: "inherit",
              cursor: "pointer", background: "none",
              border: "0.5px solid var(--b1)", color: "var(--t4)",
            },
          }, "Reset to default")
        )
      ),

      // ── Community Wrapped post ──────────────────────────────────────────
      e("div", { style: sectionStyle },
        e("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--t2)", marginBottom: 4 } },
          "Community Wrapped Post"
        ),
        e("div", { style: { fontSize: 12, color: "var(--t4)", marginBottom: 16, lineHeight: 1.6 } },
          "Optional — creates a pinned forum post with a link to the Community Wrapped slideshow."
        ),

        communityStatus && communityStatus.exists && e("div", {
          style: { fontSize: 12, color: "var(--amber)", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 },
        },
          e("i", { className: "fa-solid fa-triangle-exclamation", style: { fontSize: 11 } }),
          `A community post already exists for ${year}. Posting again will create a new one.`
        ),

        e("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          e("select", {
            className: "fi",
            value: selectedSpace, onChange: ev => setSelectedSpace(ev.target.value),
            style: { maxWidth: 200, fontSize: 13 },
          },
            e("option", { value: "" }, "Select a space…"),
            ...spaces.map(s => e("option", { key: s.id, value: s.id }, s.name))
          ),
          e("button", {
            onClick: postCommunity, disabled: communityLoading || !selectedSpace,
            style: {
              fontSize: 13, padding: "8px 18px", borderRadius: 8, fontFamily: "inherit",
              fontWeight: 500,
              cursor: (communityLoading || !selectedSpace) ? "default" : "pointer",
              opacity: (communityLoading || !selectedSpace) ? 0.6 : 1,
              background: "rgba(52,211,153,0.1)",
              border: "0.5px solid rgba(52,211,153,0.35)", color: "var(--green)",
            },
          },
            e("i", { className: "fa-solid fa-paper-plane", style: { marginRight: 7, fontSize: 12 } }),
            communityLoading ? "Posting…" : "Post Community Wrapped"
          )
        ),

        communityResult && e("div", {
          style: { fontSize: 13, color: "var(--green)", marginTop: 10, display: "flex", alignItems: "center", gap: 7 },
        },
          e("i", { className: "fa-solid fa-circle-check", style: { fontSize: 13 } }),
          "Posted! ",
          e("a", {
            href: `/posts/${communityResult.post_id}`,
            style: { color: "var(--ac-text)", textDecoration: "none" },
            onClick: ev => {
              ev.preventDefault();
              NE.navigate(`/post/${communityResult.post_id}`);
            },
          }, "View post →")
        ),
        communityError && e("div", { style: { fontSize: 13, color: "var(--red)", marginTop: 10 } }, communityError)
      ),

      // Explanation footer
      e("div", {
        style: {
          fontSize: 12, color: "var(--t5)", lineHeight: 1.7,
          borderTop: "0.5px solid var(--b1)", paddingTop: 16, marginTop: 24,
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

  // =========================================================================
  // PROFILE TAB — "Wrapped" tab on user profiles
  // =========================================================================
  // Receives: { username, currentUser, navigate, userId, user_id }
  // Shows year cards with headline stats + link to full slide experience.

  function WrappedProfileTab({ username, current_user }) {
    const [entries, setEntries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState(null);

    const isOwn = current_user && current_user.username === username;

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

  function WrappedYearCard({ entry, isOwn, username }) {
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
  // WRAPPED ANIMATIONS — injected once into document head
  // =========================================================================

  (function injectWrappedStyles() {
    if (document.getElementById("wrapped-keyframes")) return;
    const s = document.createElement("style");
    s.id = "wrapped-keyframes";
    s.textContent = `
      @keyframes wr-fade-up {
        from { opacity: 0; transform: translateY(28px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes wr-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes wr-count-pop {
        0%   { opacity: 0; transform: scale(0.6); }
        70%  { transform: scale(1.06); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes wr-bar-grow {
        from { transform: scaleX(0); }
        to   { transform: scaleX(1); }
      }
      @keyframes wr-confetti-fall {
        0%   { transform: translateY(-20px) rotate(0deg);   opacity: 0; }
        15%  { opacity: 1; }
        100% { transform: translateY(60px) rotate(360deg);  opacity: 0; }
      }
      @keyframes wr-pill-pop {
        0%   { opacity: 0; transform: scale(0.7) translateY(8px); }
        80%  { transform: scale(1.04) translateY(0); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes wr-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.55; }
      }
      @keyframes wr-slide-in-right {
        from { opacity: 0; transform: translateX(40px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes wr-rank-drop {
        0%   { opacity: 0; transform: translateY(-40px) scale(0.8); }
        60%  { transform: translateY(6px) scale(1.05); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes wr-shimmer {
        0%   { opacity: 0.7; }
        50%  { opacity: 1; }
        100% { opacity: 0.7; }
      }
      .wr-fade-up   { animation: wr-fade-up 0.55s cubic-bezier(.22,.68,0,1.2) both; }
      .wr-fade-in   { animation: wr-fade-in 0.4s ease both; }
      .wr-count-pop { animation: wr-count-pop 0.6s cubic-bezier(.22,.68,0,1.2) both; }
      .wr-pill-pop  { animation: wr-pill-pop 0.45s cubic-bezier(.22,.68,0,1.2) both; }
      .wr-rank-drop { animation: wr-rank-drop 0.7s cubic-bezier(.22,.68,0,1.2) both; }
      .wr-slide-r   { animation: wr-slide-in-right 0.5s cubic-bezier(.22,.68,0,1.2) both; }
    `;
    document.head.appendChild(s);
  })();

  // =========================================================================
  // FULL-SCREEN WRAPPED ROUTE — 7-slide animated deck
  // =========================================================================

  // ── Confetti burst component ──────────────────────────────────────────────
  function ConfettiBurst({ active }) {
    const PIECES = 18;
    const COLORS = ["var(--ac)", "var(--pink)", "var(--green)", "var(--blue)", "var(--amber)"];
    if (!active) return null;
    return e("div", {
      style: {
        position: "absolute", top: 0, left: 0, right: 0,
        height: 120, overflow: "hidden", pointerEvents: "none", zIndex: 0,
      },
    },
      ...Array.from({ length: PIECES }, (_, i) => {
        const left  = 5 + (i / PIECES) * 90;
        const delay = (i * 0.07).toFixed(2);
        const dur   = (0.9 + Math.random() * 0.6).toFixed(2);
        const color = COLORS[i % COLORS.length];
        const size  = 4 + (i % 4);
        return e("div", {
          key: i,
          style: {
            position: "absolute",
            left: `${left}%`,
            top: `-${size}px`,
            width: size,
            height: size * 2.5,
            borderRadius: 2,
            background: color,
            animation: `wr-confetti-fall ${dur}s ${delay}s ease-in both`,
            transform: `rotate(${(i * 37) % 180}deg)`,
          },
        });
      })
    );
  }

  // ── Animated counter ──────────────────────────────────────────────────────
  function AnimCounter({ target, duration = 1200, delay = 0 }) {
    const [val, setVal] = useState(0);
    useEffect(() => {
      let start = null;
      let raf;
      const tick = (ts) => {
        if (!start) start = ts + delay;
        const elapsed = Math.max(0, ts - start);
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setVal(Math.round(eased * target));
        if (progress < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [target, duration, delay]);
    return e(React.Fragment, null, val.toLocaleString());
  }

  // ── Animated bar ──────────────────────────────────────────────────────────
  function AnimBar({ pct, color, delay = 0 }) {
    const [width, setWidth] = useState(0);
    useEffect(() => {
      const t = setTimeout(() => setWidth(pct), delay + 80);
      return () => clearTimeout(t);
    }, [pct, delay]);
    return e("div", {
      style: {
        height: "100%", borderRadius: 3,
        background: color,
        width: `${width}%`,
        transition: `width 0.8s cubic-bezier(.22,.68,0,1.2) ${delay}ms`,
      },
    });
  }

  // ── Slide shell ───────────────────────────────────────────────────────────
  function Slide({ children, style = {} }) {
    const isMobile = typeof window !== "undefined" &&
      window.matchMedia("(max-width:767.99px)").matches;

    const paddingBottom = isMobile
      ? "calc(54px + env(safe-area-inset-bottom) + 24px)"
      : "80px";

    return e("div", {
      style: {
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        paddingTop: "60px",
        paddingBottom,
        paddingLeft: "32px",
        paddingRight: "32px",
        textAlign: "center",
        background: "var(--bg)",
        overflow: "hidden",
        ...style,
      },
    }, children);
  }

  // ── DOW / hour label helpers ──────────────────────────────────────────────
  const DOW_LABELS  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const HOUR_LABELS = (h) => {
    if (h === 0)  return "midnight";
    if (h < 12)   return `${h}am`;
    if (h === 12) return "noon";
    return `${h - 12}pm`;
  };

  // ── Slide 0: Opening ──────────────────────────────────────────────────────
  function SlideOpening({ d, username, year, currentUser }) {
    const avatarUrl   = currentUser?.avatar_url;
    const avatarColor = currentUser?.avatar_color || "var(--ac)";
    const initials    = username ? username.slice(0, 2).toUpperCase() : "??";

    return e(Slide, null,
      e(ConfettiBurst, { active: true }),
      e("div", { className: "wr-count-pop", style: { animationDelay: "0.05s", marginBottom: 16 } },
        e("div", {
          style: {
            width: 96, height: 96, borderRadius: "50%",
            border: "3px solid var(--ac)",
            overflow: "hidden", background: avatarColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          },
        },
          avatarUrl
            ? e("img", { src: avatarUrl, alt: username, style: { width: "100%", height: "100%", objectFit: "cover" } })
            : e("span", { style: { fontSize: 32, fontWeight: 600, color: "var(--ac-on)" } }, initials)
        )
      ),
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 16, textTransform: "uppercase", animationDelay: "0.15s" } },
        `${username} · ${year}`
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 80, fontWeight: 700, color: "var(--ac)", lineHeight: 1, letterSpacing: -3, animationDelay: "0.2s" } },
        e(AnimCounter, { target: d.posts_count || 0, duration: 1400, delay: 300 })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 20, color: "var(--t2)", marginTop: 14, animationDelay: "0.4s" } },
        "posts written this year"
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 13, color: "var(--t4)", marginTop: 8, animationDelay: "0.55s" } },
        `plus ${(d.replies_count || 0).toLocaleString()} replies`
      ),
      e("div", {
        className: "wr-fade-up",
        style: { display: "flex", gap: 24, marginTop: 36, animationDelay: "0.7s" },
      },
        ...[
          ["var(--pink)",  (d.reactions_received_total || 0).toLocaleString(), "reactions received"],
          ["var(--green)", (d.reactions_given || 0).toLocaleString(), "reactions given"],
          ["var(--blue)",  (d.active_days || 0).toLocaleString(), "active days"],
        ].map(([color, val, label]) =>
          e("div", { key: label, style: { textAlign: "center" } },
            e("div", { style: { fontSize: 28, fontWeight: 600, color, lineHeight: 1 } }, val),
            e("div", { style: { fontSize: 11, color: "var(--t4)", marginTop: 5 } }, label)
          )
        )
      )
    );
  }

  // ── Slide 1: Consistency ──────────────────────────────────────────────────
  function SlideConsistency({ d }) {
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthly = d.posts_per_month || Array(12).fill(0);
    const maxVal  = Math.max(...monthly, 1);
    const peakIdx = monthly.indexOf(Math.max(...monthly));
    const COLORS  = ["var(--ac)","var(--pink)","var(--green)","var(--blue)","var(--amber)","var(--ac)","var(--pink)","var(--green)","var(--blue)","var(--amber)","var(--ac)","var(--pink)"];

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "consistency"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 80, fontWeight: 700, color: "var(--amber)", lineHeight: 1, letterSpacing: -3, animationDelay: "0.1s" } },
        e(AnimCounter, { target: d.longest_streak || 0, duration: 1200, delay: 200 })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 20, color: "var(--t2)", marginTop: 14, animationDelay: "0.3s" } },
        "day longest streak"
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 13, color: "var(--t4)", marginTop: 8, animationDelay: "0.4s" } },
        `active ${d.active_days || 0} days · biggest month was ${MONTHS[peakIdx]}`
      ),
      e("div", {
        className: "wr-fade-up",
        style: {
          display: "flex", alignItems: "flex-end", gap: 6,
          marginTop: 40, width: "100%", maxWidth: 480,
          animationDelay: "0.5s",
        },
      },
        ...monthly.map((val, i) => {
          const h = Math.max(4, Math.round((val / maxVal) * 80));
          const isPeak = i === peakIdx;
          return e("div", {
            key: i,
            style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 },
          },
            val > 0 && e("div", {
              style: {
                fontSize: 10, color: isPeak ? COLORS[i] : "var(--t5)",
                fontWeight: isPeak ? 600 : 400,
                lineHeight: 1,
              }
            }, val),
            e("div", {
              style: {
                width: "100%", background: COLORS[i],
                borderRadius: "3px 3px 0 0",
                opacity: val === 0 ? 0.2 : 1,
                height: 0,
                transition: `height 0.6s cubic-bezier(.22,.68,0,1.2) ${i * 50}ms`,
              },
              ref: (el) => {
                if (el) setTimeout(() => { el.style.height = h + "px"; }, 100 + i * 50);
              },
            }),
            e("div", { style: { fontSize: 11, color: "var(--t4)", marginTop: 3, fontWeight: isPeak ? 600 : 400 } },
              MONTHS[i].slice(0, 1)
            )
          );
        })
      )
    );
  }

  // ── Slide 2: Personality ──────────────────────────────────────────────────
  function SlidePersonality({ d }) {
    const hour    = d.most_active_hour || 0;
    const dow     = d.most_active_dow  || 0;
    const isOwl   = (d.night_owl_score   || 0) >= 40;
    const isBird  = (d.early_bird_score  || 0) >= 40;
    const isWknd  = (d.weekend_score     || 0) >= 50;
    const persona = isOwl ? "Night owl" : isBird ? "Early bird" : isWknd ? "Weekend warrior" : "All-day poster";
    const personaIcon = isOwl ? "fa-moon" : isBird ? "fa-sun" : isWknd ? "fa-umbrella-beach" : "fa-fire";

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "your style"
      ),
      e("div", { className: "wr-count-pop", style: { animationDelay: "0.1s" } },
        e("i", { className: `fa-solid ${personaIcon}`, style: { fontSize: 56, color: "var(--ac)" } })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 32, fontWeight: 700, color: "var(--t1)", marginTop: 16, animationDelay: "0.25s" } },
        persona
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t3)", marginTop: 10, animationDelay: "0.35s" } },
        `You post most at ${HOUR_LABELS(hour)} on ${DOW_LABELS[dow]}s`
      ),
      e("div", {
        className: "wr-fade-up",
        style: { display: "flex", gap: 10, marginTop: 36, flexWrap: "wrap", justifyContent: "center", animationDelay: "0.5s" },
      },
        ...([
          isOwl  && ["fa-moon",           "var(--blue)",  "Night owl"],
          isBird && ["fa-sun",            "var(--amber)", "Early bird"],
          isWknd && ["fa-umbrella-beach", "var(--green)", "Weekend warrior"],
          (d.saves_count || 0) >= 20      && ["fa-bookmark", "var(--pink)",  "Collector"],
          (d.reactions_given || 0) >= 100 && ["fa-heart",    "var(--pink)",  "Generous"],
        ].filter(Boolean)).map(([icon, color, label], i) =>
          e("div", {
            key: label,
            className: "wr-pill-pop",
            style: {
              display: "flex", alignItems: "center", gap: 7,
              padding: "8px 16px", borderRadius: 20,
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              color: "var(--t2)", fontSize: 13,
              animationDelay: `${0.55 + i * 0.08}s`,
            },
          },
            e("i", { className: `fa-solid ${icon}`, style: { color, fontSize: 13 } }),
            label
          )
        )
      )
    );
  }

  // ── Slide 3: Reactions ────────────────────────────────────────────────────
  function SlideReactions({ d }) {
    const breakdown = (d.reactions_received_breakdown || []).slice(0, 5);
    const total     = d.reactions_received_total || 0;
    const topReactor = d.top_reactor;

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "the love you got"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 80, fontWeight: 700, color: "var(--pink)", lineHeight: 1, letterSpacing: -3, animationDelay: "0.1s" } },
        e(AnimCounter, { target: total, duration: 1200, delay: 200 })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 20, color: "var(--t2)", marginTop: 14, animationDelay: "0.3s" } },
        "reactions received"
      ),
      breakdown.length > 0 && e("div", {
        className: "wr-fade-up",
        style: {
          display: "flex", flexWrap: "wrap", gap: 10,
          marginTop: 36, justifyContent: "center",
          maxWidth: 320,
          animationDelay: "0.45s",
        },
      },
        ...breakdown.map((item, i) =>
          e("div", {
            key: item.emoji || i,
            className: "wr-pill-pop",
            style: {
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              padding: "10px 14px", borderRadius: 12,
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              animationDelay: `${0.5 + i * 0.07}s`,
            },
          },
            e("span", { style: { fontSize: 28 } }, item.emoji || "❤️"),
            e("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--t1)" } }, (item.count || 0).toLocaleString()),
          )
        )
      ),
      topReactor && e("div", {
        className: "wr-fade-up",
        style: {
          marginTop: 32, fontSize: 13, color: "var(--t4)", animationDelay: "0.8s",
        },
      },
        e("span", { style: { color: "var(--t3)" } }, "your biggest fan: "),
        e("span", { style: { color: "var(--ac-text)", fontWeight: 500 } }, topReactor.username || ""),
        e("span", { style: { color: "var(--t5)" } }, ` · ${(topReactor.count || 0).toLocaleString()} reactions`)
      )
    );
  }

  // ── Slide: Mentions ───────────────────────────────────────────────────────
  function SlideMentions({ d }) {
    const total     = d.mentions_received || 0;
    const unique    = d.unique_mentioners || 0;
    const mentioners = d.top_mentioners || [];
    const top       = mentioners[0];

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "mentions"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 80, fontWeight: 700, color: "var(--blue)", lineHeight: 1, letterSpacing: -3, animationDelay: "0.1s" } },
        e(AnimCounter, { target: total, duration: 1200, delay: 200 })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 20, color: "var(--t2)", marginTop: 14, animationDelay: "0.3s" } },
        total === 1 ? "time you were mentioned" : "times you were mentioned"
      ),
      unique > 0 && e("div", { className: "wr-fade-up", style: { fontSize: 13, color: "var(--t4)", marginTop: 8, animationDelay: "0.4s" } },
        `by ${unique} different ${unique === 1 ? "person" : "people"}`
      ),

      // Top mentioner spotlight
      top && e("div", {
        className: "wr-fade-up",
        style: {
          marginTop: 36, padding: "18px 24px",
          background: "var(--s2)", border: "0.5px solid var(--b1)",
          borderRadius: 14, display: "flex", alignItems: "center",
          gap: 16, maxWidth: 340, animationDelay: "0.5s",
        },
      },
        // Avatar
        e("div", {
          style: {
            width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
            background: top.avatar_color || "var(--ac)",
            overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
          },
        },
          top.avatar_url
            ? e("img", { src: top.avatar_url, alt: top.username, style: { width: "100%", height: "100%", objectFit: "cover" } })
            : e("span", { style: { fontSize: 18, fontWeight: 600, color: "var(--ac-on)" } },
                (top.username || "?").slice(0, 2).toUpperCase()
              )
        ),
        e("div", { style: { minWidth: 0 } },
          e("div", { style: { fontSize: 11, color: "var(--t4)", marginBottom: 4 } },
            "mentioned you the most"
          ),
          e("div", { style: { fontSize: 18, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            `@${top.username || ""}`
          ),
          e("div", { style: { fontSize: 13, color: "var(--blue)", marginTop: 3 } },
            `${top.count || 0} ${(top.count || 0) === 1 ? "mention" : "mentions"}`
          ),
        )
      ),

      // Runner-up mentioners
      mentioners.length > 1 && e("div", {
        className: "wr-fade-up",
        style: { display: "flex", gap: 8, marginTop: 16, animationDelay: "0.65s" },
      },
        ...mentioners.slice(1).map((m, i) =>
          e("div", {
            key: m.user_id || i,
            className: "wr-pill-pop",
            style: {
              display: "flex", alignItems: "center", gap: 7,
              padding: "6px 12px", borderRadius: 20,
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              animationDelay: `${0.7 + i * 0.08}s`,
            },
          },
            e("div", {
              style: {
                width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                background: m.avatar_color || "var(--s3)",
                overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
              },
            },
              m.avatar_url
                ? e("img", { src: m.avatar_url, alt: m.username, style: { width: "100%", height: "100%", objectFit: "cover" } })
                : e("span", { style: { fontSize: 9, color: "var(--ac-on)" } }, (m.username || "?").slice(0, 2).toUpperCase())
            ),
            e("span", { style: { fontSize: 12, color: "var(--t2)" } }, `@${m.username}`),
            e("span", { style: { fontSize: 11, color: "var(--t4)" } }, `·\u00a0${m.count}`)
          )
        )
      ),

      total === 0 && e("div", { className: "wr-fade-up", style: { fontSize: 13, color: "var(--t4)", marginTop: 20, animationDelay: "0.4s" } },
        "No one mentioned you this year — yet"
      )
    );
  }

  // ── Slide 4: Your spaces ──────────────────────────────────────────────────
  function SlideSpaces({ d }) {
    const spaces   = (d.spaces_breakdown || []).slice(0, 5);
    const topSpace = d.top_space;
    const maxCount = spaces.length > 0 ? spaces[0].post_count || 1 : 1;
    const BAR_COLORS = ["var(--ac)", "var(--pink)", "var(--green)", "var(--blue)", "var(--amber)"];

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "your home"
      ),
      topSpace && e("div", { className: "wr-count-pop", style: { fontSize: 44, fontWeight: 700, color: "var(--ac)", lineHeight: 1.1, animationDelay: "0.1s", maxWidth: 360 } },
        topSpace.name || "General"
      ),
      topSpace && e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t3)", marginTop: 8, animationDelay: "0.25s" } },
        `${Math.round(d.top_space_pct || 0)}% of your posts this year`
      ),
      spaces.length > 0 && e("div", {
        style: { width: "100%", maxWidth: 380, marginTop: 36 },
      },
        ...spaces.map((sp, i) =>
          e("div", {
            key: sp.slug || i,
            className: "wr-fade-up",
            style: {
              display: "flex", alignItems: "center", gap: 12,
              marginBottom: 12, animationDelay: `${0.3 + i * 0.1}s`,
            },
          },
            e("div", { style: { width: 96, textAlign: "right", fontSize: 12, color: "var(--t3)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              sp.name || ""
            ),
            e("div", { style: { flex: 1, height: 6, background: "var(--s3)", borderRadius: 3, overflow: "hidden" } },
              e(AnimBar, {
                pct:   Math.round((sp.post_count || 0) / maxCount * 100),
                color: BAR_COLORS[i],
                delay: 300 + i * 100,
              })
            ),
            e("div", { style: { width: 36, fontSize: 12, color: "var(--t4)", flexShrink: 0 } },
              (sp.post_count || 0).toLocaleString()
            )
          )
        )
      )
    );
  }

  // ── Slide 5: Rank + milestones ────────────────────────────────────────────
  function SlideRank({ d }) {
    const rank = d.leaderboard_rank || null;
    const milestones = d.milestones || [];
    const MILESTONE_LABELS = {
      centurion:        ["fa-pen",          "var(--ac)",    "Centurion"],
      prolific:         ["fa-fire",         "var(--amber)", "Prolific"],
      unstoppable:      ["fa-bolt",         "var(--amber)", "Unstoppable"],
      daily_regular:    ["fa-calendar",     "var(--green)", "Regular"],
      streak_7:         ["fa-fire",         "var(--amber)", "On a roll"],
      streak_30:        ["fa-fire",         "var(--amber)", "Streak master"],
      streak_100:       ["fa-crown",        "var(--amber)", "Streak legend"],
      night_owl:        ["fa-moon",         "var(--blue)",  "Night owl"],
      early_bird:       ["fa-sun",          "var(--amber)", "Early bird"],
      weekend_warrior:  ["fa-umbrella-beach","var(--green)","Weekend warrior"],
      popular:          ["fa-heart",        "var(--pink)",  "Popular"],
      generous:         ["fa-hand-holding-heart","var(--pink)","Generous"],
      collector:        ["fa-bookmark",     "var(--blue)",  "Collector"],
      communicator:     ["fa-message",      "var(--green)", "Communicator"],
      badge_hunter:     ["fa-medal",        "var(--amber)", "Badge hunter"],
      top_10:           ["fa-trophy",       "var(--amber)", "Top 10"],
    };

    return e(Slide, null,
      e(ConfettiBurst, { active: true }),
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 24, textTransform: "uppercase" } },
        "leaderboard"
      ),
      rank && e("div", { className: "wr-rank-drop", style: { fontSize: 100, fontWeight: 700, color: "var(--ac)", lineHeight: 1, letterSpacing: -4, animationDelay: "0.1s" } },
        `#${rank}`
      ),
      rank && e("div", { className: "wr-fade-up", style: { fontSize: 16, color: "var(--t3)", marginTop: 10, animationDelay: "0.4s" } },
        "you finished the year here"
      ),
      milestones.length > 0 && e("div", {
        style: { display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 36, maxWidth: 420 },
      },
        ...milestones.slice(0, 8).map((key, i) => {
          const [icon, color, label] = MILESTONE_LABELS[key] || ["fa-star", "var(--ac)", key];
          return e("div", {
            key,
            className: "wr-pill-pop",
            style: {
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", borderRadius: 20,
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              color: "var(--t2)", fontSize: 12,
              animationDelay: `${0.5 + i * 0.06}s`,
            },
          },
            e("i", { className: `fa-solid ${icon}`, style: { color, fontSize: 11 } }),
            label
          );
        })
      )
    );
  }

  // ── Slide 6: Finale ───────────────────────────────────────────────────────
  function SlideFinale({ d, username, year, navigate, isShared, onShareToggle }) {
    const [sharing, setSharing] = useState(false);
    const [shared,  setShared]  = useState(isShared || false);

    const toggleShare = () => {
      setSharing(true);
      apiFetch(`/${year}/share`, { method: "PATCH" })
        .then(res => {
          if (res.data) {
            setShared(res.data.shared);
            if (onShareToggle) onShareToggle(res.data.shared);
          }
        })
        .catch(() => {})
        .finally(() => setSharing(false));
    };
    return e(Slide, null,
      e(ConfettiBurst, { active: true }),
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase", animationDelay: "0.05s" } },
        "that's a wrap"
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 36, fontWeight: 700, color: "var(--t1)", lineHeight: 1.15, maxWidth: 320, animationDelay: "0.15s" } },
        `what a year, ${username}`
      ),
      e("div", {
        className: "wr-fade-up",
        style: {
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
          marginTop: 36, width: "100%", maxWidth: 340,
          animationDelay: "0.3s",
        },
      },
        ...[
          [(d.posts_count || 0).toLocaleString(),   "posts"],
          [(d.active_days || 0).toLocaleString(),   "active days"],
          [`#${d.leaderboard_rank || "—"}`,          "rank"],
          [(d.badges_earned_count || 0).toLocaleString(), "badges earned"],
        ].map(([val, label]) =>
          e("div", {
            key: label,
            style: {
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              borderRadius: 12, padding: "16px",
              textAlign: "center",
            },
          },
            e("div", { style: { fontSize: 28, fontWeight: 700, color: "var(--ac)", lineHeight: 1 } }, val),
            e("div", { style: { fontSize: 11, color: "var(--t4)", marginTop: 5 } }, label)
          )
        )
      ),
      e("div", {
        className: "wr-fade-up",
        style: { display: "flex", gap: 10, marginTop: 32, animationDelay: "0.55s" },
      },
        e("button", {
          onClick: () => NE.navigate(`/profile/${username}/wrapped`),
          style: {
            padding: "10px 22px", borderRadius: 24,
            background: "var(--ac)", border: "none",
            color: "var(--ac-on)", fontSize: 13, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit",
          },
        }, "View my profile"),
        e("button", {
          onClick: toggleShare,
          disabled: sharing,
          style: {
            padding: "10px 22px", borderRadius: 24,
            background: shared ? "var(--s2)" : "none",
            border: shared ? "0.5px solid var(--b2)" : "0.5px solid var(--b2)",
            color: shared ? "var(--ac-text)" : "var(--t3)",
            fontSize: 13, cursor: sharing ? "default" : "pointer",
            fontFamily: "inherit", opacity: sharing ? 0.6 : 1,
          },
        }, sharing ? "…" : shared ? "✓ Shared publicly" : "Make public")
      )
    );
  }

  // ── Nav overlay ───────────────────────────────────────────────────────────
  // ── useSwipe — Fancybox-matched swipe detection ───────────────────────────
  // Mirrors Fancybox 5 Carousel thresholds exactly:
  //   distance > containerWidth / 3  OR  velocity > 0.5 px/ms
  // Direction lock: horizontal swipes only (|deltaX| must exceed |deltaY|).
  // Returns { onTouchStart, onTouchEnd } to spread onto the slide container div.

  function useSwipe(onPrev, onNext) {
    const touch = useRef(null);

    const onTouchStart = useCallback((ev) => {
      const t = ev.touches[0];
      touch.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    }, []);

    const onTouchEnd = useCallback((ev) => {
      if (!touch.current) return;
      const t       = ev.changedTouches[0];
      const deltaX  = t.clientX - touch.current.x;
      const deltaY  = t.clientY - touch.current.y;
      const elapsed = Date.now() - touch.current.t;
      touch.current = null;

      // Ignore if primarily vertical (scroll intent)
      if (Math.abs(deltaY) > Math.abs(deltaX)) return;
      // Ignore micro-movements (tap)
      if (Math.abs(deltaX) < 10) return;

      const velocity  = Math.abs(deltaX) / elapsed;          // px/ms
      const threshold = (window.innerWidth || 375) / 3;      // Fancybox: 1/3 width
      const triggered = Math.abs(deltaX) > threshold || velocity > 0.5;

      if (!triggered) return;
      if (deltaX < 0) onNext(); else onPrev();
    }, [onPrev, onNext]);

    return { onTouchStart, onTouchEnd };
  }

  // ── SlideNav ──────────────────────────────────────────────────────────────
  function SlideNav({ current, total, onPrev, onNext }) {
    // On mobile (≤767px), Nexus's .mob-tabbar is fixed at the bottom with
    // height calc(54px + env(safe-area-inset-bottom)). We push SlideNav up
    // above it so it isn't covered. On desktop .mob-tabbar is display:none.
    const isMobile = typeof window !== "undefined" &&
      window.matchMedia("(max-width:767.99px)").matches;

    const bottomOffset = isMobile
      ? "calc(54px + env(safe-area-inset-bottom))"
      : 0;

    return e("div", {
      style: {
        position: "fixed", bottom: bottomOffset, left: 0, right: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 24px",
        background: "var(--s1)", borderTop: "0.5px solid var(--b1)",
        zIndex: 100,
      },
    },
      e("button", {
        onClick: onPrev, disabled: current === 0,
        style: {
          background: "none", border: "0.5px solid var(--b2)",
          color: current === 0 ? "var(--t5)" : "var(--t3)",
          borderRadius: 8, padding: "7px 16px", cursor: current === 0 ? "default" : "pointer",
          fontSize: 13, fontFamily: "inherit",
        },
      }, "← back"),
      e("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        ...Array.from({ length: total }, (_, i) =>
          e("div", {
            key: i,
            style: {
              height: 5, borderRadius: 3,
              background: i === current ? "var(--ac)" : "var(--b2)",
              width: i === current ? 20 : 5,
              transition: "all 0.25s ease",
              cursor: "pointer",
            },
          })
        )
      ),
      e("button", {
        onClick: onNext, disabled: current === total - 1,
        style: {
          background: current === total - 1 ? "none" : "var(--ac)",
          border: current === total - 1 ? "0.5px solid var(--b2)" : "none",
          color: current === total - 1 ? "var(--t5)" : "var(--ac-on)",
          borderRadius: 8, padding: "7px 16px",
          cursor: current === total - 1 ? "default" : "pointer",
          fontSize: 13, fontFamily: "inherit", fontWeight: 500,
        },
      }, current === total - 1 ? "done" : "next →")
    );
  }

  // ── WrappedPage root ──────────────────────────────────────────────────────
  function WrappedPage({ year, username, currentUser, navigate }) {
    const [state,   setState]   = useState({ status: "loading" });
    const [current, setCurrent] = useState(0);
    const [key,     setKey]     = useState(0);

    useEffect(() => {
      apiFetch(`/${year}/${encodeURIComponent(username)}`)
        .then(d => {
          if (d.data)                            setState({ status: "ready", data: d.data });
          else if (d.status === "not_generated") setState({ status: "error", code: "not_generated" });
          else                                   setState({ status: "error", code: d.error || "unknown" });
        })
        .catch(() => setState({ status: "error", code: "network_error" }));
    }, [year, username]);

    const go = (n) => {
      setCurrent(n);
      setKey(k => k + 1);
    };

    // Hooks must be called unconditionally — before any early returns.
    // onPrev/onNext are stable references; slides.length is only used in the
    // ready branch so we cap at 0 safely here.
    const onPrev = useCallback(() => setCurrent(c => Math.max(0, c - 1)), []);
    const onNext = useCallback(() => setCurrent(c => c + 1), []);
    const swipe  = useSwipe(onPrev, onNext);

    if (state.status === "loading") return e("div", {
      style: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" },
    }, e("i", { className: "fa-solid fa-spinner fa-spin", style: { fontSize: 24, color: "var(--ac)" } }));

    if (state.status === "error") {
      const msgs = { not_generated: "Wrapped hasn't been generated yet.", private: "This Wrapped is private.", network_error: "Could not load. Check your connection." };
      return e("div", {
        style: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--bg)", padding: 32 },
      },
        e("i", { className: "fa-solid fa-triangle-exclamation", style: { fontSize: 28, color: "var(--amber)" } }),
        e("div", { style: { fontSize: 15, color: "var(--t2)" } }, msgs[state.code] || "Something went wrong."),
        e("button", {
          onClick: () => NE.navigate(`/profile/${username}`),
          style: { fontSize: 13, padding: "7px 18px", borderRadius: 8, background: "none", border: "0.5px solid var(--b1)", color: "var(--t4)", cursor: "pointer", fontFamily: "inherit", marginTop: 8 },
        }, `Back to ${username}'s profile`)
      );
    }

    const d = state.data.current || state.data;

    const slides = [
      e(SlideOpening,     { key: `0-${key}`, d, username, year, currentUser }),
      e(SlideConsistency, { key: `1-${key}`, d }),
      e(SlidePersonality, { key: `2-${key}`, d }),
      e(SlideReactions,   { key: `3-${key}`, d }),
      e(SlideMentions,    { key: `4-${key}`, d }),
      e(SlideSpaces,      { key: `5-${key}`, d }),
      e(SlideRank,        { key: `6-${key}`, d }),
      e(SlideFinale,      { key: `6-${key}`, d, username, year, navigate, isShared: state.data.is_shared }),
    ];

    // Conditionally add Gamepedia slide if available
    if (d.gamepedia_available) {
      slides.splice(5, 0,
        e(SlideGamelog,       { key: `gp1-${key}`, d }),
        e(SlideGameDiscussed, { key: `gp2-${key}`, d })
      );
    }

    // Wrap the hook callbacks to also fire setKey for slide animation reset
    const onPrevNav = () => { onPrev(); setKey(k => k + 1); };
    const onNextNav = (len) => { if (current < len - 1) { onNext(); setKey(k => k + 1); } };

    return e("div", {
      style: { position: "relative", minHeight: "100vh", background: "var(--bg)" },
      ...swipe,
    },
      slides[current],
      e(SlideNav, {
        current,
        total: slides.length,
        onPrev: onPrevNav,
        onNext: () => onNextNav(slides.length),
      })
    );
  }

  // ── Slide: Gamelog ────────────────────────────────────────────────────────
  function SlideGamelog({ d }) {
    const games       = (d.gamepedia_games || []).slice(0, 9);
    const topGenre    = d.gamepedia_top_genre;
    const topRated    = d.gamepedia_top_rated;
    const nowPlaying  = d.gamepedia_now_playing;
    const count       = d.gamepedia_count || 0;

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "your gamelog"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 80, fontWeight: 700, color: "var(--green)", lineHeight: 1, letterSpacing: -3, animationDelay: "0.1s" } },
        e(AnimCounter, { target: count, duration: 1000, delay: 200 })
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 20, color: "var(--t2)", marginTop: 14, animationDelay: "0.3s" } },
        count === 1 ? "game in your library" : "games in your library"
      ),
      e("div", {
        className: "wr-fade-up",
        style: { display: "flex", gap: 12, marginTop: 20, justifyContent: "center", flexWrap: "wrap", animationDelay: "0.4s" },
      },
        nowPlaying && e("div", { style: { fontSize: 12, color: "var(--green)", display: "flex", alignItems: "center", gap: 5 } },
          e("i", { className: "fa-solid fa-circle-play", style: { fontSize: 11 } }),
          `Now playing: ${nowPlaying.name}`
        ),
        topGenre && e("div", { style: { fontSize: 12, color: "var(--t4)" } },
          `Top genre: `, e("span", { style: { color: "var(--ac-text)" } }, topGenre)
        ),
        topRated && e("div", { style: { fontSize: 12, color: "var(--t4)" } },
          `Top rated: `, e("span", { style: { color: "var(--amber)" } },
            topRated.name, e("span", { style: { color: "var(--t5)" } }, ` · ${topRated.rating}/10`)
          )
        ),
      ),
      games.length > 0 && e("div", {
        className: "wr-fade-up",
        style: {
          display: "flex", flexWrap: "wrap", gap: 8,
          justifyContent: "center", marginTop: 24, maxWidth: 380,
          animationDelay: "0.55s",
        },
      },
        ...games.map((g, i) =>
          e("div", {
            key: g.id || i,
            className: "wr-pill-pop",
            style: {
              padding: "6px 12px", borderRadius: 8,
              background: "var(--s2)", border: "0.5px solid var(--b1)",
              fontSize: 12, color: "var(--t2)",
              animationDelay: `${0.6 + i * 0.05}s`,
            },
          }, g.name || "")
        )
      ),
      count === 0 && e("div", { className: "wr-fade-up", style: { fontSize: 13, color: "var(--t4)", marginTop: 16, animationDelay: "0.4s" } },
        "Add games to your library on Gamepedia"
      )
    );
  }

  // ── Slide: Most Discussed Games ───────────────────────────────────────────
  function SlideGameDiscussed({ d }) {
    const userTop = (d.gamepedia_user_discussed || []).slice(0, 5);
    const siteTop = (d.gamepedia_most_discussed  || []).slice(0, 5);
    const hasUser = userTop.length > 0;
    const list    = hasUser ? userTop : siteTop;

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        hasUser ? "games you talked about" : "most discussed games"
      ),
      list.length > 0
        ? e("div", {
            className: "wr-fade-up",
            style: {
              display: "grid",
              gridTemplateColumns: `repeat(${Math.min(list.length, 5)}, minmax(0, 1fr))`,
              gap: 10, width: "100%", maxWidth: 480,
              animationDelay: "0.15s",
            },
          },
            ...list.map((g, i) =>
              e("div", {
                key: g.id || i,
                className: "wr-pill-pop",
                style: {
                  borderRadius: 10, overflow: "hidden",
                  background: "rgba(255,255,255,.04)",
                  border: "0.5px solid rgba(255,255,255,.08)",
                  animationDelay: `${0.15 + i * 0.07}s`,
                  position: "relative",
                },
              },
                // Rank badge
                e("div", {
                  style: {
                    position: "absolute", top: 6, left: 6, zIndex: 2,
                    width: 20, height: 20, borderRadius: "50%",
                    background: i === 0 ? "var(--ac)" : "rgba(0,0,0,.6)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700,
                    color: i === 0 ? "var(--ac-on)" : "rgba(255,255,255,.7)",
                  },
                }, `${i + 1}`),
                // Cover image
                g.cover_image_url
                  ? e("img", {
                      src: g.cover_image_url, alt: g.name,
                      style: { width: "100%", aspectRatio: "3/4", objectFit: "cover", display: "block" },
                    })
                  : e("div", {
                      style: {
                        width: "100%", aspectRatio: "3/4",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 24, color: "var(--t5)",
                      },
                    }, e("i", { className: "fa-solid fa-gamepad" })),
                // Info
                e("div", { style: { padding: "6px 8px 8px" } },
                  e("div", { style: { fontSize: 11, fontWeight: 500, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    g.name || ""
                  ),
                  e("div", { style: { fontSize: 10, color: "var(--t4)", marginTop: 2 } },
                    `${g.post_count || 0} ${(g.post_count || 0) === 1 ? "post" : "posts"}`
                  )
                )
              )
            )
          )
        : e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t4)", marginTop: 24 } },
            "No game-linked posts yet"
          ),
      !hasUser && siteTop.length > 0 && e("div", { className: "wr-fade-up", style: { fontSize: 11, color: "var(--t5)", marginTop: 20, animationDelay: "0.7s" } },
        "across the whole forum"
      )
    );
  }

  // =========================================================================
  // COMMUNITY WRAPPED WIDGET — global right sidebar
  // =========================================================================
  // Fetches GET /community/:year to check if a community Wrapped has been
  // generated. Returns null (invisible) if none exists or if today is past
  // widget_hide_after. Styled as a standalone card like AwardAnnouncementWidget.

  function WrappedCommunityWidget({ navigate }) {
    const [data,    setData]    = useState(null);
    const [tick,    setTick]    = useState(0);
    const [loading, setLoading] = useState(true);

    const year = new Date().getFullYear();

    useEffect(() => {
      apiFetch(`/community/${year}`)
        .then(d => { if (d.data) setData(d.data); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, [year]);

    // Countdown tick — updates every second until hide date
    useEffect(() => {
      if (!data) return;
      const id = setInterval(() => setTick(n => n + 1), 1000);
      return () => clearInterval(id);
    }, [data]);

    if (loading || !data) return null;

    // If widget_hide_after is set and today is past it, hide the widget
    const hideAfter = data.widget_hide_after;
    if (hideAfter) {
      const hideDate = new Date(hideAfter);
      // Set to end of that day
      hideDate.setHours(23, 59, 59, 999);
      if (new Date() > hideDate) return null;
    }

    // Countdown to hide date
    function getCountdown() {
      if (!hideAfter) return null;
      const diff = new Date(hideAfter) - new Date();
      if (diff <= 0) return null;
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000)  / 60000);
      const s = Math.floor((diff % 60000)    / 1000);
      return { d, h, m, s };
    }

    function pad(n) { return String(n).padStart(2, "0"); }

    function handleCta() {
      NE.navigate(`/ext/wrapped/community/${year}`);
    }

    const cd = getCountdown();

    const bannerStyle = {
      width:    "100%",
      display:  "block",
      borderRadius: "12px 12px 0 0",
      overflow: "hidden",
    };

    const cdCellStyle = {
      borderRadius: 8, padding: "6px 4px", textAlign: "center",
      background: "rgba(167,139,250,0.10)",
      border: "0.5px solid rgba(167,139,250,0.25)",
    };

    const ctaStyle = {
      display: "block", width: "100%", padding: "9px 0",
      borderRadius: 8, fontSize: 13, fontWeight: 500,
      textAlign: "center", cursor: "pointer", border: "none",
      background: "#a78bfa", color: "#0d0d14",
      fontFamily: "inherit",
    };

    // Inline banner SVG — same design as generate_community_banner output,
    // rendered directly so the widget works without a saved file.
    const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 680 200">
      <rect width="680" height="200" fill="#080812"/>
      <rect x="220" y="38"  width="8"  height="22" rx="2" fill="#fbbf24" transform="rotate(-40,224,49)"/>
      <rect x="190" y="55"  width="6"  height="16" rx="2" fill="#f472b6" transform="rotate(-55,193,63)"/>
      <rect x="250" y="28"  width="5"  height="14" rx="2" fill="#60a5fa" transform="rotate(-25,252,35)"/>
      <rect x="172" y="40"  width="7"  height="18" rx="2" fill="#34d399" transform="rotate(-65,175,49)"/>
      <rect x="140" y="60"  width="5"  height="13" rx="2" fill="#a78bfa" transform="rotate(-50,142,66)"/>
      <rect x="108" y="32"  width="6"  height="16" rx="2" fill="#fbbf24" transform="rotate(-35,111,40)"/>
      <rect x="74"  y="50"  width="5"  height="14" rx="2" fill="#f472b6" transform="rotate(-20,76,57)"/>
      <rect x="444" y="38"  width="8"  height="22" rx="2" fill="#a78bfa" transform="rotate(40,448,49)"/>
      <rect x="474" y="55"  width="6"  height="16" rx="2" fill="#34d399" transform="rotate(55,477,63)"/>
      <rect x="418" y="28"  width="5"  height="14" rx="2" fill="#fbbf24" transform="rotate(25,420,35)"/>
      <rect x="500" y="40"  width="7"  height="18" rx="2" fill="#f472b6" transform="rotate(65,503,49)"/>
      <rect x="530" y="60"  width="5"  height="13" rx="2" fill="#60a5fa" transform="rotate(50,532,66)"/>
      <rect x="566" y="32"  width="6"  height="16" rx="2" fill="#34d399" transform="rotate(35,569,40)"/>
      <rect x="598" y="52"  width="5"  height="14" rx="2" fill="#fbbf24" transform="rotate(22,600,59)"/>
      <rect x="220" y="148" width="8"  height="22" rx="2" fill="#60a5fa" transform="rotate(40,224,159)"/>
      <rect x="190" y="132" width="6"  height="16" rx="2" fill="#a78bfa" transform="rotate(55,193,140)"/>
      <rect x="160" y="155" width="5"  height="14" rx="2" fill="#fbbf24" transform="rotate(25,162,162)"/>
      <rect x="120" y="138" width="7"  height="18" rx="2" fill="#f472b6" transform="rotate(65,123,147)"/>
      <rect x="88"  y="158" width="5"  height="13" rx="2" fill="#34d399" transform="rotate(50,90,164)"/>
      <rect x="56"  y="145" width="6"  height="16" rx="2" fill="#60a5fa" transform="rotate(30,59,153)"/>
      <rect x="450" y="148" width="8"  height="22" rx="2" fill="#f472b6" transform="rotate(-40,454,159)"/>
      <rect x="480" y="132" width="6"  height="16" rx="2" fill="#fbbf24" transform="rotate(-55,483,140)"/>
      <rect x="512" y="155" width="5"  height="14" rx="2" fill="#a78bfa" transform="rotate(-25,514,162)"/>
      <rect x="544" y="138" width="7"  height="18" rx="2" fill="#34d399" transform="rotate(-65,547,147)"/>
      <rect x="580" y="158" width="5"  height="13" rx="2" fill="#60a5fa" transform="rotate(-50,582,164)"/>
      <rect x="616" y="143" width="6"  height="16" rx="2" fill="#fbbf24" transform="rotate(-30,619,151)"/>
      <circle cx="60"  cy="100" r="2.5" fill="#a78bfa" opacity="0.7"/>
      <circle cx="136" cy="100" r="2"   fill="#fbbf24" opacity="0.6"/>
      <circle cx="544" cy="100" r="2"   fill="#f472b6" opacity="0.6"/>
      <circle cx="620" cy="100" r="2.5" fill="#34d399" opacity="0.7"/>
      <circle cx="340" cy="18"  r="2"   fill="#60a5fa" opacity="0.6"/>
      <circle cx="340" cy="182" r="2"   fill="#fbbf24" opacity="0.6"/>
      <text x="340" y="76" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="11" letter-spacing="5" font-weight="400" fill="#6b5fa0">${(data.community?.forum_name || String(year)).toUpperCase()}</text>
      <text x="340" y="142" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="76" font-weight="700" letter-spacing="-3" fill="#ffffff">${year}</text>
      <text x="340" y="164" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="13" letter-spacing="5" font-weight="600"><tspan fill="#a78bfa">W</tspan><tspan fill="#f472b6">R</tspan><tspan fill="#fbbf24">A</tspan><tspan fill="#34d399">P</tspan><tspan fill="#60a5fa">P</tspan><tspan fill="#a78bfa">E</tspan><tspan fill="#f472b6">D</tspan></text>
    </svg>`;

    return e("div", { style: { borderRadius: 12, border: "0.5px solid rgba(255,255,255,0.08)", background: "#08080f" } },

      // Banner — inline SVG as HTML
      e("div", {
        style: bannerStyle,
        dangerouslySetInnerHTML: { __html: bannerSvg },
      }),

      // Body
      e("div", { style: { padding: "12px 14px 14px" } },

        // Label
        e("div", {
          style: { fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 10, lineHeight: 1.5 },
        }, `The ${year} Community Wrapped is ready to view.`),

        // Countdown to hide date
        cd && e("div", { style: { marginBottom: 10 } },
          e("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5, marginBottom: 6 } },
            [{ v: pad(cd.d), l: "days" }, { v: pad(cd.h), l: "hrs" }, { v: pad(cd.m), l: "min" }, { v: pad(cd.s), l: "sec" }]
              .map(seg => e("div", { key: seg.l, style: cdCellStyle },
                e("div", { style: { fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1, marginBottom: 2, color: "#a78bfa" } }, seg.v),
                e("div", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "rgba(167,139,250,0.55)" } }, seg.l)
              ))
          ),
          e("div", { style: { fontSize: 11, color: "rgba(255,255,255,0.25)", textAlign: "center" } },
            "Available until " + new Date(hideAfter).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          )
        ),

        // CTA
        e("button", { onClick: handleCta, style: ctaStyle }, `View ${year} Community Wrapped`)
      )
    );
  }

  // =========================================================================
  // COMMUNITY WRAPPED SLIDESHOW — /wrapped/community/:year
  // =========================================================================

  // ── YoY delta helper ──────────────────────────────────────────────────────
  function YoYBadge({ current, prev }) {
    if (!prev || prev === 0) return null;
    const pct = Math.round((current - prev) / prev * 100);
    if (pct === 0) return null;
    const up    = pct > 0;
    const color = up ? "var(--green)" : "var(--red)";
    const bg    = up ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)";
    const icon  = up ? "fa-arrow-up" : "fa-arrow-down";
    return e("span", {
      className: "wr-fade-in",
      style: {
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 8px", borderRadius: 20, fontSize: 12,
        background: bg, color, marginLeft: 8,
        animationDelay: "0.5s",
      },
    },
      e("i", { className: `fa-solid ${icon}`, style: { fontSize: 10 } }),
      `${Math.abs(pct)}%`
    );
  }

  // ── Avatar helper ─────────────────────────────────────────────────────────
  function CommunityAvatar({ user, size = 40 }) {
    const initials = (user.username || "?").slice(0, 2).toUpperCase();
    return e("div", {
      style: {
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        background: user.avatar_color || "var(--ac)",
        overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      },
    },
      user.avatar_url
        ? e("img", { src: user.avatar_url, alt: user.username, style: { width: "100%", height: "100%", objectFit: "cover" } })
        : e("span", { style: { fontSize: size * 0.35, fontWeight: 600, color: "var(--ac-on)" } }, initials)
    );
  }

  // ── Slide 0: Thank you / Intro ────────────────────────────────────────────
  function CommSlideIntro({ d, forumName }) {
    const year          = d.year;
    const introMessage  = d.intro_message;

    // If a custom message was stored (already interpolated by the backend),
    // render it as plain text paragraphs. Otherwise use the default structured layout.
    if (introMessage) {
      const paragraphs = introMessage.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      return e(Slide, null,
        e(ConfettiBurst, { active: true }),
        e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
          `${forumName} · ${year}`
        ),
        e("div", { style: { maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 } },
          ...paragraphs.map((p, i) =>
            e("div", {
              key: i,
              className: "wr-fade-up",
              style: {
                fontSize: i === 0 ? 26 : 15,
                fontWeight: i === 0 ? 700 : 400,
                color: i === 0 ? "var(--t1)" : "var(--t3)",
                lineHeight: 1.5,
                animationDelay: `${0.1 + i * 0.15}s`,
              },
            }, p)
          )
        )
      );
    }

    // Default layout
    const totalPosts     = (d.total_posts     || 0).toLocaleString();
    const totalReactions = (d.total_reactions || 0).toLocaleString();
    const newMembers     = (d.new_members     || 0).toLocaleString();
    const activeMembers  = (d.active_members  || 0).toLocaleString();

    return e(Slide, null,
      e(ConfettiBurst, { active: true }),
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 16, textTransform: "uppercase" } },
        `${forumName} · ${year}`
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 52, fontWeight: 700, color: "var(--ac)", lineHeight: 1.1, letterSpacing: -2, animationDelay: "0.1s", maxWidth: 360 } },
        `What a year, ${forumName}.`
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 15, color: "var(--t3)", marginTop: 20, maxWidth: 380, lineHeight: 1.65, animationDelay: "0.3s" } },
        `In ${year}, `, e("strong", { style: { color: "var(--t1)" } }, activeMembers),
        " of you showed up, shared your thoughts, started conversations, and made this place what it is. You wrote ",
        e("strong", { style: { color: "var(--t1)" } }, totalPosts),
        " posts, left ",
        e("strong", { style: { color: "var(--t1)" } }, totalReactions),
        " reactions, and welcomed ",
        e("strong", { style: { color: "var(--t1)" } }, newMembers),
        " new members into the community."
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t4)", marginTop: 16, animationDelay: "0.5s" } },
        "This is your year in review."
      )
    );
  }

  // ── Slide 1: The Numbers ──────────────────────────────────────────────────
  function CommSlideNumbers({ d }) {
    const stats = [
      { label: "posts written",    val: d.total_posts,     prev: d.prev_total_posts,     color: "var(--ac)"   },
      { label: "replies posted",   val: d.total_replies,   prev: d.prev_total_replies,   color: "var(--pink)" },
      { label: "reactions left",   val: d.total_reactions, prev: d.prev_total_reactions, color: "var(--green)"},
      { label: "new members",      val: d.new_members,     prev: null,                   color: "var(--blue)" },
    ];

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 28, textTransform: "uppercase" } },
        "by the numbers"
      ),
      e("div", { style: { display: "flex", flexDirection: "column", gap: 24, width: "100%", maxWidth: 320, alignItems: "center" } },
        ...stats.map((s, i) =>
          e("div", {
            key: s.label,
            className: "wr-fade-up",
            style: { animationDelay: `${0.1 + i * 0.12}s`, width: "100%", textAlign: "center" },
          },
            e("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", justifyContent: "center" } },
              e("div", { className: "wr-count-pop", style: { fontSize: 56, fontWeight: 700, color: s.color, lineHeight: 1, letterSpacing: -2, animationDelay: `${0.15 + i * 0.12}s` } },
                e(AnimCounter, { target: s.val || 0, duration: 1000, delay: 200 + i * 120 })
              ),
              e(YoYBadge, { current: s.val || 0, prev: s.prev || 0 })
            ),
            e("div", { style: { fontSize: 12, color: "var(--t4)", marginTop: 3, letterSpacing: 1, textTransform: "uppercase" } }, s.label)
          )
        )
      )
    );
  }

  // ── Slide 2: Top contributors by posts + replies ───────────────────────────
  function CommSlideTopContributors({ d }) {
    const list = (d.top_contributors || []).slice(0, 5);

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 28, textTransform: "uppercase" } },
        "top contributors"
      ),
      e("div", { style: { width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 14 } },
        ...list.map((u, i) =>
          e("div", {
            key: u.user_id || i,
            className: "wr-fade-up",
            style: { display: "flex", alignItems: "center", gap: 14, animationDelay: `${0.1 + i * 0.1}s` },
          },
            e("div", { style: { width: 24, textAlign: "right", fontSize: 14, fontWeight: 600, color: i === 0 ? "var(--amber)" : "var(--t4)", flexShrink: 0 } },
              `#${i + 1}`
            ),
            e(CommunityAvatar, { user: u, size: 40 }),
            e("div", { style: { flex: 1, minWidth: 0 } },
              e("div", { style: { fontSize: 14, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `@${u.username}`
              ),
              e("div", { style: { fontSize: 12, color: "var(--t4)", marginTop: 2 } },
                `${(u.post_count || 0).toLocaleString()} posts · ${(u.reply_count || 0).toLocaleString()} replies`
              )
            ),
            e("div", { style: { fontSize: 18, fontWeight: 700, color: "var(--ac)", flexShrink: 0 } },
              (u.total || 0).toLocaleString()
            )
          )
        )
      )
    );
  }

  // ── Slide 3: Top contributors by reactions ────────────────────────────────
  function CommSlideReactionLeaders({ d }) {
    const received = (d.top_reactions_received || []).slice(0, 5);
    const given    = (d.top_reactions_given    || []).slice(0, 5);

    function ReactionList({ list, label, color, countKey }) {
      return e("div", { style: { flex: 1, minWidth: 0 } },
        e("div", { style: { fontSize: 10, letterSpacing: 2, color: "var(--t5)", textTransform: "uppercase", marginBottom: 12 } },
          label
        ),
        e("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          ...list.map((u, i) =>
            e("div", {
              key: u.user_id || i,
              className: "wr-fade-up",
              style: { display: "flex", alignItems: "center", gap: 8, animationDelay: `${0.15 + i * 0.08}s` },
            },
              e(CommunityAvatar, { user: u, size: 30 }),
              e("div", { style: { flex: 1, minWidth: 0 } },
                e("div", { style: { fontSize: 12, fontWeight: 500, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  `@${u.username}`
                )
              ),
              e("div", { style: { fontSize: 13, fontWeight: 600, color, flexShrink: 0 } },
                (u[countKey] || 0).toLocaleString()
              )
            )
          )
        )
      );
    }

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 28, textTransform: "uppercase" } },
        "reaction leaders"
      ),
      e("div", { style: { display: "flex", gap: 24, width: "100%", maxWidth: 420 } },
        e(ReactionList, { list: received, label: "most received", color: "var(--pink)",  countKey: "reactions_received" }),
        e("div", { style: { width: "0.5px", background: "var(--b1)", flexShrink: 0 } }),
        e(ReactionList, { list: given,    label: "most given",    color: "var(--amber)", countKey: "reactions_given"    })
      )
    );
  }

  // ── Slide 4: Most active space ────────────────────────────────────────────
  function CommSlideTopSpace({ d }) {
    const space      = (d.top_spaces || [])[0];
    const totalPosts = d.total_posts || 1;

    if (!space) return e(Slide, null,
      e("div", { style: { fontSize: 14, color: "var(--t4)" } }, "No space data available.")
    );

    const pct = Math.round((space.post_count || 0) / totalPosts * 100);

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "most active space"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 52, fontWeight: 700, color: "var(--ac)", lineHeight: 1.1, letterSpacing: -2, animationDelay: "0.1s", maxWidth: 360, textAlign: "center" } },
        space.name
      ),
      e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t3)", marginTop: 10, animationDelay: "0.25s" } },
        `${(space.post_count || 0).toLocaleString()} posts · ${pct}% of all forum activity`
      ),
      e("div", {
        className: "wr-fade-up",
        style: { width: "100%", maxWidth: 320, height: 6, background: "var(--s3)", borderRadius: 3, overflow: "hidden", marginTop: 28, animationDelay: "0.4s" },
      },
        e(AnimBar, { pct, color: "var(--ac)", delay: 400 })
      ),
      (d.top_spaces || []).length > 1 && e("div", {
        className: "wr-fade-up",
        style: { display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 320, marginTop: 24, animationDelay: "0.5s" },
      },
        ...(d.top_spaces || []).slice(1, 3).map((s, i) => {
          const sp = Math.round((s.post_count || 0) / totalPosts * 100);
          return e("div", { key: s.space_id || i, style: { display: "flex", alignItems: "center", gap: 12 } },
            e("div", { style: { width: 90, textAlign: "right", fontSize: 12, color: "var(--t3)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              s.name
            ),
            e("div", { style: { flex: 1, height: 4, background: "var(--s3)", borderRadius: 2, overflow: "hidden" } },
              e(AnimBar, { pct: sp, color: "var(--t4)", delay: 500 + i * 80 })
            ),
            e("div", { style: { width: 40, fontSize: 11, color: "var(--t4)", flexShrink: 0 } },
              (s.post_count || 0).toLocaleString()
            )
          );
        })
      )
    );
  }

  // ── Slide 5: Top tags cloud ───────────────────────────────────────────────
  function CommSlideTopTags({ d }) {
    const tags   = (d.top_tags || []).slice(0, 5);
    const maxCnt = tags.length > 0 ? Math.max(...tags.map(t => t.post_count || 1)) : 1;

    // Scale font size 18–42px based on relative post count
    function tagSize(count) {
      const ratio = (count || 1) / maxCnt;
      return Math.round(18 + ratio * 24);
    }

    // Colors cycling through accent palette when tag has no custom color
    const FALLBACK_COLORS = ["var(--ac)", "var(--pink)", "var(--green)", "var(--blue)", "var(--amber)"];

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 36, textTransform: "uppercase" } },
        "most active tags"
      ),
      e("div", {
        style: { display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", alignItems: "center", maxWidth: 400 },
      },
        ...tags.map((tag, i) => {
          const size  = tagSize(tag.post_count);
          const color = tag.color && tag.color !== "" ? tag.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length];
          // Derive a readable background from the color
          return e("div", {
            key: tag.tag_id || i,
            className: "wr-pill-pop",
            style: {
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              padding: `${Math.round(size * 0.3)}px ${Math.round(size * 0.5)}px`,
              borderRadius: 999,
              background: `${color}18`,
              border: `0.5px solid ${color}44`,
              animationDelay: `${0.1 + i * 0.1}s`,
              cursor: "default",
            },
          },
            e("span", { style: { fontSize: size, fontWeight: 700, color, lineHeight: 1 } },
              tag.name
            ),
            e("span", { style: { fontSize: 11, color: "var(--t4)", lineHeight: 1 } },
              `${(tag.post_count || 0).toLocaleString()} posts`
            )
          );
        })
      )
    );
  }

  // ── Slide 6: Most discussed thread ───────────────────────────────────────
  function CommSlideMostDiscussed({ d }) {
    const post = d.most_discussed;

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "most discussed"
      ),
      e("i", { className: "fa-solid fa-comments wr-count-pop", style: { fontSize: 48, color: "var(--blue)", animationDelay: "0.1s" } }),
      post
        ? e("div", { className: "wr-fade-up", style: { marginTop: 20, width: "100%", maxWidth: 380, animationDelay: "0.25s" } },
            e("div", {
              style: {
                background: "var(--s2)", border: "0.5px solid var(--b1)",
                borderRadius: 14, padding: "20px 22px", cursor: "pointer",
              },
              onClick: () => NE.navigate(`/post/${post.id}`),
            },
              e("div", { style: { fontSize: 16, fontWeight: 600, color: "var(--t1)", lineHeight: 1.4, marginBottom: 10 } },
                post.title
              ),
              e("div", { style: { display: "flex", gap: 16, fontSize: 12, color: "var(--t4)" } },
                e("span", null,
                  e("i", { className: "fa-solid fa-reply", style: { marginRight: 5, fontSize: 11 } }),
                  `${(post.reply_count || 0).toLocaleString()} replies`
                ),
                e("span", null,
                  e("i", { className: "fa-solid fa-user", style: { marginRight: 5, fontSize: 11 } }),
                  `@${post.username}`
                )
              )
            ),
            e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 10, textAlign: "center" } },
              "tap to open thread"
            )
          )
        : e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t4)", marginTop: 20 } },
            "No thread data available."
          )
    );
  }

  // ── Slide 7: Most loved post ──────────────────────────────────────────────
  function CommSlideMostLoved({ d }) {
    const post = d.most_loved_post;

    return e(Slide, null,
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase" } },
        "most loved post"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 72, animationDelay: "0.1s" } }, "❤️"),
      post
        ? e("div", { className: "wr-fade-up", style: { marginTop: 16, animationDelay: "0.25s" } },
            e("div", { className: "wr-count-pop", style: { fontSize: 56, fontWeight: 700, color: "var(--pink)", lineHeight: 1, letterSpacing: -2, animationDelay: "0.2s" } },
              e(AnimCounter, { target: post.reaction_count || 0, duration: 1000, delay: 300 })
            ),
            e("div", { style: { fontSize: 14, color: "var(--t3)", marginTop: 6 } }, "reactions"),
            e("div", {
              style: {
                background: "var(--s2)", border: "0.5px solid var(--b1)",
                borderRadius: 14, padding: "16px 20px", marginTop: 20,
                maxWidth: 360, cursor: "pointer",
              },
              onClick: () => NE.navigate(`/post/${post.id}`),
            },
              e("div", { style: { fontSize: 14, fontWeight: 500, color: "var(--t1)", lineHeight: 1.4, marginBottom: 8 } },
                post.title
              ),
              e("div", { style: { fontSize: 12, color: "var(--t4)" } },
                `by @${post.username}`
              )
            ),
            e("div", { style: { fontSize: 11, color: "var(--t5)", marginTop: 10 } }, "tap to open post")
          )
        : e("div", { className: "wr-fade-up", style: { fontSize: 14, color: "var(--t4)", marginTop: 20 } },
            "No post data available."
          )
    );
  }

  // ── Slide 8: Outro ────────────────────────────────────────────────────────
  function CommSlideOutro({ d, year, currentUser }) {
    return e(Slide, null,
      e(ConfettiBurst, { active: true }),
      e("div", { className: "wr-fade-in", style: { fontSize: 11, letterSpacing: 2, color: "var(--t4)", marginBottom: 20, textTransform: "uppercase", animationDelay: "0.05s" } },
        "that's a wrap"
      ),
      e("div", { className: "wr-count-pop", style: { fontSize: 44, fontWeight: 700, color: "var(--t1)", lineHeight: 1.2, maxWidth: 320, animationDelay: "0.15s" } },
        `Thank you for making ${year} special. 🙏`
      ),
      e("div", { className: "wr-fade-up", style: { marginTop: 32, animationDelay: "0.35s" } },
        currentUser
          ? e("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10 } },
              e("div", { style: { fontSize: 14, color: "var(--t3)", marginBottom: 4 } },
                "Now see your own personal Wrapped."
              ),
              e("button", {
                onClick: () => NE.navigate(`/profile/${currentUser.username}/wrapped`),
                style: {
                  padding: "10px 28px", borderRadius: 24,
                  background: "var(--ac)", border: "none",
                  color: "var(--ac-on)", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", fontFamily: "inherit",
                },
              }, `View my ${year} Wrapped`)
            )
          : e("div", { style: { fontSize: 13, color: "var(--t4)", maxWidth: 300, lineHeight: 1.6, textAlign: "center" } },
              `Please log in to view your personal ${year} Wrapped.`
            )
      )
    );
  }

  // ── WrappedCommunityPage root ─────────────────────────────────────────────
  function WrappedCommunityPage({ year: yearParam, currentUser, navigate }) {
    const [state,   setState]   = useState({ status: "loading" });
    const [current, setCurrent] = useState(0);
    const [key,     setKey]     = useState(0);

    const year = Number(yearParam) || new Date().getFullYear();

    useEffect(() => {
      apiFetch(`/community/${year}`)
        .then(d => {
          if (d.data)                        setState({ status: "ready", data: d.data });
          else if (d.status === "not_generated") setState({ status: "error", code: "not_generated" });
          else                               setState({ status: "error", code: d.error || "unknown" });
        })
        .catch(() => setState({ status: "error", code: "network_error" }));
    }, [year]);

    const go = (n) => { setCurrent(n); setKey(k => k + 1); };

    // Hooks must be called unconditionally — before any early returns.
    const onPrev = useCallback(() => setCurrent(c => Math.max(0, c - 1)), []);
    const onNext = useCallback(() => setCurrent(c => c + 1), []);
    const swipe  = useSwipe(onPrev, onNext);

    if (state.status === "loading") return e("div", {
      style: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" },
    }, e("i", { className: "fa-solid fa-spinner fa-spin", style: { fontSize: 24, color: "var(--ac)" } }));

    if (state.status === "error") {
      const msgs = { not_generated: "Community Wrapped hasn't been generated yet.", network_error: "Could not load. Check your connection." };
      return e("div", {
        style: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--bg)", padding: 32 },
      },
        e("i", { className: "fa-solid fa-triangle-exclamation", style: { fontSize: 28, color: "var(--amber)" } }),
        e("div", { style: { fontSize: 15, color: "var(--t2)" } }, msgs[state.code] || "Something went wrong."),
        e("button", {
          onClick: () => NE.navigate("/"),
          style: { fontSize: 13, padding: "7px 18px", borderRadius: 8, background: "none", border: "0.5px solid var(--b1)", color: "var(--t4)", cursor: "pointer", fontFamily: "inherit", marginTop: 8 },
        }, "Go to feed")
      );
    }

    const d          = state.data.community || {};
    const forumName  = d.forum_name || String(year);

    const slides = [
      e(CommSlideIntro,          { key: `c0-${key}`, d, forumName }),
      e(CommSlideNumbers,        { key: `c1-${key}`, d }),
      e(CommSlideTopContributors,{ key: `c2-${key}`, d }),
      e(CommSlideReactionLeaders,{ key: `c3-${key}`, d }),
      e(CommSlideTopSpace,       { key: `c4-${key}`, d }),
      e(CommSlideTopTags,        { key: `c5-${key}`, d }),
      e(CommSlideMostDiscussed,  { key: `c6-${key}`, d }),
      e(CommSlideMostLoved,      { key: `c7-${key}`, d }),
      e(CommSlideOutro,          { key: `c8-${key}`, d, year, currentUser }),
    ];

    const onPrevNav = () => { onPrev(); setKey(k => k + 1); };
    const onNextNav = (len) => { if (current < len - 1) { onNext(); setKey(k => k + 1); } };

    return e("div", {
      style: { position: "relative", minHeight: "100vh", background: "var(--bg)" },
      ...swipe,
    },
      slides[current],
      e(SlideNav, {
        current,
        total: slides.length,
        onPrev: onPrevNav,
        onNext: () => onNextNav(slides.length),
      })
    );
  }

  // ── Community landing redirect ────────────────────────────────────────────
  function WrappedCommunityLandingPage({ currentUser }) {
    useEffect(() => {
      const year = new Date().getFullYear();
      NE.navigate(`/ext/wrapped/community/${year}`);
    }, []);
    return e("div", {
      style: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" },
    }, e("i", { className: "fa-solid fa-spinner fa-spin", style: { fontSize: 20, color: "var(--ac)" } }));
  }

  // =========================================================================
  // REGISTRATIONS
  // =========================================================================

  // ── Landing page route ────────────────────────────────────────────────────
  // /wrapped — redirects to own profile Wrapped tab. Used by the explore item.
  function WrappedLandingPage({ currentUser }) {
    useEffect(() => {
      if (currentUser && currentUser.username) {
        NE.navigate(`/profile/${currentUser.username}/wrapped`);
      }
    }, []);
    return e("div", {
      style: { padding: "48px 0", textAlign: "center", color: "var(--t5)" },
    }, e("i", { className: "fa-solid fa-spinner fa-spin", style: { fontSize: 20 } }));
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  NE.registerRoute("wrapped", "/",                WrappedLandingPage,          { title: "Wrapped" });
  NE.registerRoute("wrapped", "/community",       WrappedCommunityLandingPage, { title: "Community Wrapped" });
  NE.registerRoute("wrapped", "/community/:year", WrappedCommunityPage,        { title: "Community Wrapped" });
  NE.registerRoute("wrapped", "/:year/:username", WrappedPage,                 { title: "Wrapped" });

  // ── Profile tab ───────────────────────────────────────────────────────────
  NE.registerProfileTab({
    slug:      "wrapped",
    id:        "wrapped",
    component: WrappedProfileTab,
  });

  // ── Account action — only visible in January ──────────────────────────────
  // Wrapped is a once-a-year event. The dropdown entry only appears during
  // January when users are most likely to have a new Wrapped waiting.
  const _wrappedMonth = new Date().getMonth(); // 0 = January
  if (_wrappedMonth === 0) {
    NE.registerAccountAction({
      id:       "wrapped-my-wrapped",
      label:    "My Wrapped",
      icon:     "fa-wand-sparkles",
      priority: 80,
      onClick({ currentUser, close }) {
        close();
        NE.navigate(`/profile/${currentUser.username}/wrapped`);
      },
    });
  }

  // ── Notification type ─────────────────────────────────────────────────────
  // NotificationsPage resolves extension notifications via:
  //   resolveExtType(n) → getNotifType(n.data?.ext_type)   (when n.type === "extension")
  // So registering under "wrapped_ready" handles both renderBody and onClick
  // correctly — no secondary "extension" registration needed.

  NE.registerNotificationType("wrapped_ready", {
    icon:      "fa-wand-sparkles",
    iconColor: "var(--ac)",
    renderBody(n) {
      const year = n.data?.year || new Date().getFullYear();
      return e(React.Fragment, null,
        e("div", { style: { marginBottom: 3 } },
          e("span", { style: { color: "var(--t1)", fontWeight: 600 } },
            `✨ Your ${year} Wrapped is ready`
          )
        ),
        e("div", { style: { fontSize: 12, color: "var(--t3)", lineHeight: 1.4 } },
          "Your year in review is here — posts, streaks, reactions and more. Tap to see your story."
        )
      );
    },
    onClick({ n }) {
      const year     = n.data?.year;
      const username = n.data?.username;
      if (year && username) {
        NE.navigate(`/ext/wrapped/${year}/${username}`);
        return;
      }
      // Fallback: go to profile Wrapped tab
      if (username) {
        NE.navigate(`/profile/${username}/wrapped`);
      }
    },
  });

  // ── Admin panel ───────────────────────────────────────────────────────────
  // Generation tab: fully custom — action buttons, live status, schedule
  //   fields, and intro message editor. Owns its own settings state and
  //   wires the topbar Save button directly.
  // Visibility / Content / Notifications tabs: SimpleSettingsPanel instances,
  //   each scoped to their own field list. The server merges patches so tabs
  //   can save independently without clobbering each other's keys.
  NE.registerAdminPanel("wrapped", {
    label:     "Wrapped",
    icon:      "fa-wand-sparkles",
    component: function WrappedAdminPanel() {
      const { TabbedPanel, SimpleSettingsPanel } = window.NexusExtensionTemplates;
      return e(TabbedPanel, {
        tabs: [
          {
            key:    "generation",
            label:  "Generation",
            icon:   "fa-wand-magic-sparkles",
            render: () => e(GenerationTab),
          },
          {
            key:    "visibility",
            label:  "Visibility",
            icon:   "fa-eye",
            render: () => e(SimpleSettingsPanel, {
              slug:   "wrapped",
              fields: [
                { key: "enabled",             label: "Enable Wrapped",           type: "boolean" },
                { key: "sharing_default",     label: "Share by default",         type: "boolean" },
                { key: "min_posts_threshold", label: "Minimum posts to qualify", type: "number",
                  hint: "Users with fewer posts than this threshold are skipped during generation." },
              ],
            }),
          },
          {
            key:    "content",
            label:  "Content",
            icon:   "fa-layer-group",
            render: () => e(SimpleSettingsPanel, {
              slug:   "wrapped",
              fields: [
                { key: "forum_name_override",  label: "Forum name override",  type: "string",
                  hint: "Overrides the site name used in banners and messages. Leave blank to use the name from General settings.",
                  placeholder: "e.g. Nexus Forum" },
                { key: "show_gamepedia_slide", label: "Show Gamepedia slide", type: "boolean",
                  hint: "Includes a slide showing the user's top games if they have Gamepedia activity." },
                { key: "show_dms_slide",       label: "Show DMs slide",       type: "boolean",
                  hint: "Includes a slide with direct message stats." },
              ],
            }),
          },
          {
            key:    "notifications",
            label:  "Notifications",
            icon:   "fa-bell",
            render: () => e(SimpleSettingsPanel, {
              slug:   "wrapped",
              fields: [
                { key: "send_notification_email", label: "Send notification email when ready", type: "boolean",
                  hint: "Sends each member an email when their personal Wrapped is ready to view." },
              ],
            }),
          },
        ],
      });
    },
  });

  // ── Explore item ──────────────────────────────────────────────────────────
  NE.registerExploreItem({
    slug:  "wrapped",
    path:  "/",
    label: "Wrapped",
    icon:  "fa-wand-sparkles",
  });

  // ── Community sidebar widget ──────────────────────────────────────────────
  // scope: "global" — appears on every page, admin-configurable per-page in Layout.
  // Self-hides if no community result exists or today > widget_hide_after.
  NE.registerRightWidget({
    slug:      "wrapped",
    id:        "wrapped-community",
    label:     "Community Wrapped",
    component: WrappedCommunityWidget,
    priority:  15,
    scope:     "global",
  });

})();
