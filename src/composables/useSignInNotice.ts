// "Your sign-in link was opened — come and confirm it."
//
// WHY THIS HAS TO EXIST AT ALL. Passwordless sign-in is the one flow in this app that REQUIRES the
// person to leave it: the link is in a mail client, and a message that takes eight minutes to arrive
// is ordinary rather than exceptional. So by the time the link is opened, the account panel is
// almost never the thing on screen — the person went back to work, which is exactly what they should
// be able to do.
//
// AND THE FLOW DOES NOT FINISH BY ITSELF. `awaiting-confirmation` is a deliberate stop: the payload
// has arrived and the last step is a person pressing confirm ON THIS DESKTOP, because a link that
// completed itself would be a link a stranger could complete. That design is right, and it has a
// consequence nobody was carrying — a stop nobody is told about is a stop that runs out the clock.
// The attempt then expires silently, and what the person sees when they eventually come back is an
// empty form and no explanation.
//
// SO THE HANDOFF IS THE WHOLE JOB. One persistent toast when the flow starts waiting on the desktop,
// taken away again the moment it stops waiting — confirmed, cancelled, superseded or expired. It is
// persistent rather than timed on purpose: a four-second toast for a thing that needs an action in
// another window is a toast that is gone before the person looks up.

import { watch } from "vue";

import { useAccountStore } from "../stores/account.js";
import { useNotificationStore } from "../stores/notifications.js";

/** The phase that means "the desktop is waiting for a press, and nothing else will happen until it gets one". */
const WAITING_ON_DESKTOP = "awaiting-confirmation";

export function useSignInNotice(): void {
  const account = useAccountStore();
  const notifications = useNotificationStore();
  let toastId: string | null = null;

  function clear(): void {
    if (toastId === null) return;
    notifications.dismissPersistentToast(toastId);
    toastId = null;
  }

  watch(
    // The panel's own visibility is part of the key, so walking away from an already-waiting
    // confirmation raises the notice too. Without it the toast would only ever appear for somebody
    // who was elsewhere at the exact moment the payload landed — and "I clicked the link, glanced at
    // the desktop, then went back to what I was doing" is a perfectly ordinary way to lose it.
    () => [account.auth?.phase ?? null, account.signInPanelMounted] as const,
    ([phase, panelOpen]) => {
      if (phase !== WAITING_ON_DESKTOP || panelOpen) {
        clear();
        return;
      }
      if (toastId !== null) return;
      toastId = notifications.pushPersistentToast({
        kind: "info",
        title: "Finish signing in to strIDEterm",
        // NO ADDRESS AND NO DEADLINE IN THE TEXT. The address is the customer's own and this toast
        // renders over whatever they are sharing or screenshotting; the deadline would be a number
        // that keeps being wrong, since a toast does not tick. The panel shows both, accurately, and
        // this is a pointer to the panel.
        body: "Your sign-in link was opened. Click to confirm it in Settings → Mobile → Account.",
        action: "open-mobile-account",
      });
    },
    { immediate: true },
  );
}
