defmodule NexusWrapped do
  use Nexus.Extensions.Behaviour

  @impl true
  def manifest do
    %{
      slug:        "wrapped",
      name:        "Wrapped",
      version:     "1.0.0",
      description: "A personalised year-in-review for every member of your community.",
      author:      "billyrayfoss",
      homepage:    "https://github.com/billyrayfoss/nexus-wrapped",
      categories:  ["community", "analytics"],
    }
  end

  @impl true
  def migrations do
    [
      NexusWrapped.Migrations.V20260515000001CreateResults,
      NexusWrapped.Migrations.V20260515000002CreateShares,
      NexusWrapped.Migrations.V20260516000001CreateCommunityResults,
    ]
  end

  @impl true
  def routes do
    [{"/", NexusWrapped.ApiRouter, []}]
  end

  @impl true
  def js_bundle_path, do: "wrapped.js"

  @impl true
  def settings_schema do
    %{
      "enabled"              => %{"type" => "boolean", "label" => "Enable Wrapped",         "default" => true},
      "sharing_default"      => %{"type" => "boolean", "label" => "Share by default",       "default" => false},
      "min_posts_threshold"  => %{"type" => "number",  "label" => "Minimum posts to qualify","default" => 5},
      "show_gamepedia_slide" => %{"type" => "boolean", "label" => "Show Gamepedia slide",    "default" => true},
      "show_dms_slide"       => %{"type" => "boolean", "label" => "Show DMs slide",          "default" => true},
      "forum_name_override"  => %{"type" => "string",  "label" => "Forum name override",     "default" => ""},
      "send_notification_email" => %{"type" => "boolean", "label" => "Send notification email when ready", "default" => true},
    }
  end

  @impl true
  def settings_tabs do
    [
      %{"key" => "generation",  "label" => "Generation",  "icon" => "fa-wand-magic-sparkles",
        "fields" => []},
      %{"key" => "visibility",  "label" => "Visibility",  "icon" => "fa-eye",
        "fields" => ["enabled", "sharing_default", "min_posts_threshold"]},
      %{"key" => "content",     "label" => "Content",     "icon" => "fa-layer-group",
        "fields" => ["forum_name_override", "show_gamepedia_slide", "show_dms_slide"]},
      %{"key" => "notifications","label" => "Notifications","icon" => "fa-bell",
        "fields" => ["send_notification_email"]},
    ]
  end

  # Payload keys are atoms — that is how Nexus.Extensions.fire/2 is called
  # throughout Nexus core (e.g. %{post_id: id}, %{user_id: id}).
  @impl true
  def handle_event(_event, _payload, _settings), do: :ok
end
