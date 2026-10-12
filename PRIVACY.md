# strIDEterm — Privacy Policy

_Last updated: 12 October 2026_

This policy explains what personal data the **strIDEterm desktop app** (Windows, macOS and Linux,
including the version distributed through the Microsoft Store) and its **remote web client** access,
store and transmit, why, who receives it, and what control you have over it.

The strIDEterm Mobile app has its own [Privacy Policy](https://strideterm.com/mobile/privacy/). Read it
alongside this policy when using Mobile; it covers the mobile app and hosted-service details that
apply to it.

## Summary

- strIDEterm stores workspaces, settings, files and credentials on your computer by default. Optional
  hosted features and integrations can transmit the specific data described below.
- The desktop app does not send product-usage analytics or automatic crash reports. Hosted services
  process account-usage counters and security events if you sign in. The app does not show ads.
- The app checks GitHub for a new version at most once a day. GitHub receives the request's IP address
  and app version.
- Other transfers happen when you use hosted account and phone features, configure an integration,
  or connect to hosts through Git, SSH, Docker, the built-in browser or a terminal command.
- We do not sell your data or share it for advertising.

## Who we are

The controller of your personal data is **Jaromír Straděj**, sole trader, Company ID (IČO) 70254851,
Czech Republic ("we", "us").

Contact for all privacy matters: **support@strideterm.com**

## Data stored locally by the desktop

The app keeps its data in a folder in your user profile — `%USERPROFILE%\.strideterm` on Windows and
`~/.strideterm` on macOS and Linux (or the folder you choose with `--data-dir`). This folder is not
automatically uploaded to us; optional features can transmit the data described below. It contains:

- **Workspaces and settings**: workspace names, project folders, notes, layout, profiles, SSH host
  entries and their key fingerprints, paired phones (name, type, public key, when last seen), and
  Telegram chat identifiers.
- **Credentials**: access tokens you enter (GitHub, Azure DevOps, Telegram bot), SSH keys, passwords
  and passphrases, and the app's own device keys and account sign-in token. They are stored in
  `credentials.json`. When available, your operating system's secure storage protects them (Windows
  DPAPI, macOS Keychain, Linux Secret Service). If secure storage is unavailable, the app warns you
  and some credentials may be stored as base64 text, which is not encryption. SSH credentials are
  refused by default without secure storage, but can be explicitly allowed in configuration; Mobile
  integration keys require secure storage.
- **Logs**: technical logs of the app, rotated by size. The logger redacts recognized patterns for
  common secrets, such as authorization tokens and credential fields. Redaction may not catch every
  sensitive value. When remote access is on, a separate log records each remote request with its
  time, path, result and the IP address of the device that made it.
- **Activity records**: local databases of recent Git, GitHub, Azure DevOps, Telegram, phone and
  AI-agent permission-approval activity, so you can review what happened. The app prunes records
  older than 30 days at startup; you can delete them earlier in the app.
- **Pull-request review data**: pull requests, comments and drafts you work on in the review panel,
  kept until you remove them.
- **Files you transfer** from the remote or mobile client, saved in the project's `.strideterm`
  folder. Unfinished transfers become eligible for cleanup after 24 hours; cleanup runs when a later
  transfer starts.
- **Browser tab data**: the built-in browser tab stores cookies and site data of the pages you open,
  like any browser.
- **Terminal output** is held in memory while the app runs so that it can be shown again after a
  reconnect; it is not written to disk by the app.

**AI agent integrations.** If you choose to set up notifications for an AI coding agent (for example
Claude Code, Codex, Gemini CLI, GitHub Copilot CLI or OpenCode) in Settings, the app adds a hook entry
to that agent's configuration file in your user profile, and keeps a small routing file in
`~/.strideterm-hooks`. The agent's hook messages (for example the tool it wants to use and a short
summary of the command) are sent to the app on your own computer (`127.0.0.1`).

**Plugins.** Plugins run with the same access as the app. Plugins bundled with strIDEterm make no
network connections. If you install a third-party plugin, its data practices are the responsibility
of its author.

## Data that leaves your computer

### Version check (always on)

About 10 seconds after start, and at most once every 24 hours, the app asks GitHub
(`api.github.com`) for the list of strIDEterm releases. The request does not include your account
details; GitHub receives your IP address and the app's version, as with any web request. The app
does not update itself — it only tells you that a new version exists.

### strIDEterm account and hosted services (only if you sign in)

The account, subscription, free trial, phone pairing, push notifications and the managed relay are
optional hosted services. They are off until you sign in.

- **Sign-in**: you sign in with your **email address** and a one-time link we email to you. The
  sign-in service (`auth.strideterm.com`) uses the email address and one-time code for the sign-in
  flow, which expires within minutes. Provider recovery copies may retain data for up to 30 days.
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
  already used its trial, including after account deletion. It does not contain your name or email
  address.
- **Security**: we process usage counters and security events to protect the service and enforce
  fair-use limits.

### Diagnostics report (only when you send one)

In **Settings → Mobile → Account** you can send us a diagnostics report. The app shows you the report
before it is sent, and you can save it to a file instead. It contains event codes, status, durations,
shortened identifiers, the app version, your operating system and its version, and your optional
note. The collected diagnostic fields do not include file paths, terminal output, tokens or your
email address. Review your note before sending. Reports have a 14-day retention period; removal is
handled through service cleanup and the backup handling described below.

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

- **On your computer**: until you delete it. The app prunes activity records older than 30 days at
  startup. Unfinished file transfers older than 24 hours are cleaned up when a later transfer starts.
  These records and files may remain longer while the app or relevant feature is inactive.
- **Account data**: for as long as your account exists.
- **Short-lived service data**: pairing invitations expire after 2 minutes; commands and their
  results have expiry windows of up to 24 hours; undelivered notifications expire after up to 7 days;
  sign-in requests expire within minutes. Expired records are subject to service cleanup; physical
  deletion may happen later.
- **Diagnostics reports**: a 14-day retention period, with removal through service cleanup.
- **Security records**: for as long as needed to protect the service and to establish or defend legal
  claims.
- **Billing records**: for as long as needed to manage your subscription, handle refunds and disputes,
  and meet legal obligations.
- **The free-trial record**: retained after account deletion to prevent the same installation from
  starting another trial; it does not contain your name or email address.
- **Backups**, including our providers' recovery copies: kept for a limited period for disaster
  recovery. Deleted data can remain in backups until they expire.

## Security

- Connections to our services, GitHub, Telegram and Paddle use TLS.
- Phone notifications, commands and managed-relay sessions are end-to-end encrypted (X25519 key
  agreement, AES-256-GCM) where both devices support it.
- Stored credentials use your operating system's secure storage when available. If it is unavailable,
  see the credential-storage note above.
- The logger redacts recognized patterns for common secrets; it may not identify every sensitive
  value.
- Remote access is off by default and protected by an access token.

No system is completely secure. Keep the pairing QR code and the remote-access token private: anyone
who has them can try to connect. To report a security problem, see [SECURITY.md](SECURITY.md).

## Your choices and controls

- **Use the app without an account.** Hosted features stay off until you sign in.
- **Turn features off** in Settings: the phone integration, the managed relay, remote access, the
  Cloudflare tunnel, Telegram, GitHub and Azure DevOps connections, and AI agent hooks. Turning a
  feature off stops future transfers initiated by that feature; data already sent remains subject to
  the retention periods above.
- **Unpair a phone** in Settings → Mobile to revoke its pairing and remove its registered push token.
- **Request account deletion** in **Settings → Mobile → Account → Delete account**, or write to
  support@strideterm.com. The hosted service processes the deletion request and may need additional
  time to complete subscription cancellation with the payment provider. Data described above as
  retained after account deletion is not removed with the account.
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

Updates to this policy are published here with a revised date. We provide additional notices where
required by applicable law.
