defmodule NexusWrapped.Scheduler do
  @moduledoc """
  Minute-resolution GenServer that auto-triggers Wrapped generation when the
  admin's configured date and time (in their chosen timezone) is reached.

  Wakes up at the top of every minute by calculating the exact milliseconds
  until the next minute boundary — so if you configure 11:00am, the scheduler
  fires at precisely 11:00am regardless of when the server last restarted.

  Pattern mirrors Nexus's own digest scheduler: a lightweight guard checks
  whether the moment has arrived, and the actual work is handed off to Oban.
  """

  use GenServer
  require Logger
  import Ecto.Query

  alias Nexus.Repo

  # ── Supervision ────────────────────────────────────────────────────────────

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    NexusWrapped.ensure_defaults()
    schedule_check()
    {:ok, %{}}
  end

  # ── Callbacks ─────────────────────────────────────────────────────────────

  @impl true
  def handle_info(:check, state) do
    try do
      maybe_generate()
    rescue
      e -> Logger.error("[NexusWrapped.Scheduler] error during check: #{inspect(e)}")
    end

    schedule_check()
    {:noreply, state}
  end

  # ── Core logic ────────────────────────────────────────────────────────────

  defp maybe_generate do
    ext      = Nexus.Extensions.get_extension_by_slug("wrapped")
    settings = if ext, do: ext.settings || %{}, else: %{}

    gen_date = settings["auto_generate_date"]
    gen_time = settings["auto_generate_time"] || "09:00"
    tz       = settings["auto_generate_timezone"] || "UTC"

    if is_nil(gen_date) or gen_date == "" do
      :skip
    else
      with {:ok, target_date} <- Date.from_iso8601(gen_date),
           true               <- should_run_now?(target_date, gen_time, tz) do
        year = target_date.year

        # TODO: guard commented out for testing — re-enable and improve before release
        # if already_generated?(year) do
        #   :skip
        # else
          Logger.info("[NexusWrapped.Scheduler] Auto-triggering generation for #{year}")
          enqueue_all(year, settings)
        # end
      else
        _ -> :skip
      end
    end
  end

  # Matches only the exact configured minute — not >= — so we fire once at
  # the configured moment, not every minute for the rest of that hour.
  defp should_run_now?(target_date, gen_time, tz) do
    [h_str, m_str] = String.split(gen_time, ":")
    target_hour   = String.to_integer(h_str)
    target_minute = String.to_integer(m_str)

    now_local =
      try do
        DateTime.utc_now() |> DateTime.shift_zone!(tz)
      rescue
        _ -> DateTime.utc_now()
      end

    DateTime.to_date(now_local) == target_date  and
      now_local.hour   == target_hour            and
      now_local.minute == target_minute
  end

  defp already_generated?(year) do
    Repo.exists?(
      from r in NexusWrapped.Result,
      where: r.year == ^year
    )
  end

  defp enqueue_all(year, settings) do
    user_ids = get_active_user_ids(year)

    # Build all changesets then insert in one bulk operation — far more
    # efficient than individual Oban.insert/1 calls for large forums.
    jobs = Enum.map(user_ids, fn user_id ->
      NexusWrapped.Worker.new(%{"user_id" => user_id, "year" => year})
    end)

    Oban.insert_all(jobs)

    Logger.info("[NexusWrapped.Scheduler] Enqueued #{length(user_ids)} user jobs for #{year}")

    generate_community(year, settings)
  end

  defp generate_community(year, settings) do
    try do
      data = NexusWrapped.Generator.generate_community(year, settings)
      now  = DateTime.utc_now() |> DateTime.truncate(:second)

      # Persist the community result row (activates the sidebar widget)
      community_result =
        case Repo.get_by(NexusWrapped.CommunityResult, year: year) do
          nil ->
            {:ok, result} =
              %NexusWrapped.CommunityResult{}
              |> NexusWrapped.CommunityResult.changeset(%{
                year:         year,
                data:         data,
                generated_at: now,
              })
              |> Repo.insert()
            result

          existing ->
            {:ok, result} =
              existing
              |> NexusWrapped.CommunityResult.changeset(%{
                data:         data,
                generated_at: now,
              })
              |> Repo.update()
            result
        end

      Logger.info("[NexusWrapped.Scheduler] Community Wrapped generated for #{year}")

      # Create the community forum post if a default space is configured
      maybe_create_community_post(community_result, data, year, settings)
    rescue
      e -> Logger.error("[NexusWrapped.Scheduler] Community generation failed: #{inspect(e)}")
    end
  end

  defp maybe_create_community_post(community_result, data, year, settings) do
    space_id =
      case settings["community_post_space_id"] do
        nil   -> nil
        ""    -> nil
        id when is_integer(id) -> id
        id when is_binary(id)  ->
          case Integer.parse(id) do
            {n, ""} -> n
            _       -> nil
          end
      end

    if is_nil(space_id) do
      Logger.info("[NexusWrapped.Scheduler] No community_post_space_id set — skipping post creation")
    else
      # Use the first admin user as the post author
      admin = Repo.one(
        from u in "users",
        where: u.role == "admin",
        order_by: [asc: u.id],
        limit: 1,
        select: struct(u, [:id, :username, :email, :role, :avatar_url, :avatar_color])
      )

      if is_nil(admin) do
        Logger.error("[NexusWrapped.Scheduler] No admin user found — cannot create community post")
      else
        body  = NexusWrapped.Generator.build_community_post_body(data, year)
        title = "#{year} Community Wrapped 🎉"

        case Nexus.Forum.create_post(
          %{"title" => title, "body" => body, "space_id" => space_id},
          admin,
          []
        ) do
          {:ok, post} ->
            Nexus.Forum.pin_post(post, true, "global")

            # Update CommunityResult with the post_id
            community_result
            |> NexusWrapped.CommunityResult.changeset(%{post_id: post.id})
            |> Repo.update()

            Logger.info("[NexusWrapped.Scheduler] Community post created (id=#{post.id}) for #{year}")

          {:error, changeset} ->
            errors = inspect(changeset.errors)
            Logger.error("[NexusWrapped.Scheduler] Community post creation failed: #{errors}")
        end
      end
    end
  end

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

  # Sleep until the top of the next minute by computing exact milliseconds
  # to the next minute boundary. This synchronizes the scheduler to wall
  # clock time so an 11:00am trigger always fires at 11:00am precisely.
  defp schedule_check do
    now_ms   = System.os_time(:millisecond)
    next_min = (div(now_ms, 60_000) + 1) * 60_000
    Process.send_after(self(), :check, next_min - now_ms)
  end
end
