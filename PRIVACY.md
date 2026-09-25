# strIDEterm — Privacy Policy

_Last updated: 25 September 2026_

This policy explains what personal data the **strIDEterm desktop app** (Windows, macOS and Linux,
including the version distributed through the Microsoft Store) and its **remote web client** access,
store and transmit, why, who receives it, and what control you have over it.

The strIDEterm Mobile app and the hosted services it shares with the desktop app are also covered by
the [strIDEterm Mobile Privacy Policy](https://strideterm.com/mobile/privacy/). Where this policy
describes the hosted services (account, subscription, phone pairing, managed relay), the two policies
say the same thing.

## Summary

- strIDEterm is a local developer tool. **Your terminals, files, workspaces, notes, settings and
  credentials stay on your computer.**
- The app contains **no analytics, no telemetry, no advertising and no automatic crash reporting.**
- Without any configuration, the only connection the app makes on its own is an anonymous check for
  a new version on GitHub, at most once a day.
- Everything else that leaves your computer does so only because you turned on a feature: the
  strIDEterm account and phone integration, the managed relay, a Telegram bot, a Cloudflare tunnel,
  or connections to GitHub or Azure DevOps.
- We do not sell your data or share it for advertising.

## Who we are

The controller of your personal data is **Jaromír Straděj**, sole trader, Company ID (IČO) 70254851,
Czech Republic ("we", "us").

Contact for all privacy matters: **support@strideterm.com**

## Data stored only on your computer

The app keeps its data in a folder in your user profile — `%USERPROFILE%\.strideterm` on Windows and
`~/.strideterm` on macOS and Linux (or the folder you choose with `--data-dir`). We have no access to
it. It contains:

- **Workspaces and settings**: workspace names, project folders, notes, layout, profiles, SSH host
  entries and their key fingerprints, paired phones (name, type, public key, when last seen), and
  Telegram chat identifiers.
- **Credentials**: access tokens you enter (GitHub, Azure DevOps, Telegram bot), SSH keys, passwords
  and passphrases, and the app's own device keys and account sign-in token. They are stored in
  `credentials.json`, encrypted with your operating system's secure storage (Windows DPAPI, macOS
  Keychain, Linux Secret Service). If that storage is not available, the app warns you and — except
  for SSH secrets — stores them only encoded, not encrypted.
- **Logs**: technical logs of the app, rotated by size. Tokens, passwords, sign-in links and similar
  secrets are removed before a line is written. When remote access is on, a separate log records each
  remote request with its time, path, result and the IP address of the device that made it.
- **Activity records**: local databases of recent Git, GitHub, Azure DevOps, Telegram, phone and
  AI-agent permission-approval activity, so you can review what happened. They are deleted
  automatically after 30 days, and you can delete them earlier in the app.
- **Pull-request review data**: pull requests, comments and drafts you work on in the review panel,
  kept until you remove them.
- **Files you transfer** from the remote or mobile client, saved in the project's `.strideterm`
  folder. Unfinished transfers are removed after 24 hours.
- **Browser tab data**: the built-in browser tab stores cookies and site data of the pages you open,
  like any browser.
- **Terminal output** is held in memory while the app runs so that it can be shown again after a
  reconnect; it is not written to disk by the app.

**AI agent integrations.** If you choose to set up notifications for an AI coding agent (for example
Claude Code, Codex, Gemini CLI, GitHub Copilot CLI or OpenCode) in Settings, the app adds a hook entry
to that agent's configuration file in your user profile, and keeps a small routing file in
`~/.strideterm-hooks`. The agent's hook messages (for example the tool it wants to use and a short
summary of the command) are sent only to the app on your own computer (`127.0.0.1`).

**Plugins.** Plugins run with the same access as the app. Plugins bundled with strIDEterm make no
network connections. If you install a third-party plugin, its data practices are the responsibility
of its author.

## Data that leaves your computer

### Version check (always on)

About 10 seconds after start, and at most once every 24 hours, the app asks GitHub
(`api.github.com`) for the list of strIDEterm releases. The request contains no personal data or
identifiers; GitHub sees your IP address and the app's version, as with any web request. The app
does not update itself — it only tells you that a new version exists.

### strIDEterm account and hosted services (only if you sign in)

The account, subscription, free trial, phone pairing, push notifications and the managed relay are
optional hosted services. They are off until you sign in.

- **Sign-in**: you sign in with your **email address** and a one-time link we email to you. The
  sign-in service (`auth.strideterm.com`) keeps your email address and the one-time code only for the
  few minutes the sign-in takes; our provider's recovery copies may hold them for up to 30 days.
- **Account data**: email address, account and installation identifiers, the name of your computer
  (its hostname, used as the desktop's name in your device list), device public keys and
  fingerprints, when a device was registered and last online, and your subscription status, plan and
  billing period with the related Paddle identifiers. We use it to sign you in, provide the features
  you are entitled to, run the free trial and send service messages about your account. We do not
  use your email address for marketing.
- **Notifications and commands** between your computer and your phone (for example excerpts of
  terminal output, the command being run, messages from AI agents or pull-request details) are
  **end-to-end encrypted** between your devices. We cannot read their content. To deliver them we
  process metadata such as device, profile and workspace identifiers, timestamps, delivery status and
  the type and priority of a notification.
- **Remote sessions through the managed relay** (`relay.strideterm.com`) are **end-to-end
  encrypted** between your phone and your computer when both support it; the relay only forwards
  encrypted data and processes technical data such as connection and session identifiers, timing,
  data volumes and IP addresses. It does not pass your phone's IP address on to your computer. If
  end-to-end encryption cannot be established, the app says so and the relay processes the session
  content in transit over TLS, without storing it.
- **Payments** are handled by Paddle, the merchant of record. Checkout and the billing portal open in
  your web browser; the app never sees your card details. We give Paddle your email address so it can
  sell and manage your subscription.
- **Free trial**: to prevent repeated trials we keep a pseudonymous record that an installation has
  already used its trial. It does not contain your name or email address.
- **Security**: we process usage counters and security events to protect the service and enforce
  fair-use limits.

### Diagnostics report (only when you send one)

In **Settings → Mobile → Account** you can send us a diagnostics report. The app shows you the report
before it is sent, and you can save it to a file instead. It contains event codes, status, durations,
shortened identifiers, the app version, your operating system and its version, and your optional
note — no file paths, terminal output, tokens or email address. We keep it for 14 days.

### Integrations you configure

These connect to third parties under **their** privacy policies. We do not receive this data.

- **GitHub and Azure DevOps**: the app calls the GitHub or Azure DevOps server you configure with the
  access token you provide, to show and work with pull requests, pipelines and repositories.
- **Telegram**: if you connect a Telegram bot, the app sends it the alerts you choose, and when you
  ask for them, window screenshots and task files. Telegram messages are **not end-to-end encrypted**
  and are processed by Telegram (`api.telegram.org`).
- **Cloudflare Quick Tunnel**: if you start a tunnel, your remote-access traffic is carried through
  Cloudflare's network (`trycloudflare.com`) and is **not** covered by our end-to-end encryption.
- **Remote access on your local network**: if you turn remote access on, the app accepts connections
  from other devices (plain HTTP on port 43123 by default, protected by an access token). Use it only
  on networks you trust.
- **Git, SSH, Docker, the built-in browser** and anything you run in a terminal connect to the hosts
  you choose. The app only starts them for you.

## Legal bases

- **Performance of a contract** (Art. 6(1)(b) GDPR): providing the app and the hosted services, your
  account, subscription, free trial, service messages and support.
- **Legitimate interests** (Art. 6(1)(f) GDPR): the version check, security, preventing abuse and
  repeated free trials, fair-use limits, troubleshooting and diagnostics reports, and establishing or
  defending legal claims.
- **Legal obligation** (Art. 6(1)(c) GDPR): where the law requires us to keep or disclose data.

An email address is needed to create an account. Without one, the hosted features cannot be used;
everything else in the app works without an account.

## Who receives your data

Service providers that process data on our behalf under data processing agreements:

- **Google** (Firebase Authentication, Realtime Database, Cloud Functions, Cloud Messaging, Google
  Cloud Storage): account, pairing, message delivery, push notifications and backups. Our database
  and server functions run in the EU (`europe-west1`).
- **Cloudflare**: the sign-in service and the managed relay.
- **Resend**: delivery of sign-in emails.

Independent controllers, under their own privacy policies:

- **Paddle** ([privacy policy](https://www.paddle.com/legal/privacy)): payments and subscription
  management.
- **GitHub**: the version check, and the GitHub integration if you use it.
- **Microsoft**: if you install strIDEterm from the Microsoft Store, Microsoft processes data about
  the purchase and installation under the
  [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).
- **Telegram, Cloudflare (Quick Tunnel), Azure DevOps** and any other service you connect yourself.

Within our operation, data is accessible only to people who need it to run the service or handle your
requests. We disclose data to public authorities only where the law requires it.

## Transfers outside the EU

Some providers are based in, or may process data in, the United States or other countries outside
the European Economic Area. Such transfers rely on an adequacy decision of the European Commission
(including the EU–U.S. Data Privacy Framework for certified companies) or on the European
Commission's Standard Contractual Clauses.

## How long we keep data

- **On your computer**: until you delete it. Activity records are deleted after 30 days, unfinished
  file transfers after 24 hours.
- **Account data**: for as long as your account exists.
- **Short-lived service data**: pairing invitations are deleted after 2 minutes, commands and their
  results after 24 hours, undelivered notifications after 7 days, sign-in requests within minutes.
- **Diagnostics reports**: 14 days.
- **Security records**: for as long as needed to protect the service and to establish or defend legal
  claims.
- **Billing records**: for as long as needed to manage your subscription, handle refunds and disputes,
  and meet legal obligations.
- **The free-trial record**: kept to prevent repeated trials, also after your account is deleted.
- **Backups**, including our providers' recovery copies: kept for a limited period for disaster
  recovery. Deleted data can remain in backups until they expire.

## Security

- Connections to our services, GitHub, Telegram and Paddle use TLS.
- Phone notifications, commands and managed-relay sessions are end-to-end encrypted (X25519 key
  agreement, AES-256-GCM) where both devices support it.
- Stored credentials are encrypted with your operating system's secure storage.
- Secrets are removed from logs.
- Remote access is off by default and protected by an access token.

No system is completely secure. Keep the pairing QR code and the remote-access token private: anyone
who has them can try to connect. To report a security problem, see [SECURITY.md](SECURITY.md).

## Your choices and controls

- **Use the app without an account.** Hosted features stay off until you sign in.
- **Turn features off** in Settings: the phone integration, the managed relay, remote access, the
  Cloudflare tunnel, Telegram, GitHub and Azure DevOps connections, and AI agent hooks. Turning a
  feature off stops the data flows it causes.
- **Unpair a phone** in Settings → Mobile. It loses access immediately and its push token is deleted.
- **Delete your account** in **Settings → Mobile → Account → Delete account**, or write to
  support@strideterm.com. Your subscription is cancelled and your account data is deleted, except for
  the data described above as kept after deletion.
- **Delete local data** by deleting the `.strideterm` folder in your user profile. Uninstalling the
  app, including through the Microsoft Store, does not remove this folder, so that your workspaces
  survive a reinstall. Hook entries added for AI agents stay in those agents' configuration files
  until you remove them there.

## Your rights

Under the GDPR you have the right to access your personal data, to have it corrected or erased, to
restrict its processing, to object to processing based on our legitimate interests, and to data
portability. To exercise these rights, write to support@strideterm.com. We may need to verify that
the request comes from you. We will never ask for passwords, sign-in links, private keys or card
details.

You also have the right to lodge a complaint with a supervisory authority. In the Czech Republic this
is the Office for Personal Data Protection (Úřad pro ochranu osobních údajů), Pplk. Sochora 27,
170 00 Praha 7, [uoou.gov.cz](https://uoou.gov.cz).

## Children

strIDEterm is a tool for software developers and is not intended for children under 16. We do not
knowingly collect personal data from children.

## Automated decisions

We do not make decisions based solely on automated processing that have legal or similarly
significant effects on you.

## Changes to this policy

We update this policy when the app's data practices change. The current version is always published
in this file with its date. If we make significant changes, we will let you know in an appropriate
way, for example in the app or in the release notes.
