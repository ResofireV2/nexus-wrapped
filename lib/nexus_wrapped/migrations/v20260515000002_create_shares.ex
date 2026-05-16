defmodule NexusWrapped.Migrations.V20260515000002CreateShares do
  use Ecto.Migration

  def change do
    create table(:wrapped_shares) do
      add :user_id, :integer, null: false
      add :year,    :integer, null: false
      add :shared,  :boolean, null: false, default: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:wrapped_shares, [:user_id, :year])
  end
end
