defmodule NexusWrapped.Result do
  use Ecto.Schema
  import Ecto.Changeset

  schema "wrapped_results" do
    field :user_id,      :integer
    field :year,         :integer
    field :data,         :map,      default: %{}
    field :generated_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  def changeset(result, attrs) do
    result
    |> cast(attrs, [:user_id, :year, :data, :generated_at])
    |> validate_required([:user_id, :year, :data, :generated_at])
  end
end

defmodule NexusWrapped.Share do
  use Ecto.Schema
  import Ecto.Changeset

  schema "wrapped_shares" do
    field :user_id, :integer
    field :year,    :integer
    field :shared,  :boolean, default: false

    timestamps(type: :utc_datetime)
  end

  def changeset(share, attrs) do
    share
    |> cast(attrs, [:user_id, :year, :shared])
    |> validate_required([:user_id, :year])
  end
end

defmodule NexusWrapped.CommunityResult do
  use Ecto.Schema
  import Ecto.Changeset

  schema "wrapped_community_results" do
    field :year,         :integer
    field :data,         :map,     default: %{}
    field :post_id,      :integer
    field :generated_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  def changeset(result, attrs) do
    result
    |> cast(attrs, [:year, :data, :post_id, :generated_at])
    |> validate_required([:year, :data, :generated_at])
  end
end
