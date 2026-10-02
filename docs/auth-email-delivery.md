# Authentication email delivery

Two paths send sign-in mail, and the desktop holds no SMTP credentials on either:

- **The production desktop sign-in** (project `strideterm-mobile-prod`, no emulators) calls a
  dedicated Cloud Function, `requestSignInEmail`. It generates the Firebase sign-in link itself and
  sends it through the Resend Email API.
- **Everything else** — the `local`, `dev` and `qa` tiers, and every email-change message — uses
  Firebase Authentication's `accounts:sendOobCode`, which sends through Resend as its custom SMTP relay.

## Production configuration

These settings live in consoles, not in this repository.

| Setting                    | Location                                                   | Value                                                           |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| SMTP relay                 | Firebase Authentication → Templates → SMTP settings        | `smtp.resend.com`, port `465`, SSL, username `resend`           |
| Firebase SMTP sender       | Same page                                                  | `signin@mail.strideterm.com`                                    |
| Sign-in API sender         | Resend Email API (Cloud Function)                          | `strIDEterm <signin@mail.strideterm.com>`                       |
| Sending domain             | Resend → Domains                                           | `mail.strideterm.com`; SPF and DKIM verified                    |
| DMARC                      | DNS                                                        | `p=quarantine` on `mail.strideterm.com`, `p=none` on the apex   |
| Custom action domain       | Firebase Hosting → `strideterm-mobile-prod` → Domains      | `mail.strideterm.com`                                           |
| Authorized domain          | Firebase Authentication → Settings → Authorized domains    | `mail.strideterm.com`, beside the default ones                  |
| Hosting DNS                | Cloudflare → `strideterm.com` → DNS                        | DNS-only CNAME `mail` → `strideterm-mobile-prod.web.app`        |
| Action URL (Firebase mail) | Firebase Authentication → Templates → Customize action URL | `https://strideterm-mobile-prod.firebaseapp.com/__/auth/action` |
| Action URL (sign-in API)   | Pinned by the Cloud Function                               | `https://mail.strideterm.com/__/auth/action`                    |
| Sign-in continuation       | The desktop's fixed production broker                      | `https://auth.strideterm.com/c?attempt=…`                       |

The CNAME connects only the `mail` subdomain to Firebase Hosting. It does not move the domain, its
nameservers or the apex website, and Hosting does not replace the Resend SPF, DKIM and return-path
records.

SMTP keys belong in the provider's secret storage, never in Git. To change only the SMTP sender,
update `notification.sendEmail.smtp.senderEmail` with a narrow API update mask: a response object
omits the password, so writing one back would wipe the credentials.

## The custom action URL for Firebase mail

Firebase-generated messages (email changes, non-production sign-ins) still link to the default
`firebaseapp.com` handler. Changing `notification.sendEmail.callbackUri` is refused with
`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED` even though Hosting, the certificate and the authorized domain are
in place. The production sign-in API does not depend on this setting.

To switch it once Firebase allows the change:

1. Confirm `https://mail.strideterm.com/__/auth/action` serves the Firebase handler with a valid
   certificate, and that the domain is in Authentication's authorized domains.
2. Ask Firebase Support to review or escalate the `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED` refusal, with
   the Hosting, certificate and authorized-domain evidence. Try this before any backend rewrite.
3. Update only `notification.sendEmail.callbackUri`, with an explicit update mask.
4. Check a generated link end to end — the broker continuation, the browser path and the manual paste
   path — then send a test message to a mailbox the tester owns and read the final Resend event.

To roll back, restore the `firebaseapp.com` URL and keep the custom domain serving until old links
have expired. The desktop accepts the custom handler only for the `prod` environment and the
production project, over HTTPS on `/__/auth/action`; the default Firebase domains stay accepted.

Never put a complete sign-in link, code or credential in a log or a document.

## The sign-in API

The Cloud Function lives in the `strideterm-mobile` repository (`docs/signin-email-fallback.md`
there), in its own `signin-email` Functions codebase, deployed separately from the rest.

- **It is unauthenticated.** Anyone who can reach it can ask for mail to an address they do not own.
  Completing a sign-in still needs that mailbox, and the broker's attempt, confirmation and
  code-redemption checks are what make an unsolicited link harmless. Keep them.
- **Quotas** apply to this endpoint only: 80 requests a day, 2,400 a month, 5 per address a day, 20 per
  network a day (IPv6 bucketed by `/64`), and one per address per 60 seconds. They do not limit
  Firebase's public `accounts:sendOobCode` API. There is no CAPTCHA; Turnstile is an open question.
- **Addresses** are trimmed and only the domain is lowercased; the local part is sent as typed. Quota
  keys hash the fully lowercased address, so case variants share one limit.
- **`202 {"status":"unknown"}` is uncertain, not failed.** The first request may already have produced a
  usable link, so the desktop never retries through Firebase.
- **The message carries the sign-in link and nothing else** — no promotion, no second destination,
  because both read as spam signals in a transactional mail. The plain-text part keeps the full URL
  for copying, and replies go to `support@strideterm.com`.

## When a message is rejected

Resend's `Sent` means it was handed off, not delivered, and `Delivered` does not mean it reached the
inbox. Read the bounce details in Resend → Emails. A `550 … spam` answer does not name the receiver's
rule: ask its mail administrator, do not resend the same rejected message, and check Resend's
suppression list before a new attempt.

## Cost boundary

The sign-in API can incur Cloud Functions, Realtime Database, Authentication, Secret Manager, Cloud
Build, Artifact Registry and Resend charges; its quotas do not cap anything else in the project.
Resend's free tier allows 100 emails a day and 3,000 a month across all tiers, including test sends
([Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)). Any fallback stays
on Firebase and Cloudflare; a VPS is not an approved fallback.

## Which address the desktop shows

An enrolled desktop keeps its installation after the short-lived owner session ends. The account
page shows, in this order: the live owner address, the last verified address remembered on this
computer (credential store, `account:owner-email`), or the server's masked `accountDisplay`.

- The masked address is never a sign-in destination.
- The remembered one is only prefilled; no link goes to it until the person confirms it in the form.
  Every overview is checked against it: a mask that contradicts it forgets it, and a sign-in with a
  different address replaces it. Both show a notice, and the log line never carries the address.
- Signing a registered desktop out needs a recent owner sign-in. It revokes the installation before
  the local credential is cleared, so a failed revocation can be retried. It does not delete the
  account or cancel the subscription; account deletion is a separate confirmation.

References: [Firebase custom domains](https://firebase.google.com/docs/hosting/custom-domain),
[Firebase email action handlers](https://firebase.google.com/docs/auth/custom-email-handler),
[Identity Platform configuration](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config),
[Firebase Support](https://firebase.google.com/support/troubleshooter/contact).
