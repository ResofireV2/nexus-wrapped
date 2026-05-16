defmodule NexusWrapped.ApiRouter do
  use Phoenix.Router, helpers: false

  import Plug.Conn
  import Phoenix.Controller

  pipeline :api do
    plug :accepts, ["json"]
    plug :fetch_query_params
  end

  pipeline :auth do
    plug :require_user
  end

  pipeline :admin do
    plug :require_user
    plug :require_admin
  end

  # ── Public routes ─────────────────────────────────────────────────────────
  # Any logged-in user can view a shared Wrapped. Unauthenticated users
  # can also view shared Wrappeds (for public share links).

  scope "/" do
    pipe_through :api

    get "/:year/:username", NexusWrapped.WrappedController, :show
  end

  # ── Authenticated routes ──────────────────────────────────────────────────

  scope "/" do
    pipe_through [:api, :auth]

    get  "/",                    NexusWrapped.WrappedController, :index
    patch "/:year/share",        NexusWrapped.WrappedController, :update_share
  end

  # ── Admin routes ──────────────────────────────────────────────────────────

  scope "/admin" do
    pipe_through [:api, :admin]

    post "/generate",             NexusWrapped.AdminController, :generate_all
    post "/generate/:user_id",    NexusWrapped.AdminController, :generate_one
    post "/simulate",             NexusWrapped.AdminController, :simulate
    get  "/status/:year",         NexusWrapped.AdminController, :generation_status
  end

  # ── Plugs ─────────────────────────────────────────────────────────────────

  defp require_user(conn, _) do
    if conn.assigns[:current_user] do
      conn
    else
      conn |> put_status(401) |> json(%{error: "Unauthorized"}) |> halt()
    end
  end

  defp require_admin(conn, _) do
    case conn.assigns[:current_user] do
      %{role: "admin"} -> conn
      nil -> conn |> put_status(401) |> json(%{error: "Unauthorized"}) |> halt()
      _   -> conn |> put_status(403) |> json(%{error: "Forbidden"})    |> halt()
    end
  end
end
