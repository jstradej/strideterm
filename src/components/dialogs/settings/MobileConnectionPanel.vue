<template>
  <div class="mobile-tab">
    <RemoteAccessPauseControl v-if="showPauseControl" />
    <p v-if="paused" class="mobile-tab__intro" role="status">
      Mobile access is paused along with other remote connections. Your phones remain paired.
    </p>
    <fieldset class="mobile-tab__controls" :disabled="paused">
      <!--
      THE ACCOUNT COMES FIRST, because it is what everything below it is billed against: without a
      subscription there is a pairing screen that cannot complete. It is a section here rather than a
      tab of its own (see SettingsDialog's MOBILE_TAB comment) — the desktop itself needs no account,
      and a second tab implied otherwise.
    -->
      <section v-if="accountAvailable" class="mobile-tab__section">
        <h3 class="mobile-tab__section-title">Account and subscription</h3>
        <SettingsAccountTab />
      </section>

      <!-- id targeted by SettingsAccountTab.vue's "Connect phone" button (plan §6, Fáze B) -->
      <h3 v-if="accountAvailable" id="mobile-tab-phone-pairing" class="mobile-tab__section-title">Phone pairing</h3>
      <p class="mobile-tab__intro">
        Pair strIDEterm Mobile to open your profiles and terminals, receive notifications, and respond from your phone.
      </p>

      <!-- THE ONE STEP THAT IS ACTUALLY AVAILABLE, and nothing else. A phone pairs to an installation,
         so there is nothing to pair to until this computer is registered — and every control below
         would fail for a reason that is not where the person is looking. -->
      <p v-if="accountAvailable && !installationRegistered" class="mobile-tab__intro mobile-tab__intro--note">
        Register this computer first, in <strong>Account and subscription</strong> above. Pairing becomes available as
        soon as it is registered.
      </p>
      <!-- `pairingReady` rather than `installationRegistered` so a build with NO account surface at all
         (the remote web client already loses the whole section; a build with no control plane keeps
         it) behaves as it always did, instead of being told to go and register somewhere that does
         not exist. -->
      <template v-if="pairingReady">
        <p
          class="mobile-tab__intro mobile-tab__intro--note"
          title="A paired phone cannot start a brand-new public exposure by itself — it can only resume a tunnel mechanism this desktop already explicitly enabled in Remote Access settings."
        >
          A paired phone can only <strong>resume</strong> a remote tunnel this desktop has already explicitly enabled —
          it can never turn on a new public exposure by itself.
        </p>

        <!-- BEFORE THE FIRST PHONE, THE STEP — NOT THE SETTING. The checkbox's real job is the ongoing
           one its own tooltip describes: silence a paired phone without unpairing it. As the gate in
           front of a first pairing it was a second, unexplained question asked of somebody who had
           just registered this computer and started a trial FOR these features, and who then found
           an unticked box and no stated reason. So until there is something to silence, the page
           offers the thing they came to do; the switch itself lives in Advanced at the bottom, since
           by the time it has a job the answer to "do I want this?" is already yes. -->
        <template v-if="!mobileEnabled && mobileDevices.length === 0">
          <button type="button" class="button" :disabled="enableBusy" @click="enableMobile">
            <span v-if="enableBusy" class="mobile-tab__spinner" aria-hidden="true"></span>
            Turn on phone pairing
          </button>
          <p class="mobile-tab__intro mobile-tab__intro--muted">
            This opens the connection to the account service so a phone can be paired and receive pushes. You can turn
            it off again at any time, without unpairing anything.
          </p>
          <p v-if="enableError" class="mobile-tab__error">{{ enableError }}</p>
        </template>
      </template>

      <template v-if="pairingReady && mobileEnabled">
        <!--
        The pairing SAS, and the decision that turns it into an authorization (review 3 §P0.1).

        Both ends derive this from the same transcript — both public keys, both device ids, the
        pair and the invitation — and neither takes it from the backend (review 2 §P0.4). The phone
        shows the same code and tells the user to compare it here; a control plane that substituted
        a key produces two codes that differ, which is the one part of the pinning story a person
        rather than a rule enforces. Nothing is shown when the desktop could not derive a code:
        inventing a placeholder would train the user to accept whatever appears.

        WHAT CHANGED. This block used to have one button, "I compared them", which hid the code and did
        nothing else: the device was already live by the time it appeared, and the remedy for a mismatch
        was the prose "revoke the device below and pair again" — i.e. after the fact. The two buttons
        below are the actual gate. Until "Codes match" is pressed, the device receives no event, executes
        no command and gets no WebView session; "Mismatch" revokes it outright; and closing this dialog
        without choosing leaves it inert until the server's pending-approval TTL sweeps it.
      -->
        <div v-if="pairingSas" ref="sasBlock" class="pairing-sas">
          <p class="pairing-sas__title">Compare this code with the phone</p>
          <p class="pairing-sas__code">{{ pairingSas.sas }}</p>
          <p class="pairing-sas__hint">
            <strong>{{ pairingSas.label || "The new device" }}</strong> is showing a code for this pairing right now. It
            can do nothing at all until you confirm the two match. If they differ, choose Mismatch — a code that does
            not match means the two ends are not holding the same keys, and something has substituted one of them.
          </p>
          <p v-if="approvalError" class="pairing-sas__error">{{ approvalError }}</p>
          <div class="pairing-sas__actions">
            <button
              type="button"
              class="button button--primary"
              :disabled="approvalBusy"
              title="Activate this device. Only press this if the code above matches the one on the phone."
              @click="approvePairing"
            >
              Codes match — activate
            </button>
            <button
              type="button"
              class="button button--danger"
              :disabled="approvalBusy"
              title="Revoke this device. Its cloud access, token and queued commands are removed."
              @click="rejectPairing('sas-mismatch')"
            >
              Mismatch — revoke
            </button>
            <button
              type="button"
              class="button button--ghost"
              :disabled="approvalBusy"
              title="Decide later. The device stays inactive and is revoked automatically if you never confirm."
              @click="dismissSas"
            >
              Decide later
            </button>
          </div>
        </div>

        <!-- Pairing.

           HIDDEN WHILE A CODE IS PENDING, so the code takes the place on screen the QR had. The
           person has just held their phone up to that QR; the next thing they are told to do is
           compare a code, and leaving the QR (and a second "+ Pair device" button) below it left
           them scrolling a long tab looking for the one step that was actually theirs. "Decide
           later" brings this back. -->
        <div v-if="!pairingSas" class="pairing-section">
          <!--
          PAIR FIRST, NARROW LATER (and most people never will).

          This used to open with twelve checkboxes — one row of profiles and one row of capabilities,
          in identical boxes with no headings, so "Default" read as a sibling of "Receive
          notifications" and the two questions looked like one list. They were also all ticked
          already, which is the tell: the screen was asking a question whose answer it had itself
          filled in. So the grant is stated in a sentence, the button is the next thing, and the
          twelve boxes are behind a disclosure for the person who actually came to restrict
          something. Nothing is removed — `Edit access` on the device row does the same job after
          the fact, which is where a real "this phone should not touch that profile" decision tends
          to get made anyway.
        -->
          <template v-if="!activePairing">
            <p class="pairing-section__label">
              The new phone gets <strong>{{ pairingGrantSummary }}</strong
              >. You can change that per device afterwards, with <em>Edit access</em>.
            </p>
            <button
              type="button"
              class="button"
              :disabled="pairingBusy"
              title="Generate a single-use QR code. Valid for 120 seconds — scan it with strIDEterm Mobile's Pair device screen."
              @click="startPairing"
            >
              {{ pairingBusy ? "Creating…" : "+ Pair device" }}
            </button>
            <p v-if="pairingError" class="mobile-tab__error">{{ pairingError }}</p>
            <details class="pairing-limits">
              <summary class="pairing-limits__summary">Limit what this phone may use</summary>
              <p class="pairing-section__label">
                All current and future profiles are included. Exclude individual profiles with Edit access after
                pairing.
              </p>
              <p class="pairing-section__label">What it may do</p>
              <div class="pairing-picker">
                <label
                  v-for="cap in CAPABILITY_OPTIONS"
                  :key="cap.id"
                  class="form-label form-label--inline"
                  :title="cap.title"
                >
                  <input v-model="pairingCapabilities" type="checkbox" :value="cap.id" />
                  <span>{{ cap.label }}</span>
                </label>
              </div>
            </details>
          </template>
          <div v-else class="pairing-qr">
            <!--
            OVER the code, not instead of it. Between the scan and the SAS appearing this desktop
            recomputes the key proof, checks the grants against what the human ticked and writes the
            record — and the screen used to show an unchanged QR for the whole of it, which is
            indistinguishable from a scan that did nothing. The code stays underneath because the
            work can still be REJECTED, and the next thing to do then is scan the same code again.
          -->
            <div class="pairing-qr__frame">
              <img v-if="qrDataUrl" :src="qrDataUrl" alt="Mobile pairing QR code" class="pairing-qr__img" />
              <div v-if="claimInFlight" class="pairing-qr__working" role="status" aria-live="polite">
                <span class="pairing-qr__spinner" aria-hidden="true"></span>
                <span class="pairing-qr__working-label">Checking the phone…</span>
              </div>
            </div>
            <p
              class="pairing-qr__meta"
              title="The QR encodes a single-use pairing secret, never a permanent remote access token."
            >
              <template v-if="claimInFlight">
                A phone scanned this code. Verifying its key before you compare the codes.
              </template>
              <template v-else>
                Scan with strIDEterm Mobile → Pair device. Expires in <strong>{{ countdownSeconds }}s</strong>.
              </template>
            </p>
            <button type="button" class="button button--ghost" @click="cancelPairing">Cancel</button>
          </div>
        </div>

        <!-- Devices -->
        <!--
        THE CAPS LIVE ON THE ACCOUNT PAGE, and this points at them rather than repeating them
        (plan §8.3). What is listed below is what THIS desktop has paired; how many phones and
        desktops the ACCOUNT is allowed, and which of them are enrolled, is one account-wide fact and
        must have one place that states it. Two pages each computing "how many are left" is how they
        end up disagreeing on the screen where somebody is trying to work out why they cannot add
        another one.
      -->
        <p v-if="accountUsageAvailable" class="mobile-tab__account-link">
          Phones on this account: <strong>{{ accountPhoneUsage }}</strong> — the limits and billing are in
          <strong>Account and subscription</strong> above.
        </p>
        <div class="device-list">
          <p v-if="mobileDevices.length === 0" class="mobile-tab__empty">No devices paired yet.</p>
          <div
            v-for="device in mobileDevices"
            :key="device.deviceId"
            class="device-item"
            :class="{ 'device-item--revoked': device.revoked }"
          >
            <div class="device-item__header">
              <template v-if="renamingDeviceId === device.deviceId">
                <input
                  v-model="renameDraft"
                  class="settings-input"
                  maxlength="60"
                  title="New display label for this device."
                  @keyup.enter="confirmRename(device)"
                />
                <button type="button" class="button button--ghost" @click="confirmRename(device)">Save</button>
                <button type="button" class="button button--ghost" @click="renamingDeviceId = null">Cancel</button>
              </template>
              <template v-else>
                <span class="device-item__label">{{ device.label }}</span>
                <span
                  class="device-item__badge"
                  :class="device.revoked ? 'badge--off' : 'badge--ok'"
                  :title="
                    device.revoked
                      ? 'This device has been revoked and can no longer connect.'
                      : 'Active — can receive pushes and send commands within its allowlist.'
                  "
                >
                  {{ device.revoked ? "revoked" : "active" }}
                </span>
                <!--
                Clears the row, and nothing else. A revoked record is not what refuses that phone —
                the same predicate turns away a missing record and a revoked one — so forgetting it
                changes no permission; it removes an entry from a list that otherwise only grows.
                The backend refuses it for an active device and for one whose cloud revocation is
                still owed, so this button cannot become a "forget locally" back door.
              -->
                <button
                  v-if="device.revoked"
                  type="button"
                  class="device-item__forget"
                  :disabled="forgetBusyId === device.deviceId"
                  title="Remove this revoked device from the list. It stays revoked; this only clears the entry."
                  aria-label="Remove this revoked device from the list"
                  @click="forgetDevice(device)"
                >
                  ×
                </button>
                <!--
                Claimed is not paired. The claim proves the phone held the invitation secret, and the key
                proof proves it holds the private key behind the public key it published — but neither is
                a human agreeing that this is the right phone. Until someone compares the code, the
                device receives no event, executes no command and gets no WebView session (review 3
                §P0.1). Showing WHICH of those two steps it is waiting on is the difference between "the
                pairing is still finishing" and "notifications are broken".
              -->
                <span
                  v-if="!device.revoked && device.state !== 'active'"
                  class="device-item__badge badge--pending"
                  :title="pendingStateHint(device.state)"
                >
                  {{ pendingStateLabel(device.state) }}
                </span>
                <button
                  v-if="!device.revoked"
                  type="button"
                  class="button button--ghost device-item__action"
                  title="Rename this device's display label."
                  @click="startRename(device)"
                >
                  Rename
                </button>
              </template>
            </div>

            <div class="device-item__meta">
              <span :title="'Platform: ' + device.platform">{{ device.platform }}</span>
              <!--
              The fingerprint of THIS device's public key, so the list names concrete installations
              rather than editable labels (review 2 §P0.7). A label is whatever the phone typed at
              pairing time and two phones may share one; the fingerprint is the digest of the key
              that pairing actually pinned, which is the value a user can compare against what their
              phone shows when deciding which row to revoke.
            -->
              <span
                class="device-item__fingerprint"
                :title="'Key fingerprint for this installation: ' + device.fingerprint"
                >{{ device.fingerprint }}</span
              >
              <span :title="'Last seen: ' + formatTimestamp(device.lastSeenAt)"
                >last seen {{ formatTimestamp(device.lastSeenAt) }}</span
              >
              <span :title="'New profiles are included automatically'">
                profiles: all, except {{ (device.excludedProfileIds || []).map(profileLabel).join(", ") || "none" }}
              </span>
              <span :title="'Capabilities granted to this device: ' + device.capabilities.join(', ')">
                capabilities: {{ device.capabilities.map(capabilityLabel).join(", ") || "none" }}
              </span>
            </div>

            <div v-if="!device.revoked" class="device-item__actions">
              <button
                type="button"
                class="button button--ghost"
                title="Change which profiles and capabilities this device is allowed to use."
                @click="toggleAllowlistEdit(device)"
              >
                {{ editingAllowlistId === device.deviceId ? "Close" : "Edit access" }}
              </button>
              <button
                type="button"
                class="button button--ghost"
                :disabled="testPushBusyId === device.deviceId"
                title="Send a notification visibly labeled as a test — goes through the same delivery path and quota as a real push."
                @click="sendTestPush(device)"
              >
                {{ testPushBusyId === device.deviceId ? "Sending…" : "Send test push" }}
              </button>
              <button
                type="button"
                class="button button--ghost button--danger"
                title="Immediately revoke this device: it loses push notifications and remote access, and any active remote session is closed. Cannot be undone — the phone must be re-paired."
                @click="confirmRevoke(device)"
              >
                Revoke
              </button>
            </div>
            <p v-if="testPushResult[device.deviceId]" class="device-item__test-result">
              {{ testPushResult[device.deviceId] }}
            </p>
            <p v-if="forgetError[device.deviceId]" class="device-item__test-result">
              {{ forgetError[device.deviceId] }}
            </p>

            <!-- Now the primary place a grant gets narrowed (pairing hands out everything), so the two
               questions are named here too rather than being one flat row of identical boxes. -->
            <div v-if="editingAllowlistId === device.deviceId" class="device-item__allowlist-form">
              <p class="pairing-section__label">Profiles excluded from this phone</p>
              <div class="pairing-picker">
                <label
                  v-for="profile in profileOptions"
                  :key="profile.id"
                  class="form-label form-label--inline"
                  :title="`Exclude profile “${profile.name}” from this phone.`"
                >
                  <input v-model="allowlistDraft.excludedProfileIds" type="checkbox" :value="profile.id" />
                  <span>{{ profile.name }}</span>
                </label>
              </div>
              <p class="pairing-section__label">What it may do</p>
              <div class="pairing-picker">
                <label
                  v-for="cap in CAPABILITY_OPTIONS"
                  :key="cap.id"
                  class="form-label form-label--inline"
                  :title="cap.title"
                >
                  <input v-model="allowlistDraft.capabilities" type="checkbox" :value="cap.id" />
                  <span>{{ cap.label }}</span>
                </label>
              </div>
              <button type="button" class="button" :disabled="accessSaving" @click="saveAllowlist(device)">
                Save access
              </button>
              <p v-if="accessError" class="mobile-tab__error">{{ accessError }}</p>
            </div>
          </div>
        </div>

        <p class="mobile-tab__privacy">
          <!-- No live, publicly hosted privacy policy URL exists yet — this points at the drafted
             document in the strideterm-mobile repo instead of a fabricated URL, per the plan
             §10.5/§12.6 retention summary. -->
          Data retention: pairing invitations expire after 2 minutes, push events are retained up to 7 days, and audit
          metadata up to 30 days. See the strIDEterm Mobile privacy policy in the strideterm-mobile repo
          (<code>docs/PRIVACY-POLICY.md</code>) — publication pending.
        </p>
      </template>

      <!--
      ADVANCED, AND LAST. Everything in here is a switch whose answer is already yes by the time
      anyone is on this page: the person came to pair a phone, so "Enable Mobile" and "Managed relay"
      are not questions to put in front of the thing they came to do — they are the two ways to
      change their mind later, plus the status lines that belong with them. Collapsed by default and
      below the device list, so the page reads as pair → devices → and, if you need it, the plumbing.

      NOT gated on `mobileEnabled`: with Mobile off but a phone still paired, this is the only place
      that can turn it back on. `<details>` keeps its content in the DOM while closed, so nothing
      here becomes unreachable to a keyboard or to find-in-page.
    -->
      <details v-if="pairingReady && (mobileEnabled || mobileDevices.length > 0)" class="mobile-tab__advanced">
        <summary class="mobile-tab__advanced-summary">Advanced</summary>

        <label
          class="form-label form-label--inline"
          title="Turns the whole Mobile feature on or off. Disabling stops the Firebase connection and any paired device stops receiving pushes/commands immediately (devices themselves stay paired)."
        >
          <input type="checkbox" :checked="mobileEnabled" :disabled="enableBusy" @change="onToggleEnabled" />
          <span>Enable Mobile</span>
        </label>
        <p v-if="enableError" class="mobile-tab__error">{{ enableError }}</p>

        <template v-if="mobileEnabled">
          <!-- Connection health -->
          <div class="status-row">
            <span class="status-badge" :class="healthBadgeClass" :title="healthTitle">
              {{ healthLabel }}
            </span>
            <button
              type="button"
              class="button button--ghost"
              :disabled="healthBusy"
              title="Re-check the Firebase connection and, if disconnected, attempt to reconnect."
              @click="refreshHealth"
            >
              {{ healthBusy ? "Refreshing…" : "Refresh" }}
            </button>
          </div>
          <p
            v-if="mobileConnectionHealth?.lastError"
            class="mobile-tab__error"
            :title="mobileConnectionHealth.lastError"
          >
            {{ mobileConnectionHealth.lastError }}
          </p>

          <!-- Quota -->
          <div v-if="mobileQuota" class="quota-row" :title="quotaTitle">
            <div class="quota-bar"><div class="quota-bar__fill" :style="{ width: quotaPercent + '%' }" /></div>
            <span class="quota-label">
              {{ mobileQuota.used }} / {{ mobileQuota.limit }} pushes today ·
              {{ mobileQuota.reservedHighPriorityRemaining }} reserved for high-priority · resets
              {{ formatResetTime(mobileQuota.resetAt) }}
              <template v-if="mobileQuota.suppressedToday > 0">
                · {{ mobileQuota.suppressedToday }} suppressed by quota today
              </template>
            </span>
          </div>

          <!--
          The managed relay, which is its OWN decision (relay plan §10, dev-environment finding 6).

          A separate switch rather than part of "Enable Mobile", because it starts something the mobile
          integration alone does not: an outbound connector from this desktop to a hosted relay origin,
          which is how a phone reaches a terminal without this machine being reachable from the internet.
          Off means no connector, no socket and no loopback origin — not a disabled feature that is still
          connected. The status line below is the relay's own state, so "on" can be told apart from
          "on and actually connected".
        -->
          <div class="relay-block">
            <label
              class="form-label form-label--inline"
              title="Lets a paired phone open a terminal through the hosted relay when this desktop is not reachable on the network. Off means no connector and no socket exist at all."
            >
              <input
                type="checkbox"
                :checked="mobileRelayEnabled"
                :disabled="relayBusy"
                @change="onToggleRelayEnabled"
              />
              <span>Managed relay (open a terminal from anywhere)</span>
            </label>
            <p class="mobile-tab__intro relay-block__hint">
              Without it, a phone can only reach this desktop on your own network. With it, this desktop connects out to
              the relay and the phone reaches it through that — nothing on this machine is exposed to the internet.
            </p>
            <!--
            The sentence the first paragraph does not say, and has to.

            "Nothing is exposed to the internet" is true about INBOUND reachability — there is no
            listener and no open port — and says nothing about confidentiality. The notification and
            command plane IS end-to-end encrypted (AEAD under a key only this desktop and the phone
            hold), which is exactly what makes the omission misleading rather than merely incomplete:
            a user who knows that part can reasonably read the whole relay as end-to-end. It is not.
            The relay terminates TLS and forwards decrypted frames, so a session's terminal output
            and file contents are readable by it while they are in flight.

            This is where consent is actually given — the toggle, not a policy document — so the
            distinction belongs here rather than only in docs/PRIVACY-POLICY.md.
          -->
            <p class="mobile-tab__intro relay-block__hint">
              A relay session is encrypted in transit and readable by the relay while it is in flight; notifications and
              commands stay end-to-end encrypted.
            </p>
            <p v-if="relayError" class="mobile-tab__error">{{ relayError }}</p>
            <div v-if="mobileRelayEnabled" class="status-row">
              <span class="status-badge" :class="relayBadgeClass" :title="relayTitle">{{ relayLabel }}</span>
              <button
                type="button"
                class="button button--ghost"
                :disabled="relayStatusBusy"
                title="Re-read the relay's own state."
                @click="refreshRelayStatus"
              >
                {{ relayStatusBusy ? "Refreshing…" : "Refresh" }}
              </button>
            </div>
          </div>
        </template>
      </details>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, watch } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useAccountStore } from "../../../stores/account.js";
import RemoteAccessPauseControl from "../../layout/RemoteAccessPauseControl.vue";
import SettingsAccountTab from "./SettingsAccountTab.vue";
import { QR_COLORS_FOR_SCANNING, useQrCode } from "../../../composables/useQrCode.js";

interface ProfileOption {
  id: string;
  name: string;
  color?: string;
}

interface Props {
  showPauseControl?: boolean;
  profiles?: ProfileOption[];
}

const props = withDefaults(defineProps<Props>(), {
  profiles: () => [],
  showPauseControl: true,
});

const appStore = useAppStore();
const accountStore = useAccountStore();
const paused = computed(() => appStore.payload?.appState?.settings?.remoteAccess?.paused === true);
/** Whether this transport has the account surface at all — desktop-only, so absent on the web client. */
const accountAvailable = computed(() => accountStore.available);
/**
 * Whether this computer is registered against an account.
 *
 * PAIRING CANNOT PRECEDE IT, and until now the page let somebody try. A phone pairs to an
 * INSTALLATION, and the invitation, the relay grant and the device row are all written against the
 * account this machine is enrolled in — so with no registration there is nothing for a phone to pair
 * to. Worse, enrolment itself needs the installation session that turning Mobile on happens to
 * create, so the old order let a person switch Mobile on, scan a QR and get a failure whose real
 * cause was three steps earlier. Showing the pairing controls only once the machine is registered
 * makes the sequence the page's shape rather than something the user has to know.
 *
 * On a build with no hosted control plane there is no account surface at all, and `accountAvailable`
 * already hides the whole section.
 */
const installationRegistered = computed(() => accountStore.state.installationRegistered === true);
/**
 * Whether the pairing controls are worth showing at all.
 *
 * Two ways to be ready, and the second is not a loophole: where there is no account surface there is
 * no registration to wait for, and hiding pairing behind one would make a control-plane-less build
 * unusable while pointing at a section it does not render.
 */
const pairingReady = computed(() => !accountAvailable.value || installationRegistered.value);
/** Absent on the remote web client and in a build with no hosted control plane. */
const accountUsageAvailable = computed(() => accountStore.overview !== null);
const accountPhoneUsage = computed(() => {
  const usage = accountStore.overview?.usage.mobileDevices;
  return usage ? `${usage.used} / ${usage.limit}` : "";
});
const mobileEnabled = computed(() => appStore.mobileEnabled);
const mobileDevices = computed(() => appStore.mobileDevices);
const mobileConnectionHealth = computed(() => appStore.mobileConnectionHealth);
const mobileQuota = computed(() => appStore.mobileQuota);
const pairingSas = computed(() => appStore.mobilePairingSas);

/**
 * The code block itself, so it can be brought to the person rather than the other way round.
 *
 * The SAS arrives asynchronously — the phone scans, the handshake completes, and the block appears
 * wherever this tab happens to be scrolled. Which was the complaint: you hold the phone up, it says
 * "compare the code", and the code is somewhere off-screen in a long settings page. Nothing else on
 * this tab steals scroll, and this only fires on the transition into a pending code.
 */
const sasBlock = ref<HTMLElement | null>(null);
watch(
  () => pairingSas.value?.deviceId ?? null,
  async (deviceId) => {
    if (!deviceId) return;
    await nextTick();
    sasBlock.value?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  },
);

/** True while an approve/reject call is in flight, so the three buttons cannot be double-fired. */
const approvalBusy = ref(false);
/** A failure from the approval call, shown in place rather than swallowed — see `approvePairing`. */
const approvalError = ref("");

function dismissSas() {
  approvalError.value = "";
  appStore.dismissMobilePairingSas();
}

/**
 * "Codes match — activate" (review 3 §P0.1).
 *
 * The error is SHOWN, not logged and forgotten. An activation can fail — the cloud refuses a record it
 * still considers merely claimed, or cannot be reached — and in that case the device stays inert. A user
 * who pressed the button and saw nothing happen would reasonably assume pairing had completed, which is
 * precisely the fail-open reading this whole change exists to remove.
 */
async function approvePairing() {
  const pending = pairingSas.value;
  if (!pending || approvalBusy.value) return;
  approvalBusy.value = true;
  approvalError.value = "";
  try {
    const result = await appStore.approveMobileDevice(pending.deviceId);
    if (!result.ok) {
      approvalError.value = `Could not activate this device (${result.reason || "unknown"}). It stays inactive — try again, or choose Mismatch to revoke it.`;
    }
  } catch (error) {
    approvalError.value = error instanceof Error ? error.message : "Could not activate this device.";
  } finally {
    approvalBusy.value = false;
  }
}

/** "Mismatch — revoke", and the same path for any other reason the pairing must not proceed. */
async function rejectPairing(reason: string) {
  const pending = pairingSas.value;
  if (!pending || approvalBusy.value) return;
  approvalBusy.value = true;
  approvalError.value = "";
  try {
    await appStore.rejectMobileDevice(pending.deviceId, reason);
  } catch (error) {
    approvalError.value = error instanceof Error ? error.message : "Could not revoke this device.";
  } finally {
    approvalBusy.value = false;
  }
}

/** The badge text for a device that is not yet active — says which step it is waiting on. */
function pendingStateLabel(state: string): string {
  switch (state) {
    case "claimed":
      return "proving key";
    case "keyProven":
      return "awaiting your confirmation";
    case "userApproved":
      return "activating";
    default:
      return state;
  }
}

function pendingStateHint(state: string): string {
  switch (state) {
    case "claimed":
      return "Claimed, but this desktop has not yet verified that it holds the key it published. It can do nothing.";
    case "keyProven":
      return "It holds the right key. Compare the pairing code above and confirm — until you do, it receives no notifications and can run no commands.";
    case "userApproved":
      return "You confirmed the code; waiting for the server to activate it. It is not usable yet.";
    default:
      return "This device is not active and can do nothing.";
  }
}

const profileOptions = computed<ProfileOption[]>(() =>
  props.profiles.length > 0 ? props.profiles : [{ id: "default", name: "Default" }],
);

/**
 * The grants this dialog can hand out.
 *
 * These are the exact ids the desktop's COMMAND_POLICY table maps command types to
 * (electron/backend/mobile/mobile-command-policy.ts) — the list is what a device's `capabilities`
 * ends up containing, and the receiver derives what each command needs from its own type. Before
 * review 2 this dialog offered two coarse grants while the mobile stamped the command TYPE into a
 * `requiredCapability` field the desktop then compared against them, so no legitimately-paired
 * device's commands ever matched. Splitting destructive task actions, read-only status and the
 * WebView session out is the other half of that fix: "may pause a run" and "may throw a run away"
 * are not the same permission, and neither is "may see status" and "may open a live view of the
 * whole remote UI".
 */
const CAPABILITY_OPTIONS = [
  {
    id: "notifications",
    label: "Receive notifications",
    title: "Receive alerts from this desktop and mark them read.",
  },
  { id: "status.read", label: "Read status", title: "See workspace and remote-access status. Read-only." },
  {
    id: "task.control",
    label: "Control tasks",
    title: "Pause, resume, edit the description, and re-send the last instruction.",
  },
  {
    id: "task.destructive",
    label: "Stop and reset tasks",
    title: "Stop or reset a running task. This throws work away — grant separately from Control tasks.",
  },
  {
    id: "remote.request",
    label: "Request remote access",
    title: "Ask this desktop to (re)connect its tunnel.",
  },
  {
    id: "remote.webSession",
    label: "Open the remote UI",
    title: "Open a live view of the whole remote web UI in a WebView.",
  },
];
const CAPABILITY_LABELS: Record<string, string> = Object.fromEntries(CAPABILITY_OPTIONS.map((c) => [c.id, c.label]));

function profileLabel(profileId: string): string {
  return profileOptions.value.find((p) => p.id === profileId)?.name || profileId;
}
function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] || capability;
}
function formatTimestamp(ts: number): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}
function formatResetTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

// --- Enable/disable ---
const enableBusy = ref(false);
const enableError = ref("");
async function setEnabled(checked: boolean) {
  enableBusy.value = true;
  enableError.value = "";
  try {
    await appStore.setMobileEnabled(checked);
  } catch (err) {
    enableError.value = (err as Error)?.message || "Failed to update.";
  } finally {
    enableBusy.value = false;
  }
}

async function onToggleEnabled(event: Event) {
  await setEnabled((event.target as HTMLInputElement).checked);
}

/** The first-run button. Same call as ticking the box — a different sentence, not a different act. */
async function enableMobile() {
  await setEnabled(true);
}

// --- Managed relay ---
const mobileRelayEnabled = computed(() => appStore.mobileRelayEnabled);
const mobileRelayStatus = computed(() => appStore.mobileRelayStatus);
const relayBusy = ref(false);
const relayStatusBusy = ref(false);
const relayError = ref("");

async function onToggleRelayEnabled(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  relayBusy.value = true;
  relayError.value = "";
  try {
    await appStore.setMobileRelayEnabled(checked);
  } catch (err) {
    relayError.value = (err as Error)?.message || "Failed to update.";
  } finally {
    relayBusy.value = false;
  }
}

async function refreshRelayStatus() {
  relayStatusBusy.value = true;
  try {
    await appStore.refreshMobileRelayStatus();
  } finally {
    relayStatusBusy.value = false;
  }
}

/**
 * The relay's own state, in the same badge vocabulary the Firebase health row uses.
 *
 * The states are the connector's (`electron/backend/mobile/mobile-relay-connector.ts`), plus `off`
 * for "no connector exists". `ready` is the only one that means a phone can actually open a session,
 * which is why it is the only one shown as connected — an "on" switch over a connector that never
 * finished authenticating is exactly the thing this row exists to distinguish.
 */
const relayLabel = computed(() => {
  const state = String(mobileRelayStatus.value?.state ?? "");
  switch (state) {
    case "":
      return "Not checked yet";
    case "off":
      return "Off";
    case "ready":
      return "Connected";
    case "connecting":
    case "authenticating":
    case "syncing":
      return "Connecting…";
    case "draining":
      return "Finishing sessions…";
    case "idle":
    case "closed":
      return mobileRelayStatus.value?.lastError ? "Not connected" : "Starting…";
    default:
      return state;
  }
});

const relayBadgeClass = computed(() => {
  const state = String(mobileRelayStatus.value?.state ?? "");
  if (state === "ready") return "badge--ok";
  if (state === "off" || state === "") return "badge--off";
  return "badge--warn";
});

const relayTitle = computed(() => {
  const status = mobileRelayStatus.value;
  if (!status) return "The relay has not been asked for its state yet.";
  const parts = [`state: ${status.state ?? "unknown"}`];
  if (status.relayOrigin) parts.push(`relay: ${status.relayOrigin}`);
  // A fixed code, never an exception's text — see MobileRelayManager.status().
  if (status.lastError) parts.push(`last error: ${status.lastError}`);
  return parts.join(" · ");
});

// --- Connection health ---
const healthBusy = ref(false);
async function refreshHealth() {
  healthBusy.value = true;
  try {
    await appStore.refreshMobileConnectionHealth();
  } finally {
    healthBusy.value = false;
  }
}
// A connected transport whose writes are all refused used to read as "Connected" — see
// MobileConnectionHealth.pairAuthorization. Authorization is checked BEFORE the connection state is
// reported as good, because it is the more specific fact: the link is up and useless.
const healthLabel = computed(() => {
  const h = mobileConnectionHealth.value;
  if (!h) return "Unknown";
  if (!h.running) return "Stopped";
  if (h.connectionState !== "connected") return "Disconnected";
  return h.pairAuthorization === "denied" ? "Not authorized" : "Connected";
});
const healthBadgeClass = computed(() => {
  const h = mobileConnectionHealth.value;
  if (!h || !h.running) return "badge--off";
  if (h.pairAuthorization === "denied") return "badge--warn";
  return h.connectionState === "connected" ? "badge--ok" : "badge--warn";
});
const healthTitle = computed(() => {
  const h = mobileConnectionHealth.value;
  if (!h) return "Connection health has not been checked yet — click Refresh.";
  if (h.pairAuthorization === "denied") {
    return (
      "The cloud no longer recognises this desktop as the owner of its pair, so every request from " +
      "a paired phone is refused and the phone shows this desktop as unreachable. Re-pair the phone " +
      "to fix it."
    );
  }
  return `${h.deviceCount} active device(s). ${h.pendingInvitation ? "A pairing invitation is currently pending." : ""}`;
});

// --- Quota ---
const quotaPercent = computed(() => {
  const q = mobileQuota.value;
  if (!q || !q.limit) return 0;
  return Math.min(100, Math.round((q.used / q.limit) * 100));
});
const quotaTitle = computed(
  () =>
    "Approximate local count of pushes sent today (desktop-side; the authoritative server-enforced limit lives in the cloud). Resets at the next UTC midnight.",
);

// --- Pairing ---
const pairingProfileIds = computed(() => profileOptions.value.map((p) => p.id));
const pairingCapabilities = ref<string[]>(CAPABILITY_OPTIONS.map((c) => c.id));
const pairingBusy = ref(false);
const pairingError = ref("");

/**
 * What the sentence above the button promises — derived from the selection, never hardcoded.
 *
 * The default hands out everything, so the common reading is "all profiles and everything a phone
 * can do". It has to stay honest when somebody opens the disclosure and unticks: a line that said
 * "everything" over a narrowed grant would be worse than the twelve checkboxes it replaced.
 */
const pairingGrantSummary = computed(() => {
  const profileCount = profileOptions.value.length;
  const capCount = CAPABILITY_OPTIONS.length;
  const profiles =
    pairingProfileIds.value.length >= profileCount
      ? "all profiles"
      : `${pairingProfileIds.value.length} of ${profileCount} profiles`;
  const capabilities =
    pairingCapabilities.value.length >= capCount
      ? "everything a paired phone can do"
      : `${pairingCapabilities.value.length} of ${capCount} capabilities`;
  return `${profiles} and ${capabilities}`;
});
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const activePairing = computed(() => {
  const invitation = appStore.mobilePairingInvitation;
  if (!invitation?.expiresAt) return null;
  return invitation.expiresAt - nowTick.value > 0 ? invitation : null;
});
const countdownSeconds = computed(() => {
  const invitation = appStore.mobilePairingInvitation;
  if (!invitation?.expiresAt) return 0;
  return Math.max(0, Math.ceil((invitation.expiresAt - nowTick.value) / 1000));
});
const qrPayload = computed(() => (activePairing.value ? JSON.stringify(activePairing.value) : ""));
/** True from the moment a phone scans the code until the SAS appears or the claim is rejected. */
const claimInFlight = computed(() => appStore.mobilePairingClaimInFlight === true);
// Black on white, not the app's pale-on-transparent default: this code is read by a phone camera off
// a monitor, so it needs real luminance contrast rather than one that matches the dialog. See
// QR_COLORS_FOR_SCANNING for what the default was doing here.
//
// Four pixels per module rather than six, because the whole symbol has to be VISIBLE AT ONCE. At six
// the ~79-module pairing payload produces a 474px bitmap that does not fit this dialog's scroll area,
// and a QR with its top finder patterns scrolled out of view cannot be decoded at all — worse than a
// small one. Generating smaller keeps every module square and identical; sizing the finished image
// down in CSS would not.
const { qrDataUrl } = useQrCode(qrPayload, QR_COLORS_FOR_SCANNING, 4);

async function startPairing() {
  if (pairingProfileIds.value.length === 0) {
    pairingError.value = "Select at least one profile.";
    return;
  }
  if (pairingCapabilities.value.length === 0) {
    pairingError.value = "Select at least one capability.";
    return;
  }
  pairingBusy.value = true;
  pairingError.value = "";
  try {
    await appStore.createMobilePairingInvitation({
      profileAllowlist: [...pairingProfileIds.value],
      capabilities: [...pairingCapabilities.value],
    });
  } catch (err) {
    pairingError.value = (err as Error)?.message || "Failed to create pairing invitation.";
  } finally {
    pairingBusy.value = false;
  }
}
async function cancelPairing() {
  await appStore.cancelMobilePairingInvitation();
}

// --- Rename ---
const renamingDeviceId = ref<string | null>(null);
const renameDraft = ref("");
function startRename(device: { deviceId: string; label: string }) {
  renamingDeviceId.value = device.deviceId;
  renameDraft.value = device.label;
}
async function confirmRename(device: { deviceId: string }) {
  const label = renameDraft.value.trim();
  if (!label) return;
  await appStore.renameMobileDevice(device.deviceId, label);
  renamingDeviceId.value = null;
}

// --- Allowlist edit ---
const editingAllowlistId = ref<string | null>(null);
const accessSaving = ref(false);
const accessError = ref("");
const allowlistDraft = reactive<{ capabilities: string[]; excludedProfileIds: string[] }>({
  capabilities: [],
  excludedProfileIds: [],
});
function toggleAllowlistEdit(device: {
  deviceId: string;
  capabilities: string[];
  profileAllowlist: string[];
  excludedProfileIds?: string[];
}) {
  if (editingAllowlistId.value === device.deviceId) {
    editingAllowlistId.value = null;
    return;
  }
  accessError.value = "";
  allowlistDraft.capabilities = [...device.capabilities];
  allowlistDraft.excludedProfileIds = [...(device.excludedProfileIds || [])];
  editingAllowlistId.value = device.deviceId;
}
async function saveAllowlist(device: { deviceId: string }) {
  if (accessSaving.value) return;
  accessSaving.value = true;
  accessError.value = "";
  try {
    await appStore.updateMobileDeviceAllowlist(device.deviceId, {
      capabilities: [...allowlistDraft.capabilities],
      excludedProfileIds: [...allowlistDraft.excludedProfileIds],
    });
    if (editingAllowlistId.value === device.deviceId) editingAllowlistId.value = null;
  } catch {
    accessError.value = "Could not synchronize access with the phone. Please try again.";
  } finally {
    accessSaving.value = false;
  }
}

// --- Revoke ---
async function confirmRevoke(device: { deviceId: string; label: string }) {
  const confirmed = await appStore.confirmInApp({
    title: "Revoke mobile device?",
    message: `"${device.label}" will immediately lose push notifications and remote access. This cannot be undone — the phone must be re-paired.`,
    confirmLabel: "Revoke",
    danger: true,
  });
  if (!confirmed) return;
  await appStore.revokeMobileDevice(device.deviceId);
}

// --- Forget (clear a revoked row) ---
//
// NO CONFIRMATION DIALOG, unlike Revoke, and that asymmetry is the point: revoking cuts a phone off
// and cannot be undone, while this removes a line from a list and costs nothing anyone can miss —
// the phone stays revoked, and the audit log keeps the pairing's history either way. A confirmation
// on a harmless action is how people learn to click through the one that is not.
const forgetBusyId = ref<string | null>(null);
const forgetError = reactive<Record<string, string>>({});
async function forgetDevice(device: { deviceId: string }) {
  forgetBusyId.value = device.deviceId;
  delete forgetError[device.deviceId];
  try {
    const result = await appStore.forgetMobileDevice(device.deviceId);
    // The backend refuses an active device and one whose cloud revocation is still owed. Neither is
    // reachable from this button today, so if one arrives it is a real answer and is shown as one.
    if (!result.ok) {
      forgetError[device.deviceId] =
        result.reason === "cloud-revoke-pending"
          ? "Still telling the service about this revoke — it will disappear once that is sent."
          : `Could not remove it (${result.reason || "unknown reason"}).`;
    }
  } catch (err) {
    forgetError[device.deviceId] = (err as Error)?.message || "Could not remove it.";
  } finally {
    forgetBusyId.value = null;
  }
}

// --- Test push ---
const testPushBusyId = ref<string | null>(null);
const testPushResult = reactive<Record<string, string>>({});
async function sendTestPush(device: { deviceId: string }) {
  testPushBusyId.value = device.deviceId;
  try {
    const result = await appStore.sendMobileTestPush(device.deviceId);
    testPushResult[device.deviceId] = result?.ok ? "Test push sent." : `Failed: ${result?.reason || "unknown reason"}`;
  } catch (err) {
    testPushResult[device.deviceId] = (err as Error)?.message || "Failed to send test push.";
  } finally {
    testPushBusyId.value = null;
  }
}

onMounted(() => {
  void appStore.refreshMobileDevices();
  void appStore.refreshMobileConnectionHealth();
  // The relay's state is runtime-only, so it is read rather than derived from the payload.
  void appStore.refreshMobileRelayStatus();
  // Re-present a pairing code that was waiting for a decision when this desktop was last closed
  // (review 3 §P0.1's restart case). The code is derived from the transcript rather than stored, so
  // this asks the backend to recompute it; without it, a device claimed just before a restart would sit
  // in `keyProven` with no way for the user to either finish or reject it.
  void appStore.refreshMobileDevicesAwaitingApproval();
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<style scoped>
.mobile-tab__controls {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}
.mobile-tab {
  display: grid;
  gap: 14px;
}

/* The two halves of this tab. A rule rather than a blank line, because the account half is a whole
   page's worth of controls and the pairing half below it is a different subject. */
.mobile-tab__section {
  display: grid;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border, #333);
}

.mobile-tab__section-title {
  margin: 0;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.mobile-tab__intro {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}

.mobile-tab__intro--note {
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.04);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
}

.mobile-tab__intro--muted {
  opacity: 0.75;
}
.mobile-tab__spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  opacity: 0.8;
  animation: mobile-tab-spin 0.8s linear infinite;
}
@keyframes mobile-tab-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mobile-tab__spinner {
    animation: none;
  }
}
.mobile-tab__error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
}

/* The collapsed tail of the tab. `display: grid` only once open, so the closed state is just the
   summary line and not a grid with a hidden row's gap under it. */
.mobile-tab__advanced {
  padding-top: 12px;
  border-top: 1px solid var(--border, #333);
}

.mobile-tab__advanced[open] {
  display: grid;
  gap: 10px;
}

.mobile-tab__advanced-summary {
  cursor: pointer;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  user-select: none;
}

.mobile-tab__advanced-summary:hover {
  color: var(--fg, inherit);
}

.relay-block {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(var(--tint), 0.03);
}

.relay-block__hint {
  margin: 0;
}

.mobile-tab__empty {
  color: var(--muted);
  font-size: 13px;
  margin: 0;
}

.mobile-tab__privacy {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  margin: 4px 0 0;
}

.form-label--inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
}

.form-label--inline input[type="checkbox"] {
  width: auto;
  accent-color: var(--accent);
  margin: 0;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}

.badge--ok {
  background: rgba(0, 200, 100, 0.15);
  color: #0c6;
}

.badge--off {
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
}

.badge--warn {
  background: rgba(255, 180, 0, 0.18);
  color: #b07a00;
}

.badge--pending {
  background: rgba(255, 180, 0, 0.18);
  color: #b07a00;
}

.quota-row {
  display: grid;
  gap: 4px;
}

.quota-bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.quota-bar__fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}

.quota-label {
  font-size: 11px;
  color: var(--muted);
}

.pairing-section {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.pairing-sas {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--accent);
  border-radius: 6px;
}

.pairing-sas__title {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}

/* Monospace and wide-tracked: this is read digit by digit against a phone held next to the screen. */
.pairing-sas__code {
  font-family: var(--font-mono, monospace);
  font-size: 26px;
  letter-spacing: 0.14em;
  margin: 0;
}

.pairing-sas__hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
}

.pairing-sas__error {
  font-size: 12px;
  color: var(--danger, #c0392b);
  line-height: 1.5;
  margin: 0;
}

.pairing-sas__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pairing-section__label {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}

/* The optional narrowing. Same disclosure idiom as the tab's Advanced tail, one level in. */
.pairing-limits[open] {
  display: grid;
  gap: 6px;
}

.pairing-limits__summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  user-select: none;
}

.pairing-limits__summary:hover {
  color: var(--fg, inherit);
}

.pairing-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.pairing-qr {
  display: grid;
  justify-items: start;
  gap: 8px;
}

/*
 * Rendered at its NATURAL size, and never scaled down.
 *
 * This code is read by a phone camera pointed at a monitor, and the payload is large — version,
 * pairing id, a 256-bit secret, a 256-bit key-proof challenge, two device ids, a label, a public key
 * and a fingerprint — so the symbol has a high version and therefore many small modules. At the
 * previous fixed 200px the generated bitmap (six device pixels per module) was being downscaled by
 * more than half, which does not merely make it smaller: interpolation blends adjacent modules into
 * grey and destroys the edges a decoder looks for. Scanning it off a screen was close to impossible.
 *
 * `max-width` keeps a narrow dialog from reintroducing the same downscale, and `pixelated` means
 * that if it ever does happen the modules stay square instead of being blurred together.
 */
.pairing-qr__img {
  width: auto;
  height: auto;
  max-width: 100%;
  image-rendering: pixelated;
  background: white;
  padding: 12px;
  border-radius: 6px;
}

.pairing-qr__meta {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}

.device-list {
  display: grid;
  gap: 8px;
}

.device-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  display: grid;
  gap: 6px;
}

.device-item--revoked {
  opacity: 0.6;
}

.device-item__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.device-item__label {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
}

.device-item__badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
}

.pairing-qr__frame {
  position: relative;
  display: inline-block;
  line-height: 0;
}

/* Covers the code rather than replacing it, and dims rather than hides: the symbol stays legible
   underneath, so a user who scanned a moment too early can still see what they scanned. */
.pairing-qr__working {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgb(0 0 0 / 62%);
  border-radius: 4px;
  line-height: 1.3;
}

.pairing-qr__working-label {
  font-size: 12px;
  color: #fff;
}

.pairing-qr__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgb(255 255 255 / 35%);
  border-top-color: #fff;
  border-radius: 50%;
  animation: pairing-qr-spin 0.8s linear infinite;
}

@keyframes pairing-qr-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Respecting the OS setting rather than spinning regardless: the label alone still answers the
   question the spinner is there to answer. */
@media (prefers-reduced-motion: reduce) {
  .pairing-qr__spinner {
    animation: none;
  }
}

.device-item__action {
  margin-left: auto;
}

/* `margin-left: auto` puts it at the far end of the header row, away from every other control —
   this is the only destructive-looking thing on a revoked row and it should not sit under a thumb
   heading somewhere else. Muted until hovered, because it is housekeeping, not an alarm. */
.device-item__forget {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-muted, #888);
  opacity: 0.6;
}

.device-item__forget:hover:not(:disabled) {
  opacity: 1;
  color: var(--danger, #e06c75);
}

.device-item__forget:disabled {
  cursor: default;
  opacity: 0.3;
}

.device-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--muted);
}

/* Monospace so the groups line up when comparing against what the phone shows. */
.device-item__fingerprint {
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.02em;
}

.device-item__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.device-item__test-result {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
}

.device-item__allowlist-form {
  display: grid;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.button--danger {
  color: var(--danger);
  border-color: var(--danger);
}

.button--danger:hover {
  background: rgba(255, 60, 60, 0.1);
}
</style>
