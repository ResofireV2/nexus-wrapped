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
  def child_specs do
    [NexusWrapped.Scheduler]
  end

  @impl true
  def settings_schema do
    %{
      "enabled"              => %{"type" => "boolean", "label" => "Enable Wrapped",          "default" => true},
      "sharing_default"      => %{"type" => "boolean", "label" => "Share by default",        "default" => false},
      "min_posts_threshold"  => %{"type" => "number",  "label" => "Minimum posts to qualify","default" => 5},
      "show_gamepedia_slide" => %{"type" => "boolean", "label" => "Show Gamepedia slide",     "default" => true},
      "show_dms_slide"       => %{"type" => "boolean", "label" => "Show DMs slide",           "default" => true},
      "forum_name_override"  => %{"type" => "string",  "label" => "Forum name override",      "default" => ""},
      "send_notification_email" => %{"type" => "boolean", "label" => "Send notification email when ready", "default" => true},
      "widget_hide_after"       => %{"type" => "string",  "label" => "Hide community widget after (YYYY-MM-DD)", "default" => ""},
      "community_post_space_id" => %{"type" => "number",  "label" => "Community post space ID", "default" => nil},
      "auto_generate_date"     => %{"type" => "string",  "label" => "Auto-generate date (YYYY-MM-DD)", "default" => ""},
      "auto_generate_time"     => %{"type" => "string",  "label" => "Auto-generate time (HH:MM)",      "default" => "09:00"},
      "auto_generate_timezone" => %{"type" => "string",  "label" => "Auto-generate timezone",           "default" => "UTC"},
      "intro_message"          => %{"type" => "string",  "label" => "Intro message template",           "default" => ""},
    }
  end

  @impl true
  def settings_tabs do
    [
      %{"key" => "generation",   "label" => "Generation",   "icon" => "fa-wand-magic-sparkles",
        "fields" => ["widget_hide_after", "community_post_space_id"]},
      %{"key" => "visibility",   "label" => "Visibility",   "icon" => "fa-eye",
        "fields" => ["enabled", "sharing_default", "min_posts_threshold"]},
      %{"key" => "content",      "label" => "Content",      "icon" => "fa-layer-group",
        "fields" => ["forum_name_override", "show_gamepedia_slide", "show_dms_slide"]},
      %{"key" => "notifications","label" => "Notifications","icon" => "fa-bell",
        "fields" => ["send_notification_email"]},
    ]
  end

  # Payload keys are atoms — that is how Nexus.Extensions.fire/2 is called
  # throughout Nexus core (e.g. %{post_id: id}, %{user_id: id}).
  @impl true
  def handle_event(_event, _payload, _settings), do: :ok

  # Write default settings on fresh install. Only fills in keys that are
  # not already present — safe to call on existing installs too.
  @impl true
  def on_install(_current_settings) do
    ensure_defaults()
    :ok
  end

  @doc """
  Writes any missing settings defaults for this extension.
  Called on install and from the Scheduler on startup so existing installs
  that predate a new setting get the correct default written to the database.
  """
  def ensure_defaults do
    ext = Nexus.Extensions.get_extension_by_slug("wrapped")
    if ext do
      current  = ext.settings || %{}
      defaults = Enum.reduce(settings_schema(), %{}, fn {key, field}, acc ->
        case Map.get(field, "default") do
          nil -> acc
          val -> Map.put(acc, key, val)
        end
      end)
      # Only write keys that are genuinely missing (nil means never set)
      missing = Enum.reject(defaults, fn {k, _v} -> Map.has_key?(current, k) end)
      if missing != [] do
        patch = Map.new(missing)
        Nexus.Extensions.update_extension_settings(ext, patch)
      end
    end
  end
end
