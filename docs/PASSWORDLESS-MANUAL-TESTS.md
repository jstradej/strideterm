# Passwordless sign-in: the manual pass

> **Who this is for.** The full Electron app is verified by hand, through `dev.ps1`, by the user —
> that is this repository's own rule and the plan repeats it. This document is the other half of it:
> the concrete list of steps and the result each one should produce, so a pass is a comparison rather
> than an exploration. It is the deliverable the follow-up review's §6 asks the implementer for.
>
> **Nothing here has been performed by the implementation.** Every row is a step for a person with a
> keyboard, a mailbox, and in some cases a phone or a second machine. Rows that need something this
> repository cannot hold say so in their own **Needs** column, and they are the same rows
> `docs/PASSWORDLESS-PHASE0.md` §"By hand: what is left" carries in the cloud repository.

## Before you start

There is one exercisable configuration: **emulator only** (formerly "configuration A"). No message is
delivered; the Auth emulator prints the link. Broker origin `http://127.0.0.1:8788`. Start **all
three** emulators (`--only auth,database,functions`): the sign-in itself needs only Auth, but every
row after it — the enrolment, the trial, the device list, the address change — is a callable or an
RTDB write, and with those two emulators down they reach nothing. The exact steps are in
**`docs/PASSWORDLESS-LOCAL-TESTING.md`** in `C:/work/strideterm-mobile`.

**There used to be a second configuration here ("B" — the real dev Firebase project, real messages, a
locally-run broker at `http://localhost:8788`).** The environment-naming migration
(`plan-environment-naming-local-dev-qa-prod`, §2.1) retired it: `dev` now means a personal test against
a REAL, REMOTE broker (`https://auth-dev.strideterm.com`), and a real project reached through a
locally-run Worker is not `dev` under that vocabulary — v2 deliberately does not introduce the
diagnostic mode that would be needed to keep it. The rows below that used to say "B only" (2.2) or
that could be repeated in B (the closing section) are **not exercisable until `dev` is activated**
(plan §7); they are left in this document as open rows rather than deleted, the same way
`docs/PASSWORDLESS-PHASE0.md` §"By hand: what is left" tracks other not-yet-exercisable rows.

Two windows are needed for rows 3.5 and 3.6 (Ctrl+Shift+N, or the New Window menu item). A second
**data directory** is needed for row 1.6, a second **machine** for §7, and a **phone** for row 2.5.

Everything below reads the same account state, so after each row it is worth glancing at three things
on Settings → Mobile → Account: the phase heading, whether the device list is still there, and
whether a refusal is shown. Several rows are about exactly those three.

---

## 1. A new registration and a trial on one link, and a second PC without a second trial

| #   | Step                                                                                                                                                          | Expected                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Fresh data directory. Settings → Mobile → Account                                                                                                             | "Sign in", one address field, three intentions. **No password field anywhere**, and no "Forgot password" or "Create account"                                            |
| 1.2 | Choose **"Add this computer and start the free trial"**, type the address, Continue                                                                           | "Check your email", the address echoed, a countdown, and a resend button that is disabled with a countdown of its own                                                   |
| 1.3 | Open the link, from the emulator log, in a browser on this machine                                                                                            | The confirmation page asks for the address. Type it. It says the desktop finishes the sign-in                                                                           |
| 1.4 | Back on the desktop                                                                                                                                           | "Sign this computer in as …?" — **nothing is signed in yet**. This step exists so that a link a stranger opens cannot complete a sign-in                                |
| 1.5 | Press "Sign in on this computer"                                                                                                                              | ONE authentication, then: enrolled, trial active, the trial end DATE shown, this desktop listed as "this one". No second link is requested at any point                 |
| 1.6 | On the SAME account, from a second data directory (`.\dev.ps1 -DataDir …`), choose **"Add this computer to an account I already have"** and complete one link | The second desktop is enrolled and listed. The entitlement is the account's existing one — **no second trial, no second subscription**. The trial end date is unchanged |

## 2. The paste fallback, and web confirmation on a PC and on a real phone

| #   | Step                                                                                     | Needs                                                                              | Expected                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Stop the broker (or never start it). Ask for a link                                      |                                                                                    | The wait says the sign-in service could not be reached and that this link cannot be confirmed in the browser. The paste field is shown **without** having to expand it                            |
| 2.2 | Select the link's visible TEXT in the message and paste that                             | a real message — not exercisable until `dev` is activated (see "Before you start") | `invalid-code` — "That link did not work …". This is the documented trap: the plain-text part of the message carries the anchor's words and no URL                                                |
| 2.3 | Right-click the link, copy the ADDRESS, paste that                                       |                                                                                    | Accepted. The field is cleared the moment it is used, and the flow moves to "Sign this computer in as …?"                                                                                         |
| 2.4 | With the broker running, open the link in a browser on the SAME machine                  |                                                                                    | The confirmation page completes and the desktop moves to its own final step                                                                                                                       |
| 2.5 | Open the link from the message on a **physical phone**, in the mail client's own browser | **a phone, and a deployed or tunnelled HTTPS broker**                              | The page loads, asks for the address, and the DESKTOP moves to its final step. `localhost` cannot serve this — see "From a phone" in `PASSWORDLESS-LOCAL-TESTING.md` for the four things it needs |

## 3. Cancel, resend and closing the dialog — at each of the four moments

The point of this section is that the four moments are different: before anything was sent, while a
link is outstanding, while the code is being redeemed, and while the server is being asked who owns
this machine. A cancel at any of them must leave nothing behind.

| #   | Step                                                                                | Expected                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Press Continue and immediately "Use a different address"                            | Back to the sign-in form. No attempt is shown                                                                                                                     |
| 3.2 | While waiting for the link, press "Send it again" before the countdown ends         | Refused: the button is disabled and says how long is left. **No second message**                                                                                  |
| 3.3 | After the countdown, press "Send it again"                                          | A NEW link. The old one no longer works — the live service keeps one pending code per address — and the page says only the newest message works                   |
| 3.4 | Ask for a link, then close the Settings dialog                                      | The attempt ends. Reopening Settings shows the sign-in form, not a stale wait                                                                                     |
| 3.5 | Open Settings → Account in a SECOND window, then close **that** dialog              | The attempt in the first window is **untouched**: the link may be open on a phone at that moment                                                                  |
| 3.6 | With an attempt waiting, close the WINDOW that started it                           | The attempt ends. The other window's page shows the sign-in form                                                                                                  |
| 3.7 | Press "Sign in on this computer", then cancel while it says "Signing in…"           | The flow ends with "That sign-in was cancelled or replaced by a newer one". **Nothing is signed in**, and the destructive controls still ask to confirm it is you |
| 3.8 | Repeat 3.7 but start a NEW sign-in instead of cancelling, and complete the new link | The new sign-in succeeds. The abandoned one changes nothing when it finishes — no session, no enrolment, no trial                                                 |
| 3.9 | Double-click "Sign in on this computer"                                             | One sign-in. The second press is a no-op rather than a second redemption of the same code                                                                         |

## 4. Reauthentication — the right account, the wrong account, and after a restart

| #   | Step                                                                                                 | Expected                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Restart the desktop while enrolled                                                                   | The page is `ready` immediately: the entitlement, the usage and both device lists are there, with **no owner session at all**. That is the design — the owner credential is transient              |
| 4.2 | Press "Payment method, invoices and cancellation"                                                    | It asks for a link first (the address is already filled in), and opens the portal as soon as the link is confirmed. It does not fail, and it does not become "sign in, then find the button again" |
| 4.3 | Do the same but sign in as a **different** account's address                                         | Refused: "That is a different account. Disconnect this installation first, or use the right address." The device list, the entitlement and this machine's enrolment are **unchanged**              |
| 4.4 | After a successful reauth, wait five minutes and then press a destructive control                    | It asks to confirm it is you again. The five minutes is measured from the authentication, not from the last click                                                                                  |
| 4.5 | After a successful reauth, close the Settings dialog and reopen it, then press a destructive control | It asks for a link again. Closing the dialog ends the waiting credential                                                                                                                           |

## 5. Network failures and lost answers — three different expected results

Use the OS firewall, or an unreachable origin, to produce each failure at the named moment. The three
outcomes are deliberately different, and that difference is the whole of this section.

| # Failure                                  | Where                                        | Expected                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 The send request gets no answer        | `sendOobCode`                                | **Not** an error page. The wait says the service did not confirm whether the link was sent, that it may have arrived anyway, and that asking again stops the older link working. The SAME link, if it arrives, still completes the attempt. Exactly one message may exist |
| 5.2 The send is REFUSED                    | e.g. a malformed address                     | The attempt ends with a refusal naming the cause. No message exists                                                                                                                                                                                                       |
| 5.3 The lookup fails on the network        | after the code is redeemed                   | Retried over the same session while the two-minute window allows. If it never succeeds: a `network` refusal, **no owner session**, the enrolment and the device list intact                                                                                               |
| 5.4 The owner check fails on the network   | `confirmOwnerForInstallation`                | The same: retried, then a `network` refusal with nothing signed in and nothing rebound                                                                                                                                                                                    |
| 5.5 The owner check is REFUSED             | a different account's address                | `account-mismatch` immediately — a refusal is an answer and is not retried                                                                                                                                                                                                |
| 5.6 The `/claim` answer is lost            | the broker                                   | Repeatable: the payload is not consumed by a claim, so the next poll gets it. The person sees nothing                                                                                                                                                                     |
| 5.7 The trial's answer is lost             | `startTrial` after a successful registration | The machine **stays enrolled**. The page offers to start the trial alone; taking that offer asks for a link with the trial pinned and performs only the trial. No second registration, and no second trial on the server                                                  |
| 5.8 The whole control plane is unreachable | at start-up                                  | The page shows what it last knew, the local app is unaffected, and the first foreground action reports a real error rather than "not enrolled"                                                                                                                            |

## 6. Changing the login address

| #   | Step                                                 | Expected                                                                                                                                                                                                 |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Reauthenticate, then ask to change the login address | "Check the new mailbox" — and nothing about whether that address was free. That answer is deliberate: a different one would be a way to ask whether somebody has an account here                         |
| 6.2 | Before opening the new link, sign in again           | The **ORIGINAL** address still works. The change lands only when the new mailbox is opened                                                                                                               |
| 6.3 | Restart the desktop while the change is pending      | The pending note is **gone** — it is not persisted, because the only party that knows whether the mailbox was opened is Firebase. The page shows the real state, and the original address still signs in |
| 6.4 | Open the new link                                    | The address moves, the uid does not, and the account keeps its entitlement, its devices and its pairings                                                                                                 |
| 6.5 | Sign in with the OLD address afterwards              | It creates a **new, empty** account. The old address is no longer this account's, and nothing about the original account is visible from it                                                              |

## 7. Two PCs in one phone app

| #   | Step                                                                  | Needs                 | Expected                                                                                                  |
| --- | --------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| 7.1 | Pair the phone with both desktops                                     | two machines, a phone | Both appear in the phone's list and both work                                                             |
| 7.2 | Revoke ONE desktop from the account page                              |                       | The revoked one loses hosted access; **the other keeps working**, keeps its pairing and stays in the list |
| 7.3 | Sign in as the owner on the second PC while the first holds a session |                       | Both machines stay enrolled. Neither sign-in cancels the other's installation identity                    |

## 8. Nothing sensitive is in a log, a validation error or a diagnostics report

| #   | Step                                                                                                                                                | Expected                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Run a whole sign-in with `STRIDETERM_LOG_LEVEL=trace`, then search the dev log for the `oobCode`, the pasted link, the claim secret and the address | **No hits** for the code, the link or the secret. The address appears only where a person typed it into the UI                              |
| 8.2 | Paste deliberate rubbish into the paste field                                                                                                       | A refusal in our own words. The log line and the message carry **neither** the text pasted nor a code                                       |
| 8.3 | Export a diagnostics report and read it                                                                                                             | Operation names, outcomes and durations. No token, no code, no secret, no URL, and no provider identifier                                   |
| 8.4 | Look at the account state a second window receives (devtools)                                                                                       | A phase, the address a link was sent to, a deadline, a resend time, a send outcome. **No code, no claim secret, no token, no checkout URL** |

## 9. An operation replaced while its answer is still out (S01–S04, T01–T02)

The second follow-up review's four findings, and the third review's two, are all the same shape: an
operation is started, its answer is held up, the person does something NEWER, and then the old answer
arrives. Each
row needs a way to hold one request — the OS firewall on the callable host, a breakpoint in
`account-transport.ts`, or a throttled emulator — and the dev log (`~/.strideterm-dev/logs`) open, because
the log line is half of the expected result. Every line named below carries operation names, fixed codes
and counters, and never an address, a token or a key.

| #    | Step                                                                                                                                                                                                                                                                                                                      | Expected                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1  | On an unenrolled machine, sign in to enrol and hold `completeInstallationRegistration`. Cancel. Sign in as a DIFFERENT owner and let that enrolment finish. Release the held answer, arranged to be a refusal (e.g. at the cap)                                                                                           | The page stays **enrolled** under the second owner. The log has `a registration answered after a newer binding was applied; not written` with `answer: refused`, followed by one more overview read. Restart the app: still enrolled. The first owner's refusal appears nowhere on the page                                                                                       |
| 9.2  | Same hold, and this time the held answer is a SUCCESS. Cancel, then **sign this installation out**. Release the answer                                                                                                                                                                                                    | The page stays **signed out**. The log has the same `not written` line with `answer: registered`, then `the binding could not be re-read after a late registration answer` (the credential is gone). Restart: still signed out — a fresh identity is minted, not the old uid                                                                                                      |
| 9.3  | Sign in, press "Add this desktop", and hold the INSTALLATION token refresh (or the challenge request itself). Cancel while it is held. Release                                                                                                                                                                            | **No new request** reaches the server after the release: the emulator's Functions log shows no `beginInstallationRegistration` for it. The log has `enrol-installation failed` with `code: sign-in-superseded`, `reason: aborted`, `abandoned: true`. The page says the sign-in was cancelled or replaced — **not** that the network failed                                       |
| 9.4  | Sign in to change the login address, hold the change request, close the Settings dialog, sign in again as a DIFFERENT owner. Release the held request                                                                                                                                                                     | The second owner is still signed in, the destructive controls do not ask for a fresh sign-in until the five-minute window ends, and the "change to … is waiting" note is **not** shown beside the second owner (it is shown again once nobody is signed in). The log has `cleanup left a newer owner session alone` with `operation: change-login-email`                          |
| 9.4b | As 9.4, but before releasing the held request have the second owner request THEIR OWN address change and see its note appear. Then release the first request                                                                                                                                                              | The note still names the SECOND owner's new address — with them signed in and after their session ends. The log has `a late login-email change answer left a newer pending note alone` with `operation: change-login-email`, `sameAccount: false`                                                                                                                                 |
| 9.5  | Sign in, open a checkout for offer A and hold it. Cancel, sign in as a DIFFERENT owner, cut the network, open a checkout for offer B (it fails as `network`). Release A. Restore the network and retry B                                                                                                                  | Exactly ONE intent for B exists on the server, under the key of the first B attempt — the Functions log shows the same `idempotencyKey` twice for B. A's URL is never opened. The log has `a late mutation answer left a newer pending record alone` with `mutation: checkout`, and `a mutation's outcome is unknown; its key and request are kept for a retry` for B's first try |
| 9.6  | Double-click "Start trial" (or "Open checkout") so the second press lands while the first request is out                                                                                                                                                                                                                  | One request on the server, one key. The log has `a mutation already in flight is shared rather than sent again`                                                                                                                                                                                                                                                                   |
| 9.7  | On an unenrolled machine, hold the START-UP overview read (`getAccountOverview` is the first callable the app issues; the runtime does not wait for it). While it is held, sign in and enrol this desktop, and see the page say enrolled. Release the held read — the server's answer for it is `not-bound-to-an-account` | The page stays **enrolled** and keeps the overview the enrolment read. The log has `an overview read failed after a newer binding was applied; not written` with `code: not-bound-to-an-account`. Restart the app with the backend unreachable: still enrolled — the marker was never rewritten to `none`                                                                         |
| 9.7b | As 9.7, but arrange for the held start-up read to SUCCEED late (release it after the enrolment, before the enrolment's own confirming re-read answers — a breakpoint on the second read does it)                                                                                                                          | The stale overview, which does not list this machine, is **not applied**: the page stays enrolled. The log has `an overview answered after a newer binding was applied; not written`                                                                                                                                                                                              |
| 9.8  | Sign in to change the login address, request a change to address A and hold it. Without signing in again, request a change to address B and let it finish (the note names B). Release A                                                                                                                                   | The note **still names B**, and its "requested" time is when B was asked. The log has `a late login-email change answer left a newer pending note alone` with `operation: change-login-email`, `sameAccount: true`                                                                                                                                                                |
| 9.8b | As 9.8, but between the two requests close the dialog and sign in AGAIN as the same owner; after B's request, sign in a third time so a session is open. Then release A                                                                                                                                                   | The note still names B; the third session is still signed in, the destructive controls do not ask for a fresh sign-in until ITS five-minute window ends. Variant: dismiss the note while A is held, then release A — the note stays dismissed                                                                                                                                     |
| 9.8c | Sign in to change the login address, request a change to address A and hold it. While it is held, sign out of the installation (disconnect). Release A                                                                                                                                                                    | No pending-address note appears — a machine that signed out does not grow one beside nobody from a request that was in flight when it did. The log has `a late login-email change answer left a newer pending note alone` with `sameAccount: false`                                                                                                                               |

---

## What a pass does and does not establish

A complete pass of §1, §3, §4, §5, §6, §8 and §9 (rows 9.1–9.8c) in the emulator configuration, with
the Auth, database and Functions emulators all up, establishes that the desktop, the broker, the
Durable Object, the confirmation page and the callables behind them agree, and that every failure
above produces the stated outcome. It establishes nothing about Firebase's real link, its message, its
quotas or its refusals — the emulator's answers differ from the live service's in ways that have
already been measured, most sharply the one behind row 3.3.

**Repeating §1–§2 and §6 against the real link and the real message is not possible locally any more**
(see "Before you start"): it waits for `dev`'s activation (plan §7), at which point row 2.2 and the
mail-client half of §2 become exercisable against the real, deployed broker rather than a local one.

Rows **2.5**, **7.1–7.3** and the mail-client half of §2 need a physical device, a second machine or a
deployment. Those are the rows `docs/PASSWORDLESS-PHASE0.md` §"By hand: what is left" tracks, and a
release is gated on them there rather than here.
