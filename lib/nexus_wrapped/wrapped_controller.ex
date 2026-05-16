defmodule NexusWrapped.WrappedController do
  use Phoenix.Controller, formats: [:json]

  import Plug.Conn
  import Ecto.Query

  alias Nexus.Repo
  alias NexusWrapped.{Result, Share}

  # ── GET / — list all Wrapped years for the current user ──────────────────

  def index(conn, _params) do
    user_id = conn.assigns.current_user.id

    results =
      Repo.all(
        from r in Result,
        where: r.user_id == ^user_id,
        order_by: [desc: r.year]
      )

    shares =
      Repo.all(from s in Share, where: s.user_id == ^user_id)
      |> Map.new(fn s -> {s.year, s.shared} end)

    entries =
      Enum.map(results, fn r ->
        %{
          year:         r.year,
          generated_at: r.generated_at,
          is_shared:    Map.get(shares, r.year, false),
          summary:      extract_summary(r.data),
        }
      end)

    json(conn, %{data: entries})
  end

  # ── GET /:year/:username — fetch a specific Wrapped ───────────────────────

  def show(conn, %{"year" => year_str, "username" => username}) do
    year         = String.to_integer(year_str)
    current_user = conn.assigns[:current_user]

    target_user =
      Repo.one(
        from u in "users",
        where: u.username == ^username,
        select: %{id: u.id, username: u.username}
      )

    if is_nil(target_user) do
      conn |> put_status(404) |> json(%{error: "User not found"})
    else
      result   = Repo.get_by(Result, user_id: target_user.id, year: year)
      share    = Repo.get_by(Share,  user_id: target_user.id, year: year)
      is_owner = current_user && current_user.id == target_user.id
      is_shared = share && share.shared

      cond do
        is_nil(result) ->
          conn |> put_status(404) |> json(%{error: "not_generated"})

        not is_owner and not is_shared ->
          conn |> put_status(403) |> json(%{error: "private"})

        true ->
          prev_result = Repo.get_by(Result, user_id: target_user.id, year: year - 1)

          json(conn, %{
            data: %{
              year:      year,
              username:  username,
              is_owner:  is_owner || false,
              is_shared: is_shared || false,
              current:   result.data,
              previous:  prev_result && prev_result.data,
            }
          })
      end
    end
  end

  # ── PATCH /:year/share — toggle share state ───────────────────────────────

  def update_share(conn, %{"year" => year_str}) do
    year    = String.to_integer(year_str)
    user_id = conn.assigns.current_user.id

    unless Repo.get_by(Result, user_id: user_id, year: year) do
      conn |> put_status(404) |> json(%{error: "No Wrapped found for #{year}"})
    else
      new_shared =
        case Repo.get_by(Share, user_id: user_id, year: year) do
          nil ->
            %Share{}
            |> Share.changeset(%{user_id: user_id, year: year, shared: true})
            |> Repo.insert!()
            true

          share ->
            toggled = !share.shared
            share
            |> Share.changeset(%{shared: toggled})
            |> Repo.update!()
            toggled
        end

      json(conn, %{data: %{shared: new_shared}})
    end
  end

  # ── Helpers ───────────────────────────────────────────────────────────────

  defp extract_summary(data) when is_map(data) do
    %{
      "posts_count"              => data["posts_count"]              || 0,
      "active_days"              => data["active_days"]              || 0,
      "longest_streak"           => data["longest_streak"]           || 0,
      "reactions_received_total" => data["reactions_received_total"] || 0,
      "badges_earned_count"      => data["badges_earned_count"]      || 0,
      "milestones"               => data["milestones"]               || [],
    }
  end
  defp extract_summary(_), do: %{}
end
