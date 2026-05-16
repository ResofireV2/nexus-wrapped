defmodule NexusWrapped.MixProject do
  use Mix.Project

  def project do
    [
      app:           :nexus_wrapped,
      version:       "1.0.0",
      elixir:        "~> 1.17",
      elixirc_paths: ["lib"],
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end
end
