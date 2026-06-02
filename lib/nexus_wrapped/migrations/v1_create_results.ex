defmodule NexusWrapped.Migrations.V1CreateResults do
  use Ecto.Migration

  def change do
    create_if_not_exists table(:wrapped_results) do
      add :user_id,      :integer,      null: false
      add :year,         :integer,      null: false
      add :data,         :map,          null: false, default: %{}
      add :generated_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    create_if_not_exists unique_index(:wrapped_results, [:user_id, :year])
    create_if_not_exists index(:wrapped_results, [:year])
    create_if_not_exists index(:wrapped_results, [:user_id])
  end
end
