defmodule NexusWrapped.AdminController do
  use Phoenix.Controller, formats: [:json]

  import Plug.Conn
  import Ecto.Query

  alias Nexus.Repo

  # ── POST /admin/generate — enqueue all active users ──────────────────────

  def generate_all(conn, params) do
    year     = parse_year(params["year"])
    user_ids = get_active_user_ids(year)
    total    = length(user_ids)

    Enum.each(user_ids, fn user_id ->
      %{"user_id" => user_id, "year" => year}
      |> NexusWrapped.Worker.new()
      |> Oban.insert()
    end)

    json(conn, %{data: %{enqueued: total, year: year}})
  end

  # ── POST /admin/generate/:user_id — enqueue a single user ────────────────

  def generate_one(conn, params) do
    user_id = String.to_integer(params["user_id"])
    year    = parse_year(params["year"])

    %{"user_id" => user_id, "year" => year}
    |> NexusWrapped.Worker.new()
    |> Oban.insert()

    json(conn, %{data: %{enqueued: 1, user_id: user_id, year: year}})
  end

  # ── POST /admin/simulate — run the full pipeline for the requesting admin ─
  #
  # Runs synchronously (no Oban queue) so the admin sees the result
  # immediately and can navigate to their own Wrapped to preview it.
  # Uses the identical generator pipeline as the batch year-end run.

  def simulate(conn, params) do
    admin    = conn.assigns.current_user
    year     = parse_year(params["year"])
    ext      = Nexus.Extensions.get_extension_by_slug("wrapped")
    settings = if ext, do: ext.settings || %{}, else: %{}

    case NexusWrapped.Generator.generate(admin.id, year, settings) do
      {:ok, result} ->
        share = Repo.get_by(NexusWrapped.Share, user_id: admin.id, year: year)

        # For simulate, bypass Oban entirely — insert and broadcast directly.
        # notify_extension enqueues an Oban job with unique: [period: 30],
        # so repeated simulates within 30s are silently deduped at the job level.
        # Direct insert + PubSub broadcast guarantees the notification fires every time.
        data = %{
          "ext_type" => "wrapped_ready",
          "year"     => year,
          "username" => admin.username
        }

        case Nexus.Notifications.create_notification(%{
          type:    "extension",
          user_id: admin.id,
          data:    data
        }) do
          {:ok, notif} ->
            Phoenix.PubSub.broadcast(
              Nexus.PubSub,
              "notifications:#{admin.id}",
              {:new_notification, %{
                id:           notif.id,
                type:         "extension",
                read:         false,
                data:         data,
                group_count:  1,
                group_actors: [],
                inserted_at:  notif.inserted_at,
                actor:        nil,
                post_id:      nil,
                reply_id:     nil,
                message_id:   nil,
              }}
            )

            unread = Nexus.Notifications.unread_count(admin.id)
            Phoenix.PubSub.broadcast(
              Nexus.PubSub,
              "notifications:#{admin.id}",
              {:unread_count, unread}
            )

          _ -> :ok
        end

        json(conn, %{
          data: %{
            year:      year,
            username:  admin.username,
            is_owner:  true,
            is_shared: (share && share.shared) || false,
            current:   result.data,
            previous:  nil,
          }
        })

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{error: "Generation failed: #{inspect(reason)}"})
    end
  end

  # ── GET /admin/status/:year — generation progress ─────────────────────────

  def generation_status(conn, %{"year" => year_str}) do
    year          = String.to_integer(year_str)
    total_active  = length(get_active_user_ids(year))
    generated     = Repo.aggregate(from(r in NexusWrapped.Result, where: r.year == ^year), :count)

    pending =
      Repo.aggregate(
        from(j in "oban_jobs",
          where: j.worker == "Elixir.NexusWrapped.Worker"
            and fragment("?->>'year'", j.args) == ^to_string(year)
            and j.state in ["available", "executing", "scheduled", "retryable"]
        ),
        :count
      )

    json(conn, %{
      data: %{
        year:         year,
        total_active: total_active,
        generated:    generated,
        pending:      pending,
        pct_complete: if(total_active > 0, do: Float.round(generated / total_active * 100, 1), else: 0.0),
      }
    })
  rescue
    e ->
      require Logger
      Logger.error("NexusWrapped generation_status error: #{inspect(e)}")
      conn
      |> put_status(200)
      |> json(%{data: %{year: String.to_integer(year_str), total_active: 0,
                        generated: 0, pending: 0, pct_complete: 0.0,
                        error: "Could not load status — check that migrations ran correctly"}})
  end

  # ── POST /admin/community_post — generate community stats & post to forum ──

  def community_post(conn, params) do
    admin    = conn.assigns.current_user
    year     = parse_year(params["year"])
    ext      = Nexus.Extensions.get_extension_by_slug("wrapped")
    settings = if ext, do: ext.settings || %{}, else: %{}

    space_id = parse_space_id(params["space_id"] || settings["community_post_space_id"])

    if is_nil(space_id) do
      conn |> put_status(400) |> json(%{error: "space_id is required"})
    else
      data = NexusWrapped.Generator.generate_community(year, settings)

      # Generate and save the banner SVG
      svg_content = NexusWrapped.Generator.generate_community_banner(data, settings)
      banner_url  = save_community_banner(svg_content, year)

      # Build the community Wrapped route URL
      wrapped_url = "/ext/wrapped/community/#{year}"

      # Build the post body — thank you message, teaser stats, linked banner card
      body = build_community_post_body(data, year, banner_url, wrapped_url, settings)
      title = "#{year} Community Wrapped 🎉"

      case Nexus.Forum.create_post(
        %{"title" => title, "body" => body, "space_id" => space_id},
        admin,
        []
      ) do
        {:ok, post} ->
          # Pin globally — appears at the top of every space and the feed
          Nexus.Forum.pin_post(post, true, "global")

          # Persist community result
          now = DateTime.utc_now() |> DateTime.truncate(:second)
          case Repo.get_by(NexusWrapped.CommunityResult, year: year) do
            nil ->
              %NexusWrapped.CommunityResult{}
              |> NexusWrapped.CommunityResult.changeset(%{
                year: year, data: data, post_id: post.id, generated_at: now
              })
              |> Repo.insert()
            existing ->
              existing
              |> NexusWrapped.CommunityResult.changeset(%{
                data: data, post_id: post.id, generated_at: now
              })
              |> Repo.update()
          end

          json(conn, %{data: %{post_id: post.id, title: post.title, year: year}})

        {:error, changeset} ->
          errors = Ecto.Changeset.traverse_errors(changeset, fn {msg, _} -> msg end)
          conn |> put_status(422) |> json(%{error: "Failed to create post", details: errors})
      end
    end
  end

  # ── GET /admin/community_status — check if a community post exists ─────────

  def community_status(conn, params) do
    year = parse_year(params["year"])
    result = Repo.get_by(NexusWrapped.CommunityResult, year: year)

    json(conn, %{
      data: %{
        year:        year,
        exists:      !is_nil(result),
        post_id:     result && result.post_id,
        generated_at: result && DateTime.to_iso8601(result.generated_at),
      }
    })
  end

  # ── Helpers ───────────────────────────────────────────────────────────────

  defp parse_space_id(nil), do: nil
  defp parse_space_id(id) when is_integer(id), do: id
  defp parse_space_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} -> n
      _       -> nil
    end
  end

  defp save_community_banner(svg_content, year) do
    Nexus.Extensions.Storage.ensure_dir("wrapped", "banners")
    filename = "community-#{year}.svg"
    path     = Nexus.Extensions.Storage.path("wrapped", "banners/#{filename}")
    File.write!(path, svg_content)
    Nexus.Extensions.Storage.url("wrapped", "banners/#{filename}")
  end

  defp build_community_post_body(data, year, banner_url, wrapped_url, settings) do
    forum_name = case settings["forum_name_override"] do
      name when is_binary(name) and name != "" -> String.trim(name)
      _ ->
        case Nexus.Admin.get_setting("general") do
          %{"site_name" => n} when is_binary(n) and n != "" -> n
          _ -> "our community"
        end
    end

    top_posters = data["top_posters"] || []
    top_spaces  = data["top_spaces"]  || []
    discussed   = data["most_discussed"]

    # YoY teasers — only show if we have previous year data to compare
    teasers = build_teasers(data)

    poster_lines = top_posters
      |> Enum.with_index(1)
      |> Enum.map(fn {p, i} -> "#{i}. **@#{p["username"]}** — #{p["post_count"]} posts" end)
      |> Enum.join("\n")

    space_lines = top_spaces
      |> Enum.map(fn s -> "- **#{s["name"]}** — #{s["post_count"]} posts" end)
      |> Enum.join("\n")

    discussed_section = if discussed do
      "\n## 🏆 Most Discussed Thread\n\n[#{discussed["title"]}](/posts/#{discussed["id"]}) — #{discussed["reply_count"]} replies\n"
    else
      ""
    end

    teaser_section = if teasers != "" do
      "\n#{teasers}\n"
    else
      ""
    end

    """
    #{year} was an incredible year for #{forum_name}. Thank you to every member who showed up, shared their thoughts, started conversations, and made this place what it is. Every post, every reply, every reaction — it all adds up to something genuinely special. This community exists because of you. 🙏
    #{teaser_section}
    ---

    [![View the #{year} Community Wrapped](#{banner_url})](#{wrapped_url})

    ---

    ## 📊 By the Numbers

    | | |
    |---|---|
    | Total posts | **#{data["total_posts"]}** |
    | Total replies | **#{data["total_replies"]}** |
    | Reactions given | **#{data["total_reactions"]}** |
    | New members | **#{data["new_members"]}** |
    | Active members | **#{data["active_members"]}** |

    ## 🌟 Top Contributors

    #{poster_lines}

    ## 🏠 Most Active Spaces

    #{space_lines}
    #{discussed_section}
    ---

    *Your personal #{year} Wrapped is waiting on your profile — check the Wrapped tab to see your own year in review.*
    """
    |> String.trim()
  end

  defp build_teasers(data) do
    prev_posts   = data["prev_total_posts"]    || 0
    prev_members = data["prev_active_members"] || 0
    curr_posts   = data["total_posts"]         || 0
    curr_members = data["active_members"]      || 0

    lines =
      [
        yoy_teaser(curr_posts,   prev_posts,   "posts written",   "📝"),
        yoy_teaser(curr_members, prev_members, "active members",  "👥"),
      ]
      |> Enum.filter(& &1)

    Enum.join(lines, "\n")
  end

  defp yoy_teaser(current, prev, label, icon) when prev > 0 do
    pct = round((current - prev) / prev * 100)
    cond do
      pct > 0  -> "#{icon} **#{pct}% more #{label}** than last year"
      pct < 0  -> "#{icon} **#{abs(pct)}% fewer #{label}** than last year"
      true     -> nil
    end
  end
  defp yoy_teaser(_, _, _, _), do: nil
  defp parse_year(nil),     do: Date.utc_today().year
  defp parse_year(y) when is_integer(y), do: y
  defp parse_year(y) when is_binary(y),  do: String.to_integer(y)

  # Active users for a year = at least one login event in that calendar year
  defp get_active_user_ids(year) do
    from_date = Date.new!(year, 1, 1)
    to_date   = Date.new!(year, 12, 31)

    Repo.all(
      from e in "login_events",
      where: fragment("?::date", e.inserted_at) >= ^from_date
        and  fragment("?::date", e.inserted_at) <= ^to_date,
      select: e.user_id,
      distinct: true
    )
  end
end
