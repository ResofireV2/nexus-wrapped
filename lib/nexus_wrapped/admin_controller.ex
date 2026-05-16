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

  # ── Helpers ───────────────────────────────────────────────────────────────

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
