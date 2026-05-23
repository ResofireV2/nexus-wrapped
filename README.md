![Wrapped](priv/static/banner.webp)

# Wrapped

A personalised year-in-review for every member of your Nexus community. At the end of each year, Wrapped generates a private slideshow for each member — posts written, reactions given and received, streaks, top spaces, milestones, and more — alongside a Community Wrapped that celebrates the forum as a whole.

---

## Features

- **Personal Wrapped** — a multi-slide year-in-review for every qualifying member, accessible from their profile tab and via a direct link
- **Community Wrapped** — an aggregate slideshow covering forum-wide stats: top contributors, most discussed threads, most loved posts, reaction leaders, top spaces and tags
- **Sidebar widget** — a community countdown/CTA widget that appears globally and self-hides after a configurable date
- **In-app notifications** — members are notified via the Nexus notification system when their Wrapped is ready, with an optional email
- **Explore entry** — Wrapped appears in the left sidebar's Explore section for easy discovery
- **Admin panel** — a tabbed admin interface covering generation, visibility, content, and notification settings

## Requirements

- Nexus `manifest_version 2` (current)
- Elixir `~> 1.17`
- Oban (provided by Nexus core — Wrapped enqueues jobs on the `extensions` queue)

## Installation

Install from the Nexus admin panel under **Extensions → Store**, or install from a local directory using the Nexus CLI.

On install, Wrapped runs three migrations creating the following tables:

| Table | Purpose |
|---|---|
| `wrapped_results` | Per-user, per-year generated Wrapped data |
| `wrapped_shares` | Per-user sharing preferences |
| `wrapped_community_results` | Per-year community aggregate data |

## Configuration

All settings are managed from the Wrapped admin panel (**Admin → Wrapped**).

### Generation tab

| Setting | Default | Description |
|---|---|---|
| Auto-generate date | — | Date on which Wrapped auto-generates for all eligible members |
| Auto-generate time | `09:00` | Time of day for auto-generation |
| Auto-generate timezone | `UTC` | Timezone for the scheduled generation time |
| Hide community widget after | — | The sidebar widget hides itself after this date. Leave blank to keep it visible indefinitely |
| Community post space | — | Default space for the optional community announcement post |

The Generation tab also provides:
- **Generate all users** — enqueues one Oban job per active user for the selected year. Progress is visible in real time.
- **Simulate for me** — runs the full pipeline for the logged-in admin synchronously and opens the result immediately for preview.
- **Post Community Wrapped** — creates a pinned forum post with a link to the Community Wrapped slideshow.
- **Intro message editor** — customises the opening slide of Community Wrapped and the community post body. Supports template variables: `[forum_name]`, `[year]`, `[total_posts]`, `[total_replies]`, `[total_reactions]`, `[new_members]`, `[active_members]`.

### Visibility tab

| Setting | Default | Description |
|---|---|---|
| Enable Wrapped | `true` | Enables or disables the extension globally |
| Share by default | `false` | Whether new Wrapped results are publicly visible by default |
| Minimum posts to qualify | `5` | Users with fewer posts than this threshold are skipped during generation |

### Content tab

| Setting | Default | Description |
|---|---|---|
| Forum name override | — | Overrides the site name used in banners and slide content. Leave blank to use the name from General settings |
| Show Gamepedia slide | `true` | Includes a slide showing the user's top games if they have Gamepedia activity |
| Show DMs slide | `true` | Includes a slide with direct message stats |

### Notifications tab

| Setting | Default | Description |
|---|---|---|
| Send notification email | `true` | Sends each member an email when their personal Wrapped is ready |

## How generation works

The scheduler wakes at the top of every minute and checks whether the configured date and time has been reached (exact minute match, not `>=`). When it fires, it:

1. Queries all users who had at least one login event during the target year
2. Skips users below the minimum posts threshold
3. Enqueues one Oban job per qualifying user on the `extensions` queue
4. Each job generates the user's stats, persists the result, fires the `wrapped_ready` in-app notification, and sends a notification email if configured
5. Generates the community aggregate result and persists it (activating the sidebar widget)
6. Creates the community forum post if a default space is configured

The scheduler guard (`already_generated?`) prevents re-triggering if results already exist for the year. Manual generation from the admin panel bypasses this guard, allowing admins to re-run or supplement a previous generation.

## Surfaces registered

| Surface | Details |
|---|---|
| Routes | `/ext/wrapped/`, `/ext/wrapped/community`, `/ext/wrapped/community/:year`, `/ext/wrapped/:year/:username` |
| Profile tab | **Wrapped** tab on all user profiles |
| Right widget | Community Wrapped sidebar widget (global scope) |
| Explore item | **Wrapped** entry in the left sidebar Explore section |
| Admin panel | Tabbed admin panel under the installed extensions sidebar |
| Notification type | `wrapped_ready` — web and email channels |
| Account action | **My Wrapped** in the account dropdown (January only) |

## License

MIT
