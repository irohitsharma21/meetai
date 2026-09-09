"""
Post-meeting email digest.

Sends each participant the summary, the confirmed action items and the
headline participation stats once a meeting ends.

Uses stdlib `smtplib` over an executor rather than adding an async SMTP
dependency: one message per meeting is not a throughput problem, and any
SMTP provider works — Gmail app passwords, SendGrid, Mailgun, Postmark, or a
local MailHog in development.

Like every other integration here, an unconfigured service does not raise on
import. It reports itself as unavailable and the API returns an actionable
message naming the variables to set.
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from html import escape
from typing import Sequence

from core.config import settings
from models.meeting_model import AIAnalysis, NextAction


class EmailUnavailable(RuntimeError):
    """Raised when a digest is requested without SMTP configured."""


@dataclass
class Recipient:
    username: str
    email: str


class EmailService:
    """Composes and delivers the post-meeting digest."""

    @property
    def available(self) -> bool:
        return bool(
            settings.SMTP_HOST and settings.SMTP_FROM and settings.SMTP_PORT
        )

    def _require(self) -> None:
        if not self.available:
            raise EmailUnavailable(
                "Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_FROM "
                "(and SMTP_USER / SMTP_PASSWORD if your provider needs auth) "
                "in backend/.env to enable meeting digests."
            )

    async def send_digest(
        self,
        *,
        meeting_title: str,
        meeting_id: str,
        date: str,
        duration: str,
        recipients: Sequence[Recipient],
        analysis: AIAnalysis | None,
        analytics: dict | None = None,
        app_url: str | None = None,
    ) -> dict:
        """Send the digest. Returns per-recipient delivery outcomes."""
        self._require()

        addressed = [r for r in recipients if r.email]
        if not addressed:
            return {"sent": 0, "skipped": len(recipients), "results": [],
                    "note": "no participants had an email address on file"}

        subject = f"Minutes — {meeting_title}"
        html = self._render_html(
            meeting_title, date, duration, analysis, analytics, meeting_id, app_url
        )
        text = self._render_text(meeting_title, date, duration, analysis, analytics)

        # smtplib is blocking; keep it off the event loop.
        return await asyncio.get_running_loop().run_in_executor(
            None, self._deliver, addressed, subject, html, text
        )

    # ── transport ─────────────────────────────────────────────────────
    def _deliver(
        self, recipients: list[Recipient], subject: str, html: str, text: str
    ) -> dict:
        results: list[dict] = []
        sent = 0

        try:
            server = self._connect()
        except Exception as exc:
            raise EmailUnavailable(
                f"Could not connect to SMTP host {settings.SMTP_HOST}:"
                f"{settings.SMTP_PORT} — {exc.__class__.__name__}: {exc}"
            ) from exc

        try:
            for r in recipients:
                message = EmailMessage()
                message["Subject"] = subject
                message["From"] = formataddr((settings.APP_NAME, settings.SMTP_FROM))
                message["To"] = formataddr((r.username, r.email))
                message["Date"] = formatdate(localtime=True)
                message.set_content(text)
                message.add_alternative(html, subtype="html")

                try:
                    server.send_message(message)
                    results.append({"username": r.username, "email": r.email, "ok": True})
                    sent += 1
                except Exception as exc:
                    # One bad address must not abandon the rest of the batch.
                    results.append({
                        "username": r.username, "email": r.email,
                        "ok": False, "error": str(exc),
                    })
        finally:
            try:
                server.quit()
            except Exception:
                pass

        return {"sent": sent, "skipped": len(recipients) - sent, "results": results}

    def _connect(self):
        host, port = settings.SMTP_HOST, settings.SMTP_PORT

        # Port 465 is implicit TLS; 587 and 25 start plaintext then upgrade.
        if settings.SMTP_USE_SSL or port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
            if settings.SMTP_USE_TLS:
                server.starttls()

        if settings.SMTP_USER and settings.SMTP_PASSWORD:
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        return server

    # ── rendering ─────────────────────────────────────────────────────
    @staticmethod
    def _actions(analysis: AIAnalysis | None) -> list[NextAction]:
        if not analysis:
            return []
        return [
            a for a in analysis.next_actions
            if getattr(a, "status", None) is None or str(a.status) != "ActionStatus.REJECTED"
        ]

    def _render_text(
        self, title: str, date: str, duration: str,
        analysis: AIAnalysis | None, analytics: dict | None,
    ) -> str:
        lines = [title, "=" * len(title), "", f"Date: {date}", f"Duration: {duration}", ""]

        if analysis and analysis.summary:
            lines += ["SUMMARY", "-------", analysis.summary, ""]

        actions = self._actions(analysis)
        if actions:
            lines += ["ACTION ITEMS", "------------"]
            for a in actions:
                who = f" — {a.assignee}" if a.assignee else ""
                when = f" (due {a.date})" if a.date else ""
                lines.append(f"  * {a.task}{who}{when}")
            lines.append("")

        if analytics and analytics.get("speakers"):
            lines += ["PARTICIPATION", "-------------"]
            for s in analytics["speakers"]:
                lines.append(f"  {s['speaker']}: {s['share'] * 100:.0f}% of speech")
            lines.append("")

        lines.append(f"Sent by {settings.APP_NAME}.")
        return "\n".join(lines)

    def _render_html(
        self, title: str, date: str, duration: str,
        analysis: AIAnalysis | None, analytics: dict | None,
        meeting_id: str, app_url: str | None,
    ) -> str:
        # Inline styles and a table shell: email clients strip <style> blocks
        # and have no flexbox worth relying on.
        actions = self._actions(analysis)

        action_rows = "".join(
            f"""
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #e6e8eb;">
                <div style="font-size:14px;color:#111;">{escape(a.task)}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:2px;">
                  {escape(a.assignee or 'unassigned')}
                  {' &middot; due ' + escape(a.date) if a.date else ''}
                </div>
              </td>
            </tr>"""
            for a in actions
        ) or """
            <tr><td style="padding:8px 0;font-size:14px;color:#6b7280;">
              No action items were detected.
            </td></tr>"""

        speaker_rows = ""
        if analytics and analytics.get("speakers"):
            for s in analytics["speakers"]:
                pct = s["share"] * 100
                speaker_rows += f"""
                <tr>
                  <td style="padding:5px 0;font-size:13px;color:#111;width:120px;">
                    {escape(s['speaker'])}
                  </td>
                  <td style="padding:5px 0;">
                    <div style="background:#e6e8eb;height:6px;border-radius:3px;">
                      <div style="background:#6366f1;width:{pct:.0f}%;height:6px;border-radius:3px;"></div>
                    </div>
                  </td>
                  <td style="padding:5px 0 5px 10px;font-size:12px;color:#6b7280;width:40px;text-align:right;">
                    {pct:.0f}%
                  </td>
                </tr>"""

        summary = (
            f'<p style="margin:0;font-size:14px;line-height:1.65;color:#374151;">'
            f"{escape(analysis.summary)}</p>"
            if analysis and analysis.summary
            else '<p style="margin:0;font-size:14px;color:#6b7280;">'
                 "No summary was generated for this meeting.</p>"
        )

        link = ""
        if app_url:
            link = f"""
            <a href="{escape(app_url)}/meetings/{escape(meeting_id)}/report"
               style="display:inline-block;background:#6366f1;color:#fff;
                      text-decoration:none;padding:9px 16px;border-radius:8px;
                      font-size:13px;font-weight:500;">
              Open the full report
            </a>"""

        return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f6f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#f5f6f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#fff;border-radius:12px;
                    border:1px solid #e6e8eb;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

        <tr><td style="padding:22px 26px 0;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.06em;
                      text-transform:uppercase;color:#6b7280;">
            {escape(settings.APP_NAME)} &middot; Minutes
          </div>
          <h1 style="margin:6px 0 3px;font-size:20px;color:#111;
                     letter-spacing:-.02em;">{escape(title)}</h1>
          <div style="font-size:13px;color:#6b7280;">
            {escape(date)} &middot; {escape(duration)}
          </div>
        </td></tr>

        <tr><td style="padding:20px 26px 0;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.06em;
                      text-transform:uppercase;color:#6b7280;margin-bottom:8px;">
            Summary
          </div>
          {summary}
        </td></tr>

        <tr><td style="padding:20px 26px 0;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.06em;
                      text-transform:uppercase;color:#6b7280;margin-bottom:4px;">
            Action items
          </div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            {action_rows}
          </table>
        </td></tr>

        {'<tr><td style="padding:20px 26px 0;">'
         '<div style="font-size:11px;font-weight:600;letter-spacing:.06em;'
         'text-transform:uppercase;color:#6b7280;margin-bottom:8px;">Participation</div>'
         '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
         + speaker_rows + '</table></td></tr>' if speaker_rows else ''}

        <tr><td style="padding:22px 26px 26px;">{link}</td></tr>

        <tr><td style="padding:14px 26px;background:#fafbfc;
                       border-top:1px solid #e6e8eb;font-size:11px;color:#9ca3af;">
          Generated automatically by {escape(settings.APP_NAME)} from the meeting transcript.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>"""


email_service = EmailService()
