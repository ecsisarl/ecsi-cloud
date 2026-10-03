import type { OutgoingMail } from './mail.service.js';

type Locale = 'fr' | 'en';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function layout(title: string, paragraphs: string[], action: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:24px">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}
<p><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#0d6e6e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(action.label)}</a></p>
<p style="font-size:12px;color:#64748b">${escapeHtml(action.url)}</p>
<p style="font-size:12px;color:#64748b">ECSI CLOUD</p></body></html>`;
}

export function passwordResetMail(to: string, url: string, locale: Locale): OutgoingMail {
  const t =
    locale === 'en'
      ? {
          subject: 'Reset your ECSI CLOUD password',
          title: 'Password reset',
          lines: [
            'A password reset was requested for your account.',
            'This link is valid for 30 minutes and can be used only once. If you did not request it, ignore this email.',
          ],
          action: 'Choose a new password',
        }
      : {
          subject: 'Réinitialisation de votre mot de passe ECSI CLOUD',
          title: 'Réinitialisation du mot de passe',
          lines: [
            'Une réinitialisation du mot de passe a été demandée pour votre compte.',
            "Ce lien est valable 30 minutes et ne peut servir qu'une fois. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
          ],
          action: 'Choisir un nouveau mot de passe',
        };
  return {
    to,
    subject: t.subject,
    text: `${t.title}\n\n${t.lines.join('\n\n')}\n\n${url}\n`,
    html: layout(t.title, t.lines, { label: t.action, url }),
  };
}

export function invitationMail(
  to: string,
  url: string,
  companyName: string,
  inviterName: string,
  locale: Locale,
): OutgoingMail {
  const t =
    locale === 'en'
      ? {
          subject: `Invitation to join ${companyName} on ECSI CLOUD`,
          title: `Join ${companyName}`,
          lines: [
            `${inviterName} invited you to join ${companyName} on ECSI CLOUD.`,
            'This invitation is valid for 7 days.',
          ],
          action: 'Accept the invitation',
        }
      : {
          subject: `Invitation à rejoindre ${companyName} sur ECSI CLOUD`,
          title: `Rejoindre ${companyName}`,
          lines: [
            `${inviterName} vous invite à rejoindre ${companyName} sur ECSI CLOUD.`,
            'Cette invitation est valable 7 jours.',
          ],
          action: "Accepter l'invitation",
        };
  return {
    to,
    subject: t.subject,
    text: `${t.title}\n\n${t.lines.join('\n\n')}\n\n${url}\n`,
    html: layout(t.title, t.lines, { label: t.action, url }),
  };
}
