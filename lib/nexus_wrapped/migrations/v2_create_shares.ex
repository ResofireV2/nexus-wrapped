defmodule NexusWrapped.Migrations.V2CreateShares do
  use Ecto.Migration

  def change do
    create_if_not_exists table(:wrapped_shares) do
      add :user_id, :integer, null: false
      add :year,    :integer, null: false
      add :shared,  :boolean, null: false, default: false

      timestamps(type: :utc_datetime)
    end

    create_if_not_exists unique_index(:wrapped_shares, [:user_id, :year])
  end
end
