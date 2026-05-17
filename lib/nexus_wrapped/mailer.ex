defmodule NexusWrapped.Mailer do
  @moduledoc """
  Sends the "Your Wrapped is ready" transactional email.
  Delegates delivery to Nexus.Mailer (Swoosh) using the same
  html_layout helpers Nexus uses for all other notification emails.
  We replicate the layout helpers here rather than calling private
  functions in Nexus.Mailer directly.
  """

  import Swoosh.Email

  def send_wrapped_ready(user, year) do
    gen       = general_settings()
    site_name = Map.get(gen, "site_name", "Nexus")
    base      = Nexus.Mailer.base_url()
    url       = "#{base}/ext/wrapped/#{year}/#{user.username}"

    subject   = "Your #{year} Wrapped is ready ✨"
    preview   = "See how your year on #{site_name} played out."

    content = """
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#f0eeff;letter-spacing:-0.4px;line-height:1.2;">
      Your #{year} Wrapped is ready
    </h1>
    <p style="margin:0 0 20px;font-size:15px;color:rgba(255,255,255,0.6);line-height:1.65;">
      Hi #{user.username} — your personalised #{year} year in review on #{site_name} is ready.
      See your posts, streaks, reactions, badges, and more.
    </p>
    #{button_html("View your #{year} Wrapped", url)}
    <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;">
      Or copy this link: <a href="#{url}" style="color:rgba(255,255,255,0.35);word-break:break-all;">#{url}</a>
    </p>
    """

    text = """
    Hi #{user.username},

    Your #{year} Wrapped is ready on #{site_name}.

    View it here: #{url}
    """

    email =
      new()
      |> from(from_addr())
      |> to({user.username, user.email})
      |> subject(subject)
      |> html_body(html_layout(content, preview))
      |> text_body(text)

    # Deliver via Nexus's dynamic config (reads SMTP/Postmark/Resend settings
    # from the admin panel at send time — no restart needed)
    deliver_via_nexus(email)
  end

  # ── Private helpers ───────────────────────────────────────────────────────
  # These mirror Nexus.Mailer's private helpers exactly so the email
  # looks identical to native Nexus emails.

  defp general_settings do
    case Nexus.Admin.get_setting("general") do
      s when is_map(s) -> s
      _ -> %{}
    end
  end

  defp email_settings do
    case Nexus.Admin.get_setting("email") do
      s when is_map(s) -> s
      _ -> %{}
    end
  end

  defp from_addr do
    s = email_settings()
    name = Map.get(s, "from_name", "Nexus")
    addr = Map.get(s, "from_address", "noreply@nexus.local")
    if addr != "", do: {name, addr}, else: {"Nexus", "noreply@nexus.local"}
  end

  defp button_html(label, url) do
    """
    <table cellpadding="0" cellspacing="0" style="margin:28px 0;">
      <tr><td style="background:#a78bfa;border-radius:10px;">
        <a href="#{url}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:500;color:#0d0d14;text-decoration:none;border-radius:10px;letter-spacing:-0.1px;">#{label}</a>
      </td></tr>
    </table>
    """
  end

  defp html_layout(content_html, preview_text) do
    gen       = general_settings()
    site_name = Map.get(gen, "site_name", "Nexus")
    logo_url  = Map.get(gen, "logo_url")
    base      = Nexus.Mailer.base_url()

    absolute_logo =
      cond do
        is_nil(logo_url) or logo_url == "" -> nil
        String.starts_with?(logo_url, "http") -> logo_url
        true -> "#{base}#{logo_url}"
      end

    logo_html =
      if absolute_logo do
        "<img src=\"#{absolute_logo}\" alt=\"#{site_name}\" style=\"max-height:40px;max-width:160px;object-fit:contain;display:block;\" />"
      else
        "<span style=\"font-size:22px;font-weight:600;color:#f0eeff;letter-spacing:-0.5px;\">#{site_name}</span>"
      end

    """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
      #{if preview_text != "", do: "<div style=\"display:none;max-height:0;overflow:hidden;\">#{preview_text}&nbsp;&#847;&nbsp;</div>", else: ""}
    </head>
    <body style="margin:0;padding:0;background:#0d0d14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d14;min-height:100vh;">
        <tr><td align="center" style="padding:40px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
            <tr><td style="padding-bottom:28px;">
              <a href="#{base}" style="text-decoration:none;">#{logo_html}</a>
            </td></tr>
            <tr><td style="background:#13121e;border:0.5px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px 40px;">
              #{content_html}
            </td></tr>
            <tr><td style="padding-top:24px;text-align:center;">
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;">
                You're receiving this because you have an account at
                <a href="#{base}" style="color:rgba(255,255,255,0.4);text-decoration:none;">#{site_name}</a>.
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
    """
  end

  defp deliver_via_nexus(email) do
    # Access Nexus.Mailer's deliver_dynamic via its public config path.
    # Nexus.Mailer exposes build_config indirectly — we replicate the
    # dynamic delivery pattern used throughout Nexus.
    case build_config(email_settings()) do
      {:ok, config}       -> Swoosh.Mailer.deliver(email, config)
      {:fallback, config} -> Swoosh.Mailer.deliver(email, config)
      {:error, reason}    -> {:error, reason}
    end
  end

  defp build_config(settings) do
    case Map.get(settings, "provider", "smtp") do
      "postmark" ->
        key = Map.get(settings, "api_key", "")
        if key != "", do: {:ok, adapter: Swoosh.Adapters.Postmark, api_key: key},
          else: {:error, "Postmark API key not configured"}

      "resend" ->
        key = Map.get(settings, "api_key", "")
        if key != "", do: {:ok, adapter: Swoosh.Adapters.Resend, api_key: key},
          else: {:error, "Resend API key not configured"}

      "mailgun" ->
        key    = Map.get(settings, "api_key", "")
        domain = Map.get(settings, "mailgun_domain", "")
        if key != "" and domain != "",
          do: {:ok, adapter: Swoosh.Adapters.Mailgun, api_key: key, domain: domain},
          else: {:error, "Mailgun API key and domain required"}

      _ ->
        host     = Map.get(settings, "smtp_host", "")
        port     = settings |> Map.get("smtp_port", "587") |> to_string() |> Integer.parse() |> elem(0)
        username = Map.get(settings, "smtp_username", "")
        password = Map.get(settings, "smtp_password", "")
        tls      = case Map.get(settings, "smtp_encryption", "tls") do
          "ssl"  -> :always
          "none" -> :never
          _      -> :if_available
        end

        if host != "" do
          {:ok, adapter: Swoosh.Adapters.SMTP,
            relay: host, port: port, username: username,
            password: password, tls: tls, auth: :always}
        else
          {:fallback, adapter: Swoosh.Adapters.Local}
        end
    end
  end
end
