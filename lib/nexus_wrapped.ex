defmodule NexusWrapped do
  use Nexus.Extensions.Behaviour

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
