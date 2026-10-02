# Passwordless sign-in: the manual pass

The full Electron app is verified by hand through `dev.ps1`. This is the list of steps and the
result each one should produce, so a pass is a comparison rather than an exploration.

## Before you start

The configuration exercisable locally is **emulator only**: the Auth, Database and Functions
emulators (`--only auth,database,functions`) and the broker Worker on `http://127.0.0.1:8788`. No
message is delivered; the Auth emulator prints the link. The setup steps live beside the Worker in
the sibling `strideterm-mobile` repository (`docs/PASSWORDLESS-LOCAL-TESTING.md`). Rows that need a
real message, a phone or a second machine say so.

You also need a second window (Ctrl+Shift+N), a second data directory (`.\dev.ps1 -DataDir …`), and
for §7 a second machine and a phone. After each row glance at Settings → Account: the phase heading,
whether the device list is still there, and whether a refusal is shown.

## 1. Registration, trial, second PC

| #   | Step                                                                                               | Expected                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1.1 | Fresh data directory, Settings → Account                                                           | One address field and three intentions. No password, no "Forgot password", no "Create account"     |
| 1.2 | "Add this computer and start the free trial", type the address, Continue                           | "Check your email", the address echoed, a countdown, resend disabled with its own countdown        |
| 1.3 | Open the link from the emulator log in a browser                                                   | The confirmation page asks for the address, then says the desktop finishes the sign-in             |
| 1.4 | Back on the desktop                                                                                | "Email confirmed — finish on this computer". Nothing is signed in yet                              |
| 1.5 | Press "Sign in on this computer"                                                                   | One authentication: enrolled, trial active with its end date, this desktop listed                  |
| 1.6 | Same account from a second data directory, "Add this computer to an account I already have"        | Second desktop enrolled. No second trial or subscription; the trial end date is unchanged          |
| 1.7 | Unenrolled machine, "Restore a previous enrolment on this computer" for an account it was never on | "Nothing to restore for <address>" with "Yes, send a link" / "No". Nothing is registered           |
| 1.8 | On that prompt press "Yes, send a link", complete the link                                         | A plain enrolment (no trial). "No" instead returns to the form with the address kept, nothing sent |

## 2. Paste fallback and web confirmation

| #   | Step                                                           | Needs                       | Expected                                                                       |
| --- | -------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| 2.1 | Broker not running, ask for a link                             |                             | The wait says the service cannot be reached; the paste field is shown expanded |
| 2.2 | Paste the link's visible TEXT from a real message              | a real message (`dev` tier) | `invalid-code`: the plain-text part carries the anchor text, not the URL       |
| 2.3 | Right-click the link, copy its ADDRESS, paste                  |                             | Accepted, the field cleared, the flow moves to the final step                  |
| 2.4 | Broker running, open the link in a browser on the same machine |                             | The confirmation page completes and the desktop moves to its final step        |
| 2.5 | Open the link on a physical phone, in the mail app's browser   | a phone and an HTTPS broker | The page loads and the desktop moves to its final step                         |

## 3. Cancel, resend and closing the dialog

A cancel at any moment must leave nothing behind.

| #   | Step                                                  | Expected                                                                      |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| 3.1 | Continue, then immediately "Use a different address"  | Back to the form, no attempt shown                                            |
| 3.2 | "Send it again" before the countdown ends             | Disabled, says how long is left. No second message                            |
| 3.3 | "Send it again" after the countdown                   | A new link; the old one stops working and the page says only the newest works |
| 3.4 | Ask for a link, close the Settings dialog             | The attempt ends; reopening shows the form                                    |
| 3.5 | Open Account in a second window and close that dialog | The first window's attempt is untouched                                       |
| 3.6 | Close the window that started an attempt              | The attempt ends; the other window shows the form                             |
| 3.7 | Cancel while "Signing in…"                            | "That sign-in was cancelled or replaced by a newer one." Nothing signed in    |
| 3.8 | As 3.7 but start and finish a new sign-in instead     | The new one succeeds; the abandoned one changes nothing when it finishes      |
| 3.9 | Double-click "Sign in on this computer"               | One sign-in                                                                   |

## 4. Reauthentication and the remembered address

| #   | Step                                                                  | Expected                                                                                                            |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Restart while enrolled                                                | Entitlement, usage and device lists shown at once, with no owner session                                            |
| 4.2 | After 4.1                                                             | "Signed in as <full address>" (remembered on this computer); the address fields are prefilled                       |
| 4.3 | Press "Payment method, invoices and cancellation"                     | Asks for a link first — the remembered address is confirmed in the form, never sent unasked — then opens the portal |
| 4.4 | Reauthenticate as a different account's address                       | "That is a different account …". Devices, entitlement and enrolment unchanged                                       |
| 4.5 | Change the login address on another device, restart this one          | A dismissible notice that the remembered address no longer matches and was forgotten                                |
| 4.6 | After a reauth wait five minutes, press a destructive control         | Asks to confirm it is you again                                                                                     |
| 4.7 | After a reauth close and reopen Settings, press a destructive control | Asks for a link again                                                                                               |
| 4.8 | "Sign out of this desktop" with no recent reauth                      | Asks inline to confirm identity; the final sign-out button stays disabled until then                                |

## 5. Network failures and lost answers

| #   | Failure                                                  | Expected                                                                                        |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 5.1 | The send gets no answer                                  | Not an error page: the link may have arrived anyway; if it does, it still completes the attempt |
| 5.2 | The send is refused (bad address)                        | The attempt ends with a refusal naming the cause                                                |
| 5.3 | The account lookup fails on the network after redemption | Retried within the window, then `network`: no owner session, enrolment intact                   |
| 5.4 | The owner check fails on the network                     | Retried, then `network`; nothing signed in, nothing rebound                                     |
| 5.5 | The owner check is refused                               | `account-mismatch` at once, not retried                                                         |
| 5.6 | The broker's `/claim` answer is lost                     | The next poll gets it; the person sees nothing                                                  |
| 5.7 | The trial's answer is lost                               | Stays enrolled; the page offers the trial alone; no second registration or trial                |
| 5.8 | Control plane unreachable at start-up                    | Last known state shown, local app unaffected, the first action reports a real error             |

## 6. Changing the login address

| #   | Step                                      | Expected                                                                      |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| 6.1 | Reauthenticate, ask to change the address | "Check the new mailbox", and nothing about whether that address was free      |
| 6.2 | Sign in again before opening the new link | The original address still works                                              |
| 6.3 | Restart while the change is pending       | The pending note is gone (not persisted); the original address still signs in |
| 6.4 | Open the new link                         | The address moves; uid, entitlement, devices and pairings stay                |
| 6.5 | Sign in with the old address afterwards   | A new, empty account                                                          |

## 7. Two PCs in one phone app

| #   | Step                                                                  | Needs                 | Expected                          |
| --- | --------------------------------------------------------------------- | --------------------- | --------------------------------- |
| 7.1 | Pair the phone with both desktops                                     | two machines, a phone | Both listed and working           |
| 7.2 | Revoke one desktop from the account page                              |                       | Only that one loses hosted access |
| 7.3 | Sign in as the owner on the second PC while the first holds a session |                       | Both stay enrolled                |

## 8. Nothing sensitive in logs, errors or diagnostics

| #   | Step                                                               | Expected                                                                         |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 8.1 | Full sign-in with `STRIDETERM_LOG_LEVEL=trace`, search the dev log | No `oobCode`, pasted link or claim secret; the address only where typed          |
| 8.2 | Paste rubbish into the paste field                                 | A refusal in our own words; neither the text nor a code in log or message        |
| 8.3 | Export a diagnostics report                                        | Operation names, outcomes, durations. No token, code, secret, URL or provider id |
| 8.4 | Inspect the account state a second window receives (devtools)      | No code, claim secret, token or checkout URL                                     |

Races where an old answer arrives after a newer action (held requests, cancelled operations) need
breakpoints to reproduce by hand and are covered by unit tests in
`electron/backend/account/account-manager.test.ts`.

## What a pass establishes

A pass in the emulator configuration shows that the desktop, broker, confirmation page and callables
agree and that each failure produces the stated outcome. It says nothing about Firebase's real
message, quotas or refusals; rows marked with a real message, a phone or a second machine need a
deployed tier.
