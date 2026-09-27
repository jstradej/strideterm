# Authentication email delivery

Firebase Authentication generates sign-in emails. Production uses Resend as its custom SMTP relay.
The desktop requests the email with `accounts:sendOobCode`; it does not hold SMTP credentials.

## Production configuration

Project: `strideterm-mobile-prod`.

| Setting                                | Location                                                   | Value                                                                   |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| SMTP relay                             | Firebase Authentication → Templates → SMTP settings        | `smtp.resend.com`, port `465`, SSL, username `resend`                   |
| SMTP sender                            | Same page                                                  | `signin@mail.strideterm.com`                                            |
| Sending domain                         | Resend → Domains                                           | `mail.strideterm.com`; SPF and DKIM must be verified                    |
| Custom action domain                   | Firebase Hosting → `strideterm-mobile-prod` → Domains      | `mail.strideterm.com`                                                   |
| Authorized domain                      | Firebase Authentication → Settings → Authorized domains    | `mail.strideterm.com` added alongside the existing domains              |
| Hosting DNS                            | Cloudflare → `strideterm.com` → DNS → Records              | DNS-only CNAME `mail` → `strideterm-mobile-prod.web.app`, automatic TTL |
| Current action URL                     | Firebase Authentication → Templates → Customize action URL | `https://strideterm-mobile-prod.firebaseapp.com/__/auth/action`         |
| Intended action URL after verification | Same page                                                  | `https://mail.strideterm.com/__/auth/action`                            |
| Sign-in continuation                   | Desktop's fixed production broker                          | `https://auth.strideterm.com/c?attempt=…`                               |

Status as of 2026-09-28: the sender change is active. The Hosting domain and DNS record are created,
and Firebase has verified ownership. Certificate validation is pending. The original action URL remains active.
Update this status and the current URL when the rollout is completed. QA settings are separate.

The CNAME connects only the `mail` subdomain to Firebase Hosting. It does not transfer the domain,
change its registrar or nameservers, or move the apex website. Keep the existing Resend SPF, DKIM,
and return-path records; Hosting does not replace email authentication.

## Activate the custom action URL

1. Verify that Firebase Hosting reports the domain connected and that
   `https://mail.strideterm.com/__/auth/action` serves the Firebase handler with a valid certificate.
   DNS visibility alone is not sufficient. Certificate provisioning can take up to 24 hours.
2. Verify that `mail.strideterm.com` is in Authentication's authorized domains; add it if absent.
3. Release the desktop handler allowlist change before switching the email link domain. Older
   desktop builds accept only the default Firebase domains in the manual paste fallback.
4. Set the action URL to `https://mail.strideterm.com/__/auth/action`. Through the Identity Platform
   API, update only `notification.sendEmail.callbackUri` using an explicit update mask.
5. Check the generated `EMAIL_SIGNIN` link, its continuation to the broker, and both the browser and
   manual paste sign-in paths. Never put complete sign-in links, codes, or credentials in logs or docs.
6. Request a test email to an address owned by the tester, inspect the final Resend delivery event,
   and confirm whether it reached the inbox or spam folder.

The desktop's custom handler is pinned to the production environment, production project, HTTPS
origin, and `/__/auth/action` path. It does not accept arbitrary domains or environment overrides in
production. The default Firebase domains remain accepted for existing links.

To roll back the action URL, restore
`https://strideterm-mobile-prod.firebaseapp.com/__/auth/action`. Keep the custom domain serving old
links until they have expired. The original SMTP sender was `no-reply@mail.strideterm.com`.

## Diagnose rejection

In Resend → Emails, open the message and inspect the bounce details. `Sent` confirms handoff to the
sending service; it does not prove delivery. Even `Delivered` does not prove inbox placement.

The 2026-09-28 failure was `550 Message discarded as high-probability spam`, classified as transient
`ContentRejected`. SPF and DKIM were verified. A single authorized test after changing the sender
was also rejected with that response. This does not identify the receiver's exact spam rule, and the
sender change alone has not fixed delivery. The custom link domain has not yet been tested live.

If rejection continues after the domain rollout, use the receiver's spam-filter logs or ask its mail
administrator for the matched rules. Do not repeatedly resend the same rejected message. Check the
Resend suppression list before a fresh user-requested attempt if the provider reports suppression.

SMTP keys belong in the provider's secret storage and local credential files outside Git. The
Firebase console may require the SMTP password again for edits; a narrow API update to
`notification.sendEmail.smtp.senderEmail` preserves existing credentials. Avoid replacing the whole
SMTP configuration with a response object, because responses omit the password.

References: [Firebase custom domains](https://firebase.google.com/docs/hosting/custom-domain),
[Firebase email action handlers](https://firebase.google.com/docs/auth/custom-email-handler),
[Identity Platform configuration](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config).
