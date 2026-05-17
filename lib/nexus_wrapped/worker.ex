defmodule NexusWrapped.Worker do
  @moduledoc """
  Oban worker that generates and persists a Wrapped result for a single user.

  Enqueued by the admin generate endpoint (batch for all users, or single
  user for the simulate flow). Each job is independent — a failure for
  one user does not affect others.

  After generation, fires an in-app notification and optionally sends
  a notification email depending on the extension setting.
  """

  use Oban.Worker,
    queue: :default,
    max_attempts: 3,
    unique: [period: 60, fields: [:args], keys: [:user_id, :year]]

  import Ecto.Query
  alias NexusWrapped.Generator

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"user_id" => user_id, "year" => year}}) do
    ext      = Nexus.Extensions.get_extension_by_slug("wrapped")
    settings = if ext, do: ext.settings || %{}, else: %{}

    # Check minimum posts threshold before generating
    threshold  = settings["min_posts_threshold"] || 5
    post_count = get_post_count(user_id, year)

    if post_count < threshold do
      # Below threshold — skip silently (not an error)
      :ok
    else
      case Generator.generate(user_id, year, settings) do
        {:ok, _result} ->
          # Look up username for the notification data
          username =
            Nexus.Repo.one(
              from u in "users",
              where: u.id == ^user_id,
              select: u.username
            )

          # Fire in-app notification with year and username so the frontend
          # can navigate directly to /wrapped/:year/:username.
          # actor_id is set to user_id (self-notification) so the dedup check
          # in DeliverNotification never matches a prior year's notification,
          # which would have the same nil actor_id and silently drop the new one.
          Nexus.Notifications.notify_extension(
            user_id,
            "wrapped_ready",
            actor_id: user_id,
            data: %{"year" => year, "username" => username}
          )

          # Send notification email if setting enabled
          if settings["send_notification_email"] != false do
            send_notification_email(user_id, year)
          end

          # Broadcast progress update to the admin panel
          Phoenix.PubSub.broadcast(
            Nexus.PubSub,
            "wrapped:generation:#{year}",
            {:user_generated, user_id}
          )

          :ok

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp get_post_count(user_id, year) do
    from_date = Date.new!(year, 1, 1)
    to_date   = Date.new!(year, 12, 31)

    Nexus.Repo.aggregate(
      from(s in "user_daily_stats",
        where: s.user_id == ^user_id
          and s.date >= ^from_date
          and s.date <= ^to_date
      ),
      :sum,
      :posts_count
    ) || 0
  end

  defp send_notification_email(user_id, year) do
    user =
      Nexus.Repo.one(
        from u in "users",
        where: u.id == ^user_id,
        select: %{
          id:           u.id,
          username:     u.username,
          email:        u.email,
          avatar_url:   u.avatar_url,
          avatar_color: u.avatar_color,
        }
      )

    if user, do: NexusWrapped.Mailer.send_wrapped_ready(user, year)
    :ok
  end
end
