defmodule NexusWrapped.Generator do
  @moduledoc """
  Builds the Wrapped stats blob for a single user and year.

  Queries only tables that already exist in Nexus's database.
  Gamepedia stats are collected conditionally — they are skipped
  (left as nil) when the wrapped extension setting show_gamepedia_slide
  is false, or when the wrapped_gamepedia_games table does not exist.

  All returned maps use string keys so they serialise cleanly to JSONB
  and arrive on the frontend without any atom-vs-string confusion.
  """

  import Ecto.Query
  alias Nexus.Repo

  # ── Public entry point ────────────────────────────────────────────────────

  @doc """
  Generate and persist a Wrapped result for `user_id` and `year`.
  Returns `{:ok, result}` or `{:error, reason}`.
  """
  def generate(user_id, year, settings \\ %{}) do
    data = build_stats(user_id, year, settings)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case Repo.get_by(NexusWrapped.Result, user_id: user_id, year: year) do
      nil ->
        %NexusWrapped.Result{}
        |> NexusWrapped.Result.changeset(%{
          user_id:      user_id,
          year:         year,
          data:         data,
          generated_at: now,
        })
        |> Repo.insert()

      existing ->
        existing
        |> NexusWrapped.Result.changeset(%{
          data:         data,
          generated_at: now,
        })
        |> Repo.update()
    end
  end

  # ── Stats assembly ────────────────────────────────────────────────────────

  defp build_stats(user_id, year, settings) do
    from_date = Date.new!(year, 1, 1)
    to_date   = Date.new!(year, 12, 31)

    %{}
    |> Map.merge(core_stats(user_id, from_date, to_date))
    |> Map.merge(timing_stats(user_id, from_date, to_date))
    |> Map.merge(post_stats(user_id, from_date, to_date))
    |> Map.merge(reaction_stats(user_id, from_date, to_date))
    |> Map.merge(space_stats(user_id, from_date, to_date))
    |> Map.merge(badge_stats(user_id, from_date, to_date))
    |> Map.merge(leaderboard_stats(user_id))
    |> Map.merge(save_stats(user_id, from_date, to_date))
    |> maybe_merge(dm_stats(user_id, from_date, to_date),       settings["show_dms_slide"] != false)
    |> maybe_merge(gamepedia_stats(user_id, year),               settings["show_gamepedia_slide"] != false)
    |> then(fn stats -> Map.put(stats, "milestones", evaluate_milestones(stats)) end)
  end

  defp maybe_merge(base, extra, true),  do: Map.merge(base, extra)
  defp maybe_merge(base, _extra, false), do: base

  # ── Core activity ─────────────────────────────────────────────────────────

  defp core_stats(user_id, from_date, to_date) do
    totals =
      Repo.one(
        from s in "user_daily_stats",
        where: s.user_id == ^user_id and s.date >= ^from_date and s.date <= ^to_date,
        select: %{
          posts_count:         coalesce(sum(s.posts_count), 0),
          replies_count:       coalesce(sum(s.replies_count), 0),
          reactions_given:     coalesce(sum(s.reactions_given), 0),
          reactions_received:  coalesce(sum(s.reactions_received), 0),
          active_days:         count(s.date),
        }
      ) || %{posts_count: 0, replies_count: 0, reactions_given: 0,
              reactions_received: 0, active_days: 0}

    # Login events for the heatmap — one entry per active day
    active_dates =
      Repo.all(
        from e in "login_events",
        where: e.user_id == ^user_id
          and fragment("?::date", e.inserted_at) >= ^from_date
          and fragment("?::date", e.inserted_at) <= ^to_date,
        select: fragment("?::date", e.inserted_at),
        distinct: true,
        order_by: fragment("?::date", e.inserted_at)
      )
      |> Enum.map(&Date.to_string/1)

    # Posts per month — 12-element list [jan, feb, ..., dec]
    monthly =
      Repo.all(
        from s in "user_daily_stats",
        where: s.user_id == ^user_id and s.date >= ^from_date and s.date <= ^to_date,
        group_by: fragment("date_part('month', ?)", s.date),
        select: {
          fragment("date_part('month', ?)::int", s.date),
          coalesce(sum(s.posts_count) + sum(s.replies_count), 0)
        }
      )

    monthly_map = Map.new(monthly, fn {m, c} -> {m, c} end)
    posts_per_month = Enum.map(1..12, fn m -> monthly_map[m] || 0 end)

    # Streak — read directly from the users table (maintained by ActivityTracker)
    streak_data =
      Repo.one(
        from u in "users",
        where: u.id == ^user_id,
        select: %{
          current_streak: u.current_streak,
          longest_streak: u.longest_streak,
        }
      ) || %{current_streak: 0, longest_streak: 0}

    %{
      "posts_count"        => totals.posts_count,
      "replies_count"      => totals.replies_count,
      "reactions_given"    => totals.reactions_given,
      "reactions_received" => totals.reactions_received,
      "active_days"        => totals.active_days,
      "active_dates"       => active_dates,
      "posts_per_month"    => posts_per_month,
      "current_streak"     => streak_data.current_streak || 0,
      "longest_streak"     => streak_data.longest_streak || 0,
    }
  end

  # ── Timing patterns ───────────────────────────────────────────────────────

  defp timing_stats(user_id, from_date, to_date) do
    # Pull hour and day-of-week from login_events for the year
    events =
      Repo.all(
        from e in "login_events",
        where: e.user_id == ^user_id
          and fragment("?::date", e.inserted_at) >= ^from_date
          and fragment("?::date", e.inserted_at) <= ^to_date,
        select: %{
          hour: fragment("date_part('hour', ?)::int", e.inserted_at),
          dow:  fragment("date_part('dow', ?)::int",  e.inserted_at),
        }
      )

    if Enum.empty?(events) do
      %{
        "most_active_hour"    => 0,
        "most_active_dow"     => 0,
        "night_owl_score"     => 0.0,
        "early_bird_score"    => 0.0,
        "weekend_score"       => 0.0,
        "hour_distribution"   => List.duplicate(0, 24),
        "dow_distribution"    => List.duplicate(0, 7),
      }
    else
      total = length(events)

      hour_counts = Enum.reduce(events, List.to_tuple(List.duplicate(0, 24)), fn e, acc ->
        h = e.hour || 0
        put_elem(acc, h, elem(acc, h) + 1)
      end)

      dow_counts = Enum.reduce(events, List.to_tuple(List.duplicate(0, 7)), fn e, acc ->
        d = e.dow || 0
        put_elem(acc, d, elem(acc, d) + 1)
      end)

      most_active_hour =
        hour_counts
        |> Tuple.to_list()
        |> Enum.with_index()
        |> Enum.max_by(fn {c, _} -> c end)
        |> elem(1)

      most_active_dow =
        dow_counts
        |> Tuple.to_list()
        |> Enum.with_index()
        |> Enum.max_by(fn {c, _} -> c end)
        |> elem(1)

      # Night owl: 22:00–03:59
      night_owl_count = Enum.count(events, fn e ->
        h = e.hour || 0
        h >= 22 or h <= 3
      end)

      # Early bird: 05:00–08:59
      early_bird_count = Enum.count(events, fn e ->
        h = e.hour || 0
        h >= 5 and h <= 8
      end)

      # Weekend: Saturday (6) or Sunday (0)
      weekend_count = Enum.count(events, fn e ->
        d = e.dow || 0
        d == 0 or d == 6
      end)

      pct = fn n -> if total > 0, do: Float.round(n / total * 100, 1), else: 0.0 end

      %{
        "most_active_hour"    => most_active_hour,
        "most_active_dow"     => most_active_dow,
        "night_owl_score"     => pct.(night_owl_count),
        "early_bird_score"    => pct.(early_bird_count),
        "weekend_score"       => pct.(weekend_count),
        "hour_distribution"   => Tuple.to_list(hour_counts),
        "dow_distribution"    => Tuple.to_list(dow_counts),
      }
    end
  end

  # ── Post / discussion stats ───────────────────────────────────────────────

  defp post_stats(user_id, from_date, to_date) do
    # First and last post of the year
    first_post =
      Repo.one(
        from p in "posts",
        where: p.user_id == ^user_id
          and fragment("?::date", p.inserted_at) >= ^from_date
          and fragment("?::date", p.inserted_at) <= ^to_date
          and p.hidden == false,
        order_by: [asc: p.inserted_at],
        limit: 1,
        select: %{id: p.id, title: p.title, inserted_at: p.inserted_at}
      )

    last_post =
      Repo.one(
        from p in "posts",
        where: p.user_id == ^user_id
          and fragment("?::date", p.inserted_at) >= ^from_date
          and fragment("?::date", p.inserted_at) <= ^to_date
          and p.hidden == false,
        order_by: [desc: p.inserted_at],
        limit: 1,
        select: %{id: p.id, title: p.title, inserted_at: p.inserted_at}
      )

    # Top post by reaction count
    top_post =
      Repo.one(
        from p in "posts",
        where: p.user_id == ^user_id
          and fragment("?::date", p.inserted_at) >= ^from_date
          and fragment("?::date", p.inserted_at) <= ^to_date
          and p.hidden == false,
        order_by: [desc: p.reaction_count],
        limit: 1,
        select: %{
          id:             p.id,
          title:          p.title,
          reaction_count: p.reaction_count,
          reply_count:    p.reply_count,
        }
      )

    %{
      "first_post" => format_post(first_post),
      "last_post"  => format_post(last_post),
      "top_post"   => format_post(top_post),
    }
  end

  defp format_post(nil), do: nil
  defp format_post(p) do
    Map.new(p, fn {k, v} ->
      key = if is_atom(k), do: Atom.to_string(k), else: k
      val = case v do
        %DateTime{} = dt -> DateTime.to_iso8601(dt)
        %NaiveDateTime{} = ndt -> NaiveDateTime.to_iso8601(ndt)
        other -> other
      end
      {key, val}
    end)
  end

  # ── Reaction stats ────────────────────────────────────────────────────────

  defp reaction_stats(user_id, from_date, to_date) do
    # Reactions received on this user's posts — grouped by emoji
    received_breakdown =
      Repo.all(
        from r in "reactions",
        join: p in "posts", on: p.id == r.post_id,
        where: p.user_id == ^user_id
          and fragment("?::date", r.inserted_at) >= ^from_date
          and fragment("?::date", r.inserted_at) <= ^to_date,
        group_by: r.emoji,
        select: %{emoji: r.emoji, count: count(r.id)},
        order_by: [desc: count(r.id)]
      )
      |> Enum.map(&stringify_map/1)

    # Reactions received on replies too
    received_replies_breakdown =
      Repo.all(
        from r in "reactions",
        join: reply in "replies", on: reply.id == r.reply_id,
        where: reply.user_id == ^user_id
          and fragment("?::date", r.inserted_at) >= ^from_date
          and fragment("?::date", r.inserted_at) <= ^to_date,
        group_by: r.emoji,
        select: %{emoji: r.emoji, count: count(r.id)},
        order_by: [desc: count(r.id)]
      )

    # Merge post + reply breakdowns
    all_received =
      (received_breakdown ++ Enum.map(received_replies_breakdown, &stringify_map/1))
      |> Enum.group_by(& &1["emoji"])
      |> Enum.map(fn {emoji, entries} ->
        %{"emoji" => emoji, "count" => Enum.sum(Enum.map(entries, & &1["count"]))}
      end)
      |> Enum.sort_by(& -&1["count"])

    total_received = Enum.sum(Enum.map(all_received, & &1["count"]))

    # Reactions given by this user
    given_breakdown =
      Repo.all(
        from r in "reactions",
        where: r.user_id == ^user_id
          and fragment("?::date", r.inserted_at) >= ^from_date
          and fragment("?::date", r.inserted_at) <= ^to_date,
        group_by: r.emoji,
        select: %{emoji: r.emoji, count: count(r.id)},
        order_by: [desc: count(r.id)]
      )
      |> Enum.map(&stringify_map/1)

    favourite_given = List.first(given_breakdown)

    # Person who reacted to this user the most
    top_reactor =
      Repo.one(
        from r in "reactions",
        join: p in "posts", on: p.id == r.post_id,
        join: u in "users", on: u.id == r.user_id,
        where: p.user_id == ^user_id
          and r.user_id != ^user_id
          and fragment("?::date", r.inserted_at) >= ^from_date
          and fragment("?::date", r.inserted_at) <= ^to_date,
        group_by: [r.user_id, u.username, u.avatar_url, u.avatar_color],
        select: %{
          user_id:      r.user_id,
          username:     u.username,
          avatar_url:   u.avatar_url,
          avatar_color: u.avatar_color,
          count:        count(r.id),
        },
        order_by: [desc: count(r.id)],
        limit: 1
      )

    %{
      "reactions_received_breakdown" => all_received,
      "reactions_received_total"     => total_received,
      "reactions_given_breakdown"    => given_breakdown,
      "reactions_given_total"        => Enum.sum(Enum.map(given_breakdown, & &1["count"])),
      "favourite_reaction_given"     => favourite_given,
      "top_reactor"                  => format_post(top_reactor),
    }
  end

  # ── Space stats ───────────────────────────────────────────────────────────

  defp space_stats(user_id, from_date, to_date) do
    spaces =
      Repo.all(
        from p in "posts",
        join: s in "spaces", on: s.id == p.space_id,
        where: p.user_id == ^user_id
          and fragment("?::date", p.inserted_at) >= ^from_date
          and fragment("?::date", p.inserted_at) <= ^to_date
          and p.hidden == false,
        group_by: [p.space_id, s.name, s.slug],
        select: %{
          space_id:   p.space_id,
          name:       s.name,
          slug:       s.slug,
          post_count: count(p.id),
        },
        order_by: [desc: count(p.id)]
      )
      |> Enum.map(&stringify_map/1)

    top_space    = List.first(spaces)
    total_posts  = Enum.sum(Enum.map(spaces, & &1["post_count"]))

    top_space_pct =
      if top_space && total_posts > 0 do
        Float.round(top_space["post_count"] / total_posts * 100, 1)
      else
        0.0
      end

    %{
      "top_space"         => top_space,
      "top_space_pct"     => top_space_pct,
      "spaces_breakdown"  => spaces,
    }
  end

  # ── Badge stats ───────────────────────────────────────────────────────────

  defp badge_stats(user_id, from_date, to_date) do
    badges_this_year =
      Repo.all(
        from ub in "user_badges",
        join: b in "badges", on: b.id == ub.badge_id,
        where: ub.user_id == ^user_id
          and fragment("?::date", ub.awarded_at) >= ^from_date
          and fragment("?::date", ub.awarded_at) <= ^to_date,
        select: %{
          badge_id:    b.id,
          name:        b.name,
          description: b.description,
          icon:        b.icon,
          color:       b.color,
          rarity:      b.rarity,
          awarded_at:  ub.awarded_at,
        },
        order_by: [asc: ub.awarded_at]
      )
      |> Enum.map(&stringify_map/1)
      |> Enum.map(fn b ->
        Map.update(b, "awarded_at", nil, fn
          %DateTime{} = dt      -> DateTime.to_iso8601(dt)
          %NaiveDateTime{} = ndt -> NaiveDateTime.to_iso8601(ndt)
          other                  -> other
        end)
      end)

    %{
      "badges_earned_count" => length(badges_this_year),
      "badges_earned"       => badges_this_year,
    }
  end

  # ── Leaderboard stats ─────────────────────────────────────────────────────

  defp leaderboard_stats(user_id) do
    # Mirror Nexus.Leaderboard.get_user_rank/2 — fetch own score, then count
    # users with a higher score. user_scores has no inserted_at; only updated_at.
    user_score =
      Repo.one(
        from s in "user_scores",
        where: s.user_id == ^user_id,
        select: s.score_all
      ) || 0

    rank_all =
      Repo.one(
        from s in "user_scores",
        join: u in "users", on: u.id == s.user_id,
        where: u.status != "banned",
        where: s.score_all > ^user_score,
        select: count(s.user_id)
      ) + 1

    %{
      "leaderboard_score" => user_score,
      "leaderboard_rank"  => rank_all,
    }
  end

  # ── Saves / bookmarks ─────────────────────────────────────────────────────

  defp save_stats(user_id, from_date, to_date) do
    # post_saves has no standard timestamps() — inserted_at is an explicit
    # :utc_datetime field, not a NaiveDateTime. Cast to date via fragment.
    saves_count =
      Repo.aggregate(
        from(s in "post_saves",
          where: s.user_id == ^user_id
            and fragment("?::date", s.inserted_at) >= ^from_date
            and fragment("?::date", s.inserted_at) <= ^to_date
        ),
        :count
      )

    %{"saves_count" => saves_count}
  end

  # ── DM stats ──────────────────────────────────────────────────────────────

  defp dm_stats(user_id, from_date, to_date) do
    messages_sent =
      Repo.aggregate(
        from(m in "messages",
          where: m.user_id == ^user_id
            and fragment("?::date", m.inserted_at) >= ^from_date
            and fragment("?::date", m.inserted_at) <= ^to_date
        ),
        :count
      )

    # distinct with aggregate on a raw table name requires an explicit subquery
    unique_threads =
      Repo.one(
        from m in "messages",
        where: m.user_id == ^user_id
          and fragment("?::date", m.inserted_at) >= ^from_date
          and fragment("?::date", m.inserted_at) <= ^to_date,
        select: count(m.thread_id, :distinct)
      )

    %{
      "dms_sent"         => messages_sent,
      "dm_threads_count" => unique_threads || 0,
    }
  end

  # ── Gamepedia stats (conditional) ─────────────────────────────────────────

  defp gamepedia_stats(user_id, year) do
    # Only run if the wrapped_gamepedia_game_logs table exists.
    # Gamepedia is an in-VM extension that creates its own tables.
    # We query by table name directly rather than referencing its schemas
    # to avoid compile-time coupling (Gamepedia may not be installed).
    if gamepedia_available?() do
      collect_gamepedia_stats(user_id, year)
    else
      %{
        "gamepedia_available" => false,
        "gamepedia_games"     => [],
        "gamepedia_count"     => 0,
      }
    end
  end

  defp gamepedia_available? do
    # Check if Gamepedia's game_logs table exists in the database
    result =
      Repo.query!(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gamepedia_game_logs')",
        []
      )
    [[exists]] = result.rows
    exists
  rescue
    _ -> false
  end

  defp collect_gamepedia_stats(user_id, _year) do
    # ── Gamelog: games this user has added (all time) ──────────────────────
    # gamepedia_gamelogs: user_id, game_id, is_playing, inserted_at
    # gamepedia_games:    id, name, slug, cover_image_url, first_release_date, developer
    # gamepedia_ratings:  user_id, game_id, rating (separate table)
    # gamepedia_game_genre + gamepedia_genres: genre join

    gamelog_games =
      Repo.all(
        from gl in "gamepedia_gamelogs",
        join: g in "gamepedia_games", on: g.id == gl.game_id,
        where: gl.user_id == ^user_id,
        order_by: [desc: gl.inserted_at],
        select: %{
          id:               g.id,
          name:             g.name,
          slug:             g.slug,
          cover_image_url:  g.cover_image_url,
          is_playing:       gl.is_playing,
          inserted_at:      gl.inserted_at,
        }
      )
      |> Enum.map(&stringify_map/1)

    gamelog_count = length(gamelog_games)

    currently_playing =
      Enum.find(gamelog_games, & &1["is_playing"])

    # Top genre from gamelog (via game_genre join)
    top_genre =
      Repo.one(
        from gen in "gamepedia_genres",
        join: gg in "gamepedia_game_genre", on: gg.genre_id == gen.id,
        join: gl in "gamepedia_gamelogs",   on: gl.game_id == gg.game_id,
        where: gl.user_id == ^user_id,
        group_by: [gen.id, gen.name],
        order_by: [desc: count(gen.id)],
        limit: 1,
        select: gen.name
      )

    # Top rated game by this user
    top_rated =
      Repo.one(
        from r in "gamepedia_ratings",
        join: g in "gamepedia_games", on: g.id == r.game_id,
        where: r.user_id == ^user_id,
        order_by: [desc: r.rating],
        limit: 1,
        select: %{
          id:              g.id,
          name:            g.name,
          slug:            g.slug,
          cover_image_url: g.cover_image_url,
          rating:          r.rating,
        }
      )
      |> then(fn r -> if r, do: stringify_map(r), else: nil end)

    # ── Most discussed: games with most posts linked (all time) ────────────
    # gamepedia_post_game: post_id, game_id
    # Join against nexus posts table to count posts by this user specifically,
    # and overall post count for the game.
    most_discussed =
      Repo.all(
        from pg in "gamepedia_post_game",
        join: g in "gamepedia_games", on: g.id == pg.game_id,
        group_by: [g.id, g.name, g.slug, g.cover_image_url],
        order_by: [desc: count(pg.post_id)],
        limit: 5,
        select: %{
          id:              g.id,
          name:            g.name,
          slug:            g.slug,
          cover_image_url: g.cover_image_url,
          post_count:      count(pg.post_id),
        }
      )
      |> Enum.map(&stringify_map/1)

    # Posts this specific user wrote that are linked to games
    user_most_discussed =
      Repo.all(
        from pg in "gamepedia_post_game",
        join: g in "gamepedia_games",  on: g.id == pg.game_id,
        join: p in "posts",            on: p.id == pg.post_id,
        where: p.user_id == ^user_id and p.hidden == false,
        group_by: [g.id, g.name, g.slug, g.cover_image_url],
        order_by: [desc: count(pg.post_id)],
        limit: 5,
        select: %{
          id:              g.id,
          name:            g.name,
          slug:            g.slug,
          cover_image_url: g.cover_image_url,
          post_count:      count(pg.post_id),
        }
      )
      |> Enum.map(&stringify_map/1)

    %{
      "gamepedia_available"       => true,
      "gamepedia_count"           => gamelog_count,
      "gamepedia_games"           => Enum.take(gamelog_games, 12),
      "gamepedia_top_genre"       => top_genre,
      "gamepedia_top_rated"       => top_rated,
      "gamepedia_now_playing"     => currently_playing,
      "gamepedia_most_discussed"  => most_discussed,
      "gamepedia_user_discussed"  => user_most_discussed,
    }
  end


  # ── Milestones ────────────────────────────────────────────────────────────

  defp evaluate_milestones(stats) do
    []
    |> maybe_milestone("centurion",   stats["posts_count"]     >= 100)
    |> maybe_milestone("prolific",    stats["posts_count"]     >= 500)
    |> maybe_milestone("unstoppable", stats["posts_count"]     >= 1000)
    |> maybe_milestone("daily_regular", stats["active_days"]   >= 100)
    |> maybe_milestone("streak_7",    stats["longest_streak"]  >= 7)
    |> maybe_milestone("streak_30",   stats["longest_streak"]  >= 30)
    |> maybe_milestone("streak_100",  stats["longest_streak"]  >= 100)
    |> maybe_milestone("night_owl",   (stats["night_owl_score"] || 0.0) >= 40.0)
    |> maybe_milestone("early_bird",  (stats["early_bird_score"] || 0.0) >= 40.0)
    |> maybe_milestone("weekend_warrior", (stats["weekend_score"] || 0.0) >= 50.0)
    |> maybe_milestone("popular",     (stats["reactions_received_total"] || 0) >= 50)
    |> maybe_milestone("generous",    (stats["reactions_given_total"] || 0) >= 100)
    |> maybe_milestone("collector",   (stats["saves_count"] || 0) >= 20)
    |> maybe_milestone("communicator",(stats["dms_sent"] || 0) >= 50)
    |> maybe_milestone("badge_hunter",(stats["badges_earned_count"] || 0) >= 3)
    |> maybe_milestone("top_10",      match_rank(stats["leaderboard_rank"], 10))
    |> Enum.reverse()
  end

  defp maybe_milestone(list, key, true),  do: [key | list]
  defp maybe_milestone(list, _key, false), do: list

  defp match_rank(nil, _), do: false
  defp match_rank(rank, threshold), do: rank <= threshold

  # ── Helpers ───────────────────────────────────────────────────────────────

  defp stringify_map(map) when is_map(map) do
    Map.new(map, fn {k, v} ->
      key = if is_atom(k), do: Atom.to_string(k), else: k
      val = case v do
        %DateTime{} = dt      -> DateTime.to_iso8601(dt)
        %NaiveDateTime{} = ndt -> NaiveDateTime.to_iso8601(ndt)
        other                  -> other
      end
      {key, val}
    end)
  end
end
