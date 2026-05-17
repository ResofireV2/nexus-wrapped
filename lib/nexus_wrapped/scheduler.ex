defmodule NexusWrapped.Scheduler do
  @moduledoc """
  Hourly GenServer that auto-triggers Wrapped generation when the admin's
  configured date and time (in their chosen timezone) is reached.

  Pattern mirrors Nexus's own digest scheduler: the cron fires frequently,
  a lightweight guard function checks whether the moment has arrived, and
  the actual work is handed off to Oban so it runs exactly once.
  """

  use GenServer
  require Logger
  import Ecto.Query

  alias Nexus.Repo

  @check_interval :timer.minutes(60)

  # ── Supervision ────────────────────────────────────────────────────────────

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    # Ensure all settings have their defaults written to the database.
    # Handles both fresh installs (on_install covers those) and existing installs
    # that predate a newly added setting key.
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
    ext = Nexus.Extensions.get_extension_by_slug("wrapped")
    settings = if ext, do: ext.settings || %{}, else: %{}

    gen_date = settings["auto_generate_date"]
    gen_time = settings["auto_generate_time"] || "09:00"
    tz       = settings["auto_generate_timezone"] || "UTC"

    # Nothing configured — nothing to do
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

  # True when the current moment (in the admin's timezone) matches the
  # configured date and falls within the configured hour window.
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

    date_match   = DateTime.to_date(now_local) == target_date
    hour_match   = now_local.hour == target_hour
    # Allow a 59-minute window within the configured hour so a missed tick
    # (e.g. restart during that hour) still fires.
    minute_match = now_local.minute >= target_minute

    date_match and hour_match and minute_match
  end

  # True if generation has already run for this year — prevents the scheduler
  # from re-enqueueing on subsequent hourly ticks within the same trigger window.
  # Uses the Result schema (wrapped_results table) so it catches any completed work.
  defp already_generated?(year) do
    Repo.exists?(
      from r in NexusWrapped.Result,
      where: r.year == ^year
    )
  end

  defp enqueue_all(year, settings) do
    user_ids = get_active_user_ids(year)

    Enum.each(user_ids, fn user_id ->
      %{"user_id" => user_id, "year" => year}
      |> NexusWrapped.Worker.new()
      |> Oban.insert()
    end)

    Logger.info("[NexusWrapped.Scheduler] Enqueued #{length(user_ids)} jobs for #{year}")
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

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end
