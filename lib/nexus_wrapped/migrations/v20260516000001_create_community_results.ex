defmodule NexusWrapped.Migrations.V20260516000001CreateCommunityResults do
  use Ecto.Migration

  def change do
    create table(:wrapped_community_results) do
      add :year,         :integer,     null: false
      add :data,         :map,         null: false, default: %{}
      add :post_id,      :integer
      add :generated_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:wrapped_community_results, [:year])
  end
end
