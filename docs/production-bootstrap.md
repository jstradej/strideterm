# Production desktop bootstrap

On a fresh installation, the desktop obtains its public Firebase client configuration from a signed HTTPS bootstrap envelope when the user first starts an online sign-in. Opening the app, opening Account settings, and typing an email address do not trigger this first fetch. It begins only after a valid sign-in form submission, before the email is sent. After verification and local persistence, the same sign-in continues without an app restart. Existing registered installations may restore previously enabled online services according to their saved account and feature state.

This flow is the same for packaged desktops and ordinary source launches. A launch with no `STRIDETERM_ENV` declaration selects `prod`; `dev.ps1` explicitly selects `local`. Explicit `local`, `dev`, and `qa` launches keep their own bootstrap trust and data-directory binding. An unrecognised environment is refused for online work and is never changed to `prod` automatically. Use a separate data directory when intentionally changing an installation's environment.

The production endpoint is [https://bootstrap.strideterm.com/prod.json](https://bootstrap.strideterm.com/prod.json). Its envelope contains public client configuration, including the Firebase Web API key. The endpoint is public and clients must be able to read it without authentication. Access control belongs in Firebase Auth, rules, App Check where supported, callable authorization, and quotas; hiding the client key is not an access control.

If no usable cached envelope exists and downloading or verification fails, the requested online sign-in cannot proceed; the email is not sent. Local app features remain available. A verified cached envelope can be used when a refresh fails. The bootstrap configuration is stored under the installation's data directory and its signature and environment are checked before use. No email address or installation identifier is sent to the bootstrap host.

The Firebase Web API key stays out of Git and out of the desktop build; the published envelope is public. The Android production build continues to receive its Firebase configuration at build time. This desktop bootstrap does not change native mobile configuration or distribution.

## Release check

Run `npm run check:production-bootstrap` before a production release. It fetches the public document, verifies its signature with the compiled production public keys, and checks the expected project and relay. The release workflow runs the same gate. This is a release operation, not an application-startup check.

The signing private keys and signed production payload are maintained in the private operations environment and must never be copied into this repository or a desktop build. Changes to the hosted envelope require the established private signing and publication procedure.
