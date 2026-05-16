defmodule NexusWrapped.Migrations.V20260515000001CreateResults do
  use Ecto.Migration

  def change do
    create table(:wrapped_results) do
      add :user_id,      :integer,  null: false
      add :year,         :integer,  null: false
      add :data,         :map,      null: false, default: %{}
      add :generated_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:wrapped_results, [:user_id, :year])
    create index(:wrapped_results, [:year])
    create index(:wrapped_results, [:user_id])
  end
end
