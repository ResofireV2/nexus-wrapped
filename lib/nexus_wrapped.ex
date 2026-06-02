defmodule NexusWrapped do
  use Nexus.Extensions.Behaviour

  @impl true
  def migrations do
    [
      NexusWrapped.Migrations.V1CreateResults,
      NexusWrapped.Migrations.V2CreateShares,
      NexusWrapped.Migrations.V3CreateCommunityResults,
    ]
  end

  @impl true
  def routes do
    [{ "/", NexusWrapped.ApiRouter, [] }]
  end

  @impl true
  def child_specs do
    [NexusWrapped.Scheduler]
  end

  @impl true
  def on_install(_settings), do: :ok

  @impl true
  def handle_event(_event, _payload, _settings), do: :ok
end
