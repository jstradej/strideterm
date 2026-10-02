<template>
  <div class="mobile-tab">
    <RemoteAccessPauseControl v-if="showPauseControl" />
    <p v-if="paused" class="mobile-tab__intro" role="status">
      Mobile access is paused along with other remote connections. Your phones remain paired.
    </p>
    <div class="mobile-tab__controls">
      <nav v-if="accountAvailable" class="mobile-tab__subtabs" role="tablist" aria-label="Mobile settings sections">
        <button
          v-for="tab in mobileTabs"
          :id="tabId(tab.id)"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeView === tab.id"
          :aria-controls="panelId(tab.id)"
          :tabindex="activeView === tab.id ? 0 : -1"
          class="mobile-tab__subtab"
          :class="{ 'mobile-tab__subtab--active': activeView === tab.id }"
          @keydown="onSubtabKeydown($event, tab.id)"
          @click="activeView = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
      <section
        v-if="accountAvailable"
        :id="activeView === 'phones' ? undefined : panelId(activeView)"
        :role="activeView === 'phones' ? undefined : 'tabpanel'"
        :aria-labelledby="activeView === 'phones' ? undefined : tabId(activeView)"
        class="mobile-tab__section"
        :class="{ 'mobile-tab__section--auxiliary': activeView === 'phones' }"
      >
        <SettingsAccountTab
          :view="activeView === 'phones' ? 'hidden' : activeView"
          :visible="visible"
          :phone-count="activePhoneCount"
          @navigate-phones="activeView = 'phones'"
          @connect-first-phone="connectFirstPhone"
          @navigate-account="activeView = 'account'"
        />
      </section>

      <p
        v-if="activeView === 'overview' && showTestingNotice"
        class="mobile-tab__intro mobile-tab__intro--note mobile-tab__testing-notice"
      >
        strIDEterm Mobile is currently in internal testing. Register and verify your email first. Once your email is
        verified, you can
        <a href="https://strideterm.com/mobile/#access-request-title" target="_blank" rel="noopener noreferrer"
          >request access to the Google Play internal test</a
        >.
      </p>
      <section
        v-if="activeView === 'overview' && pairingReady"
        class="mobile-tab__overview-grid"
        aria-label="Mobile connection summary"
      >
        <article v-if="hostedAccessBlocked" class="mobile-tab__summary-card mobile-tab__summary-card--wide">
          <span class="mobile-tab__summary-label">Mobile access</span>
          <strong>A plan is required</strong>
          <span class="mobile-tab__summary-note">Choose a plan to connect phones and use the managed relay.</span>
          <button type="button" class="button button--ghost mobile-tab__card-action" @click="activeView = 'account'">
            Review plans
          </button>
        </article>
        <article
          v-if="!hostedAccessBlocked"
          class="mobile-tab__summary-card"
          :class="{ 'mobile-tab__summary-card--ready': overviewConnectionLabel === 'Connected' }"
        >
          <span class="mobile-tab__summary-label">Desktop connection</span>
          <div class="mobile-tab__summary-status" role="status" aria-live="polite">
            <span
              class="mobile-tab__state-icon"
              :class="
                overviewConnectionLabel === 'Connected'
                  ? 'mobile-tab__state-icon--ready'
                  : 'mobile-tab__state-icon--idle'
              "
              aria-hidden="true"
            >
              <svg v-if="overviewConnectionLabel === 'Connected'" viewBox="0 0 20 20" fill="none">
                <path
                  d="m4 10 4 4 8-8"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg v-else viewBox="0 0 20 20" fill="none">
                <path d="M5 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </span>
            <strong>{{ overviewConnectionLabel }}</strong>
          </div>
          <div v-if="activePhones.length" class="mobile-tab__paired-phones">
            <span v-for="device in activePhones" :key="device.deviceId" class="mobile-tab__phone-name">
              Paired: {{ device.label?.trim() || device.platform || "Unnamed phone" }}
            </span>
          </div>
          <span v-else class="mobile-tab__summary-note">No phones paired yet.</span>
          <button
            v-if="activePhones.length"
            type="button"
            class="button button--ghost mobile-tab__card-action"
            @click="activeView = 'phones'"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M4 10h11m-4-4 4 4-4 4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {{ activePhoneCount === 1 ? "View phone details" : "View phones" }}
          </button>
        </article>
        <article
          v-if="!hostedAccessBlocked"
          class="mobile-tab__summary-card"
          :class="{ 'mobile-tab__summary-card--ready': relayReady }"
        >
          <span class="mobile-tab__summary-label">Managed relay</span>
          <div class="mobile-tab__summary-status" role="status" aria-live="polite">
            <span
              class="mobile-tab__state-icon"
              :class="relayReady ? 'mobile-tab__state-icon--ready' : 'mobile-tab__state-icon--idle'"
              aria-hidden="true"
            >
              <svg v-if="relayReady" viewBox="0 0 20 20" fill="none">
                <path
                  d="m4 10 4 4 8-8"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg v-else viewBox="0 0 20 20" fill="none">
                <path d="M5 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </span>
            <strong>{{ paused ? "Paused" : mobileRelayEnabled ? `Enabled · ${relayLabel}` : "Off" }}</strong>
          </div>
          <span class="mobile-tab__summary-note">{{ overviewRelayNote }}</span>
          <div
            v-if="mobileRelayEnabled && relayTraffic"
            class="mobile-tab__relay-traffic"
            title="Relayed payload bytes since this connector started. The counts reset when the connector restarts."
          >
            <span>Relay data this run</span>
            <strong :aria-label="`Received ${relayTraffic.received}, sent ${relayTraffic.sent}`"
              >↓ {{ relayTraffic.received }} · ↑ {{ relayTraffic.sent }}</strong
            >
          </div>
          <button
            type="button"
            class="button mobile-tab__card-action"
            :class="{ 'button--ghost': mobileRelayEnabled, 'mobile-tab__relay-action--stop': mobileRelayEnabled }"
            :disabled="paused || relayBusy"
            :title="
              mobileRelayEnabled
                ? 'Disconnects the relay and ends active remote sessions. Phones remain paired.'
                : 'Connects the managed relay for paired phones.'
            "
            @click="setRelayEnabled(!mobileRelayEnabled)"
          >
            <svg v-if="mobileRelayEnabled" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 3v7m-4.5-5a7 7 0 1 0 9 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            {{ relayBusy ? "Updating…" : mobileRelayEnabled ? "Disconnect relay" : "Enable relay" }}
          </button>
          <p v-if="activeView === 'overview' && relayError" class="mobile-tab__error" role="alert">
            {{ relayError }}
          </p>
          <p v-if="relayStatusError" class="mobile-tab__error" role="status">{{ relayStatusError }}</p>
        </article>
      </section>

      <div
        v-if="activeView === 'phones'"
        :id="panelId('phones')"
        role="tabpanel"
        :aria-labelledby="accountAvailable ? tabId('phones') : undefined"
        class="mobile-tab__phone-view"
      >
        <p v-if="showTestingNotice" class="mobile-tab__intro mobile-tab__intro--note mobile-tab__testing-notice">
          strIDEterm Mobile is currently in internal testing. Register and verify your email first. Once your email is
          verified, you can
          <a href="https://strideterm.com/mobile/#access-request-title" target="_blank" rel="noopener noreferrer"
            >request access to the Google Play internal test</a
          >.
        </p>
        <template v-if="!activePairing && !pairingSas">
          <div class="mobile-tab__phone-header">
            <h3 id="mobile-tab-phone-pairing" class="mobile-tab__section-title">
              {{ mobileDevices.length ? "Your phones" : "Connect your first phone" }}
            </h3>
            <!-- The empty page's main action is the one to see; with phones listed it steps back. -->
            <button
              v-if="mobileDevices.length > 0 && !addPhoneSetupOpen"
              type="button"
              class="button"
              :class="activePhoneCount === 0 ? 'button--primary' : 'button--ghost'"
              :disabled="paused"
              @click="addPhoneSetupOpen = true"
            >
              Add phone
            </button>
          </div>
          <p v-if="mobileDevices.length === 0" class="mobile-tab__intro">
            Pair strIDEterm Mobile to open your profiles and terminals, receive notifications, and respond from your
            phone.
          </p>
          <div v-if="enableBusy || pairingBusy" class="pairing-progress" role="status" aria-live="polite">
            <span class="pairing-progress__spinner" aria-hidden="true"></span>
            <div>
              <strong>{{ pairingBusy ? "Generating pairing QR code…" : "Preparing phone pairing…" }}</strong>
              <p>
                {{
                  pairingBusy
                    ? "Creating a secure, single-use invitation. Keep this window open."
                    : "Connecting this desktop to your account. The QR code comes next."
                }}
              </p>
            </div>
          </div>
          <ol v-if="mobileDevices.length === 0" class="mobile-tab__steps" aria-label="Pairing progress">
            <li :class="{ 'mobile-tab__step--active': !mobileEnabled }">
              <strong>Prepare</strong><span>Turn on phone pairing.</span>
            </li>
            <li :class="{ 'mobile-tab__step--active': mobileEnabled }">
              <strong>Scan</strong><span>In strIDEterm Mobile, open Pair device.</span>
            </li>
            <li><strong>Confirm</strong><span>Compare the code on both screens.</span></li>
          </ol>
        </template>

        <!-- THE ONE STEP THAT IS ACTUALLY AVAILABLE, and nothing else. A phone pairs to an installation,
         so there is nothing to pair to until this computer is registered — and every control below
         would fail for a reason that is not where the person is looking. -->
        <p v-if="accountAvailable && !installationRegistered" class="mobile-tab__intro mobile-tab__intro--note">
          Register this computer first.
          <button type="button" class="mobile-tab__inline-action" @click="activeView = 'account'">Go to Account</button>
        </p>
        <!-- `pairingReady` rather than `installationRegistered` so a build with NO account surface at all
         (the remote web client already loses the whole section; a build with no control plane keeps
         it) behaves as it always did, instead of being told to go and register somewhere that does
         not exist. -->
        <template v-if="pairingReady">
          <!-- BEFORE THE FIRST PHONE, THE STEP — NOT THE SETTING. The checkbox's real job is the ongoing
           one its own tooltip describes: silence a paired phone without unpairing it. As the gate in
           front of a first pairing it was a second, unexplained question asked of somebody who had
           just registered this computer and started a trial FOR these features, and who then found
           an unticked box and no stated reason. So until there is something to silence, the page
           offers the thing they came to do; the switch itself lives in Advanced at the bottom, since
           by the time it has a job the answer to "do I want this?" is already yes. -->
          <fieldset class="mobile-tab__mutation-group" :disabled="paused">
            <template v-if="!mobileEnabled && mobileDevices.length === 0">
              <button type="button" class="button" :disabled="enableBusy || secureStorageMissing" @click="enableMobile">
                <span v-if="enableBusy" class="mobile-tab__spinner" aria-hidden="true"></span>
                Turn on phone pairing
              </button>
              <p class="mobile-tab__intro mobile-tab__intro--muted">
                This opens the connection to the account service so a phone can be paired and receive pushes. You can
                turn it off again at any time, without unpairing anything.
              </p>
              <p v-if="secureStorageMissing" class="mobile-tab__error" role="alert">
                {{ SECURE_STORAGE_REQUIRED_COPY }}
              </p>
              <p v-if="enableError" class="mobile-tab__error">{{ enableError }}</p>
            </template>
          </fieldset>
        </template>

        <div v-if="paused && mobileDevices.some((device) => !device.revoked)" class="mobile-tab__resume-card">
          <strong>Phone access is paused</strong>
          <span>Your pairings and access settings are preserved.</span>
          <RemoteAccessPauseControl />
        </div>

        <template v-if="pairingReady && (mobileEnabled || mobileDevices.length > 0)">
          <!--
        The pairing SAS, and the decision that turns it into an authorization (review 3 §P0.1).

        Both ends derive this from the same transcript — both public keys, both device ids, the
        pair and the invitation — and neither takes it from the backend (review 2 §P0.4). The phone
        shows the code; a control plane that substituted a key produces two codes that differ, which
        is the one part of the pinning story a person rather than a rule enforces.

        THE DESKTOP DOES NOT SHOW THE CODE (review 3 §3.6). It used to, beside a "Codes match"
        button, and an attacker who scanned the invitation first left the user's own phone with
        "already used" and this screen with a code and a button: comparing became a click. The user
        now TYPES what the phone shows, the backend compares it with its own derivation and refuses
        a mismatch, and this component never holds the expected value at all — only whether one
        exists. The label is whatever the claiming device called itself, so it is rendered as plain
        quoted text and never as emphasis.

        WHAT CHANGED. This block used to have one button, "I compared them", which hid the code and did
        nothing else: the device was already live by the time it appeared, and the remedy for a mismatch
        was the prose "revoke the device below and pair again" — i.e. after the fact. The two buttons
        below are the actual gate. Until the right code is typed and "Activate" pressed, the device receives no event, executes
        no command and gets no WebView session; "Mismatch" revokes it outright; and closing this dialog
        without choosing leaves it inert until the server's pending-approval TTL sweeps it.
      -->
          <fieldset
            v-if="mobileEnabled && (pairingSas || activePairing || mobileDevices.length === 0 || addPhoneSetupOpen)"
            class="mobile-tab__mutation-group"
            :disabled="paused"
          >
            <div v-if="pairingSas" ref="sasBlock" class="pairing-sas">
              <p class="pairing-sas__title">Enter the code shown on the phone</p>
              <p class="pairing-sas__hint">
                The phone calling itself “{{ pairingSas.label || "the new device" }}” is showing an 8-digit code. Type
                it here. Only a phone in your hand can give you the right one.
              </p>
              <input
                v-model="typedSas"
                class="settings-input pairing-sas__input"
                data-testid="pairing-sas-input"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                maxlength="16"
                placeholder="0000 0000"
                aria-label="Code shown on the phone"
                :disabled="approvalBusy"
                @input="onSasInput"
                @keyup.enter="submitTypedSas"
              />
              <p v-if="approvalError" class="pairing-sas__error">{{ approvalError }}</p>
              <div class="pairing-sas__actions">
                <button
                  type="button"
                  class="button button--primary"
                  :disabled="approvalBusy || sasDigitCount !== SAS_DIGITS"
                  title="Activate this device. Enabled once you have typed all 8 digits of the code the phone shows."
                  @click="submitTypedSas"
                >
                  Activate
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
                <p v-if="pairingExpired" class="mobile-tab__error" role="status">
                  This pairing code expired. Generate a new one to continue.
                </p>
                <p class="pairing-section__label">
                  The new phone gets <strong>{{ pairingGrantSummary }}</strong
                  >. You can change that per device afterwards, with <em>Edit access</em>.
                </p>
                <button
                  type="button"
                  class="button pairing-section__action"
                  :disabled="pairingBusy"
                  title="Generate a single-use QR code. Valid for 120 seconds — scan it with strIDEterm Mobile's Pair device screen."
                  @click="startPairing"
                >
                  {{ pairingBusy ? "Creating…" : pairingExpired ? "Generate new code" : "Pair a phone" }}
                </button>
                <button
                  v-if="mobileDevices.length > 0"
                  type="button"
                  class="button button--ghost pairing-section__action"
                  @click="addPhoneSetupOpen = false"
                >
                  Close setup
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
              <div v-else ref="pairingQr" class="pairing-qr">
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
                <div class="pairing-qr__instructions">
                  <span class="pairing-qr__step">Step 2 of 3</span>
                  <h3>Scan this code</h3>
                  <p>Open strIDEterm Mobile on your phone, then choose <strong>Pair device</strong>.</p>
                  <p class="pairing-qr__meta" title="The QR contains a single-use invitation.">
                    <template v-if="claimInFlight">Phone found. Verifying its key…</template>
                    <template v-else
                      >Expires in <strong>{{ countdownSeconds }}s</strong>.</template
                    >
                  </p>
                  <button type="button" class="button button--ghost" @click="cancelPairing">Cancel</button>
                </div>
              </div>
            </div>
          </fieldset>

          <!-- Devices -->
          <!--
        THE CAPS LIVE ON THE ACCOUNT PAGE, and this points at them rather than repeating them
        (plan §8.3). What is listed below is what THIS desktop has paired; how many phones and
        desktops the ACCOUNT is allowed, and which of them are enrolled, is one account-wide fact and
        must have one place that states it. Two pages each computing "how many are left" is how they
        end up disagreeing on the screen where somebody is trying to work out why they cannot add
        another one.
      -->
          <p v-if="accountUsageAvailable && !activePairing && !pairingSas" class="mobile-tab__account-link">
            Phones on this account: <strong>{{ accountPhoneUsage }}</strong
            >.
            <button type="button" class="mobile-tab__inline-action" @click="activeView = 'account'">
              View account limits
            </button>
          </p>
          <div v-if="!activePairing && !pairingSas" class="device-list">
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
                    :class="device.revoked ? 'badge--off' : device.state === 'active' ? 'badge--ok' : 'badge--pending'"
                    :title="
                      device.revoked
                        ? 'This device has been revoked and can no longer connect.'
                        : device.state === 'active'
                          ? 'Active — can receive pushes and send commands within its allowlist.'
                          : pendingStateHint(device.state)
                    "
                  >
                    {{
                      device.revoked
                        ? "revoked"
                        : device.state === "active"
                          ? "active"
                          : pendingStateLabel(device.state)
                    }}
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
                    :disabled="paused || forgetBusyId === device.deviceId"
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
                  <button
                    v-if="!device.revoked"
                    type="button"
                    class="button button--ghost device-item__action"
                    :disabled="paused"
                    title="Rename this device's display label."
                    @click="startRename(device)"
                  >
                    Rename
                  </button>
                  <button
                    v-if="!device.revoked && device.state !== 'active'"
                    type="button"
                    class="button button--ghost device-item__action"
                    :disabled="paused"
                    title="Show the security code so you can compare it with this phone."
                    @click="reviewPendingPairing(device.deviceId)"
                  >
                    Review pairing
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
                <details class="device-item__fingerprint">
                  <summary>Security fingerprint</summary>
                  <code>{{ device.fingerprint }}</code>
                </details>
                <span
                  v-if="connectedSince(device.deviceId) !== null"
                  class="device-item__connected"
                  :title="'Holds a live session since ' + formatTimestamp(connectedSince(device.deviceId) ?? 0)"
                  >Connected</span
                >
                <span v-else :title="'Last seen: ' + formatTimestamp(device.lastSeenAt)"
                  >last seen {{ formatTimestamp(device.lastSeenAt) }}</span
                >
                <span :title="profileAccessTitle">
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
                  :disabled="paused"
                  title="Change which profiles and capabilities this device is allowed to use."
                  @click="toggleAllowlistEdit(device)"
                >
                  {{ editingAllowlistId === device.deviceId ? "Close" : "Edit access" }}
                </button>
                <button
                  v-if="device.state === 'active'"
                  type="button"
                  class="button button--ghost"
                  :disabled="paused || testPushBusyId === device.deviceId"
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
              <p v-if="revokeError[device.deviceId]" class="device-item__test-result" role="alert">
                {{ revokeError[device.deviceId] }}
              </p>
              <p v-if="reviewError.get(device.deviceId)" class="mobile-tab__error" role="alert">
                {{ reviewError.get(device.deviceId) }}
              </p>

              <!-- Now the primary place a grant gets narrowed (pairing hands out everything), so the two
               questions are named here too rather than being one flat row of identical boxes. -->
              <fieldset
                v-if="editingAllowlistId === device.deviceId"
                class="device-item__allowlist-form"
                :disabled="paused"
              >
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
              </fieldset>
            </div>
          </div>

          <details v-if="!activePairing && !pairingSas" class="mobile-tab__privacy">
            <summary>Privacy and retention</summary>
            <p class="mobile-tab__privacy-copy">
              Pairing invitations expire after 2 minutes. Push events are retained up to 7 days and audit metadata up to
              30 days.
            </p>
          </details>
        </template>

        <!--
      ADVANCED, AND LAST. Everything in here is a switch whose answer is already yes by the time
      anyone is on this page: the person came to pair a phone, so "Enable Mobile" is not a question
      to put in front of the thing they came to do. These controls let them change their mind later,
      plus the status lines that belong with them. Collapsed by default and
      below the device list, so the page reads as pair → devices → and, if you need it, the plumbing.

      NOT gated on `mobileEnabled`: with Mobile off but a phone still paired, this is the only place
      that can turn it back on. `<details>` keeps its content in the DOM while closed, so nothing
      here becomes unreachable to a keyboard or to find-in-page.
    -->
        <details
          v-if="pairingReady && !activePairing && !pairingSas && (mobileEnabled || mobileDevices.length > 0)"
          ref="advancedSettings"
          class="mobile-tab__advanced"
        >
          <summary>Advanced</summary>

          <fieldset class="mobile-tab__mutation-group" :disabled="paused">
            <label
              class="form-label form-label--inline"
              title="Turns the whole Mobile feature on or off. Disabling stops the Firebase connection and any paired device stops receiving pushes/commands immediately (devices themselves stay paired)."
            >
              <input
                type="checkbox"
                :checked="mobileEnabled"
                :disabled="enableBusy || (secureStorageMissing && !mobileEnabled)"
                @change="onToggleEnabled"
              />
              <span>Enable Mobile</span>
            </label>
            <p v-if="secureStorageMissing" class="mobile-tab__error" role="alert">
              {{ SECURE_STORAGE_REQUIRED_COPY }}
            </p>
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
                {{ describeNetworkErrorCode(mobileConnectionHealth.lastError) ?? mobileConnectionHealth.lastError }}
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

              <!-- Relay can be disabled here after automatic setup during account registration. -->
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
                  <span>Managed relay</span>
                </label>
                <p class="mobile-tab__intro relay-block__hint">
                  Enabled automatically when you register this computer. Turn it off here any time. When connected,
                  paired phones can open terminals from outside your network.
                </p>
                <p class="mobile-tab__intro relay-block__hint">
                  Without it, a phone can only reach this desktop on your own network. With it, this desktop connects
                  out to the relay and the phone reaches it through that — nothing on this machine is exposed to the
                  internet.
                </p>
                <p class="mobile-tab__intro relay-block__hint">
                  A relay session is end-to-end encrypted between this desktop and the phone; the relay forwards
                  ciphertext it cannot read. Notifications and commands are end-to-end encrypted as well.
                </p>
                <label
                  class="form-label form-label--inline"
                  title="When on, this desktop refuses a relay session from a phone app that does not offer end-to-end encryption, instead of carrying that terminal in a form the relay could read."
                >
                  <input
                    type="checkbox"
                    data-testid="relay-require-e2e"
                    :checked="mobileRelayRequireE2e"
                    :disabled="requireE2eBusy"
                    @change="onToggleRequireE2e"
                  />
                  <span>Require end-to-end encryption over the relay</span>
                </label>
                <p class="mobile-tab__intro relay-block__hint">
                  A phone that cannot encrypt end-to-end gets no relay session. Turn this off only for an older phone
                  app.
                </p>
                <p v-if="requireE2eError" class="mobile-tab__error" role="alert">{{ requireE2eError }}</p>
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
                <p
                  v-if="mobileRelayEnabled && relayNetworkErrorText"
                  class="mobile-tab__error"
                  data-testid="relay-network-error"
                  :title="mobileRelayStatus?.lastError"
                >
                  {{ relayNetworkErrorText }}
                </p>
              </div>
            </template>
          </fieldset>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, useId, watch } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useAccountStore } from "../../../stores/account.js";
import RemoteAccessPauseControl from "../../layout/RemoteAccessPauseControl.vue";
import SettingsAccountTab from "./SettingsAccountTab.vue";
import { describeNetworkErrorCode } from "../../../lib/network-error-copy.js";
import { mobileErrorCopy, mobileResultReasonCopy } from "./mobile-error-copy.js";
import { QR_COLORS_FOR_SCANNING, useQrCode } from "../../../composables/useQrCode.js";

interface ProfileOption {
  id: string;
  name: string;
  color?: string;
}

type MobileView = "overview" | "phones" | "account";

interface Props {
  showPauseControl?: boolean;
  visible?: boolean;
  profiles?: ProfileOption[];
  initialView?: MobileView;
}

const props = withDefaults(defineProps<Props>(), {
  profiles: () => [],
  showPauseControl: true,
  visible: true,
  initialView: "overview",
});

const mobileTabs: Array<{ id: MobileView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "phones", label: "Phones" },
  { id: "account", label: "Account" },
];
const activeView = ref<MobileView>(props.initialView);
const tabsId = useId();
const tabId = (view: MobileView) => `${tabsId}-${view}-tab`;
const panelId = (view: MobileView) => `${tabsId}-${view}-panel`;

const appStore = useAppStore();
const accountStore = useAccountStore();
const paused = computed(() => appStore.payload?.appState?.settings?.remoteAccess?.paused === true);

// Mobile's keys are only ever stored encrypted, so without the OS keychain the desktop refuses to turn
// Mobile on (and will not start it if an earlier run left it on). Shown as a reason, not left to a
// failed click: the refusal itself reaches this panel only as a generic "could not update".
const SECURE_STORAGE_REQUIRED_COPY =
  "Phone pairing needs secure storage, and this computer has none available (on Linux, install libsecret / gnome-keyring). Mobile's keys are never stored as plain text.";
const secureStorageMissing = computed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => (appStore.payload as any)?.secureStorage?.available === false,
);

// What "profiles" on a device row promises. The profile is an application boundary: it keeps a phone out of
// other profiles' workspaces, terminals and files in the app. It is not an operating-system boundary —
// a terminal is a shell on this computer under your account.
const profileAccessTitle =
  "This phone can use every profile except the ones listed, and new profiles are included automatically. Inside a profile it has that profile's terminals — a shell on this computer under your account — and files, so excluding a profile keeps the phone out of it in the app, not at the operating-system level.";
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
const hostedAccessBlocked = computed(() => {
  const state = accountStore.entitlement?.state;
  return state === "unbound" || state === "lapsed" || state === "revoked" || state === "billing_unconfigured";
});
const showTestingNotice = computed(() => accountAvailable.value && mobileDevices.value.length === 0);
const mobileEnabled = computed(() => appStore.mobileEnabled);
const mobileDevices = computed(() => appStore.mobileDevices);
const activePhones = computed(() =>
  mobileDevices.value.filter((device) => !device.revoked && device.state === "active"),
);
const activePhoneCount = computed(() => activePhones.value.length);
const mobileConnectionHealth = computed(() => appStore.mobileConnectionHealth);
const mobileQuota = computed(() => appStore.mobileQuota);
const pairingSas = computed(() => appStore.mobilePairingSas);
const overviewConnectionLabel = computed(() => {
  if (paused.value) return "Paused";
  if (!mobileEnabled.value) return "Off";
  return healthLabel.value;
});

watch(
  accountAvailable,
  (available) => {
    if (!available && activeView.value !== "phones") activeView.value = "phones";
  },
  { immediate: true },
);

function onSubtabKeydown(event: KeyboardEvent, tab: MobileView): void {
  const index = mobileTabs.findIndex((item) => item.id === tab);
  if (index < 0) return;
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? index + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? index - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? mobileTabs.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  activeView.value = mobileTabs[(next + mobileTabs.length) % mobileTabs.length]!.id;
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll<HTMLButtonElement>("button")
    [(next + mobileTabs.length) % mobileTabs.length]?.focus();
}

const advancedSettings = ref<HTMLDetailsElement | null>(null);
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
    activeView.value = "phones";
    await nextTick();
    sasBlock.value?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    // The code is typed from the phone, so the field is ready to type into immediately.
    const input = sasBlock.value?.querySelector<HTMLInputElement>(".pairing-sas__input");
    if (!input?.disabled) {
      input?.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);

/** True while an approve/reject call is in flight, so the three buttons cannot be double-fired. */
const approvalBusy = ref(false);
/** A failure from the approval call, shown in place rather than swallowed — see `submitTypedSas`. */
const approvalError = ref("");

function dismissSas() {
  approvalError.value = "";
  appStore.dismissMobilePairingSas();
}

/** The short authentication string is always this many digits (mobile-crypto.ts `computePairingSas`). */
const SAS_DIGITS = 8;
/** What the user has typed from the phone. The expected code is never available in this component. */
const typedSas = ref("");
const sasDigitCount = computed(() => typedSas.value.replace(/\D/g, "").length);
// A different pending device — or none, after a dismiss, a rejection or a successful activation —
// starts from an empty field, so a code typed for one phone is never offered for the next.
watch(
  () => pairingSas.value?.deviceId ?? null,
  () => {
    typedSas.value = "";
  },
);
/** Digits and spaces only: the phone shows the code grouped, and people type it the way they read it. */
function onSasInput() {
  typedSas.value = typedSas.value.replace(/[^\d ]/g, "");
}

const SAS_MISMATCH_COPY =
  "That code does not match this desktop's. If the phone shows a different code, someone else may have used the invitation — choose Mismatch — revoke.";

/**
 * "Activate" with the code typed from the phone (review 3 §3.6).
 *
 * The error is SHOWN, not logged and forgotten. An activation can fail — the cloud refuses a record it
 * still considers merely claimed, or cannot be reached — and the device then stays inert; a user who
 * pressed the button and saw nothing would reasonably assume pairing had completed. A `sas-mismatch`
 * gets its own copy rather than the generic one, because it is the one refusal that may mean the
 * invitation is in other hands and the user needs to be told what to do.
 */
async function submitTypedSas() {
  const pending = pairingSas.value;
  if (!pending || approvalBusy.value || sasDigitCount.value !== SAS_DIGITS) return;
  approvalBusy.value = true;
  approvalError.value = "";
  try {
    const result = await appStore.approveMobileDevice(pending.deviceId, typedSas.value);
    if (!result.ok) {
      approvalError.value =
        result.reason === "sas-mismatch" ? SAS_MISMATCH_COPY : mobileResultReasonCopy(result.reason, "approve");
    }
  } catch (error) {
    approvalError.value = mobileErrorCopy(error, "approve");
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
    approvalError.value = mobileErrorCopy(error, "reject");
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
    title:
      "Open the remote web UI in a WebView for the profiles this device may use, including their terminals (a shell on this computer under your account) and files. It does not include this app's administration: tokens, tunnels, integrations and settings.",
  },
];
function profileLabel(profileId: string): string {
  return profileOptions.value.find((p) => p.id === profileId)?.name || profileId;
}
function capabilityLabel(capability: string): string {
  return CAPABILITY_OPTIONS.find((option) => option.id === capability)?.label || capability;
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
async function setEnabled(checked: boolean): Promise<boolean> {
  enableBusy.value = true;
  enableError.value = "";
  try {
    await appStore.setMobileEnabled(checked);
    return true;
  } catch (err) {
    enableError.value = mobileErrorCopy(err, "enable");
    return false;
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

/** When [deviceId] started the live session it holds right now, or null when it holds none. */
function connectedSince(deviceId: string): number | null {
  return appStore.mobileConnectedDevices.find((device) => device.deviceId === deviceId)?.startedAt ?? null;
}

// --- Managed relay ---
const mobileRelayEnabled = computed(() => appStore.mobileRelayEnabled);
const mobileRelayStatus = computed(() => appStore.mobileRelayStatus);
const relayBusy = ref(false);
const relayStatusBusy = ref(false);
const relayError = ref("");
const relayStatusError = ref("");
const relayReady = computed(
  () => !paused.value && mobileRelayEnabled.value && mobileRelayStatus.value?.state === "ready",
);

function formatRelayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
  const divisor = unit === "KiB" ? 1024 : unit === "MiB" ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

const relayTraffic = computed(() => {
  const stats = mobileRelayStatus.value?.stats;
  if (
    !stats ||
    !Number.isFinite(stats.bytesIn) ||
    !Number.isFinite(stats.bytesOut) ||
    stats.bytesIn < 0 ||
    stats.bytesOut < 0
  )
    return null;
  return { received: formatRelayBytes(stats.bytesIn), sent: formatRelayBytes(stats.bytesOut) };
});

async function onToggleRelayEnabled(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  await setRelayEnabled(checked);
}

async function setRelayEnabled(enabled: boolean) {
  relayBusy.value = true;
  relayError.value = "";
  try {
    await appStore.setMobileRelayEnabled(enabled);
  } catch (err) {
    relayError.value = mobileErrorCopy(err, "relay");
  } finally {
    relayBusy.value = false;
  }
}

// --- Require end-to-end encryption over the relay ---
const mobileRelayRequireE2e = computed(() => appStore.mobileRelayRequireE2e);
const requireE2eBusy = ref(false);
const requireE2eError = ref("");

async function onToggleRequireE2e(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  requireE2eBusy.value = true;
  requireE2eError.value = "";
  try {
    await appStore.setMobileRelayRequireE2e(checked);
  } catch (err) {
    requireE2eError.value = mobileErrorCopy(err, "relay");
    // The box shows the store's value, which did not change; put the native checkbox back with it.
    (event.target as HTMLInputElement).checked = mobileRelayRequireE2e.value;
  } finally {
    requireE2eBusy.value = false;
  }
}

async function refreshRelayStatus() {
  if (relayStatusBusy.value) return;
  relayStatusBusy.value = true;
  try {
    await appStore.refreshMobileRelayStatus();
    relayStatusError.value = "";
  } catch {
    relayStatusError.value = "Could not refresh relay status.";
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

const overviewRelayNote = computed(() => {
  if (paused.value) return "Remote connections are paused. Your phones remain paired.";
  if (mobileRelayEnabled.value) {
    return mobileRelayStatus.value?.state === "ready"
      ? "Connected and ready for paired phones."
      : `Relay is enabled; status: ${relayLabel.value}.`;
  }
  return "Relay sessions are disconnected. Your phones remain paired.";
});

// A classified transport failure (TLS inspection above all) is explained in words; any other
// relay error stays in the badge's title, as before.
const relayNetworkErrorText = computed(() => describeNetworkErrorCode(mobileRelayStatus.value?.lastError));

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
const addPhoneSetupOpen = ref(false);
const pairingQr = ref<HTMLElement | null>(null);
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
let relayOverviewTimer: ReturnType<typeof setInterval> | null = null;

const activePairing = computed(() => {
  const invitation = appStore.mobilePairingInvitation;
  if (!invitation?.expiresAt) return null;
  return invitation.expiresAt - nowTick.value > 0 ? invitation : null;
});
const pairingExpired = computed(() => {
  const invitation = appStore.mobilePairingInvitation;
  return !!invitation?.expiresAt && invitation.expiresAt <= nowTick.value;
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
  nowTick.value = Date.now();
  try {
    await appStore.createMobilePairingInvitation({
      profileAllowlist: [...pairingProfileIds.value],
      capabilities: [...pairingCapabilities.value],
    });
    nowTick.value = Date.now();
  } catch (err) {
    pairingError.value = mobileErrorCopy(err, "pair");
  } finally {
    pairingBusy.value = false;
  }
}

async function connectFirstPhone(): Promise<void> {
  activeView.value = "phones";
  await nextTick();
  if (paused.value || !pairingReady.value || hostedAccessBlocked.value || pairingBusy.value || pairingSas.value) return;

  if (!mobileEnabled.value) {
    if (!(await setEnabled(true))) return;
    await nextTick();
    if (!mobileEnabled.value) {
      enableError.value = "Phone pairing is still off. Try turning it on again.";
      return;
    }
  }

  if (!activePairing.value) await startPairing();
  await nextTick();
  pairingQr.value?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}
async function cancelPairing() {
  await appStore.cancelMobilePairingInvitation();
}

const reviewError = reactive(new Map<string, string>());
async function reviewPendingPairing(deviceId: string) {
  reviewError.delete(deviceId);
  try {
    await appStore.refreshMobileDevicesAwaitingApproval(deviceId);
    if (appStore.mobilePairingSas?.deviceId !== deviceId) {
      reviewError.set(deviceId, "The pairing code for this phone is no longer available. Start pairing again.");
    }
  } catch (error) {
    reviewError.set(deviceId, mobileErrorCopy(error, "review"));
  }
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
  try {
    await appStore.revokeMobileDevice(device.deviceId);
    delete revokeError[device.deviceId];
  } catch (error) {
    revokeError[device.deviceId] = mobileErrorCopy(error, "revoke");
  }
}

const revokeError = reactive<Record<string, string>>({});

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
      forgetError[device.deviceId] = mobileResultReasonCopy(result.reason, "forget");
    }
  } catch (err) {
    forgetError[device.deviceId] = mobileErrorCopy(err, "forget");
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
    testPushResult[device.deviceId] = result?.ok
      ? "Test push sent."
      : mobileResultReasonCopy(result?.reason, "test-push");
  } catch (err) {
    testPushResult[device.deviceId] = mobileErrorCopy(err, "test-push");
  } finally {
    testPushBusyId.value = null;
  }
}

onMounted(() => {
  void appStore.refreshMobileDevices();
  void appStore.refreshMobileConnectionHealth();
  // The relay's state is runtime-only, so it is read rather than derived from the payload.
  void refreshRelayStatus();
  // Re-present a pairing code that was waiting for a decision when this desktop was last closed
  // (review 3 §P0.1's restart case). The code is derived from the transcript rather than stored, so
  // this asks the backend to recompute it; without it, a device claimed just before a restart would sit
  // in `keyProven` with no way for the user to either finish or reject it.
  void appStore.refreshMobileDevicesAwaitingApproval();
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
  relayOverviewTimer = setInterval(() => {
    if (props.visible && activeView.value === "overview" && mobileRelayEnabled.value && !paused.value)
      void refreshRelayStatus();
  }, 10000);
});
watch(
  () => [activeView.value, props.visible] as const,
  ([view, visible]) => {
    if (view === "overview" && visible) {
      void appStore.refreshMobileDevices();
      if (mobileRelayEnabled.value) void refreshRelayStatus();
    }
  },
);
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (relayOverviewTimer) clearInterval(relayOverviewTimer);
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
.mobile-tab__mutation-group {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.mobile-tab__phone-view {
  display: grid;
  gap: 12px;
}
.mobile-tab {
  display: grid;
  gap: 14px;
  width: min(100%, 760px);
  margin: 0 auto;
}

.mobile-tab__subtabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}
.mobile-tab__subtab {
  min-height: 36px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.mobile-tab__subtab--active {
  color: var(--text, var(--fg, #222));
  border-color: color-mix(in srgb, var(--accent, #f2a63b) 60%, transparent);
  background: color-mix(in srgb, var(--accent, #f2a63b) 12%, transparent);
}
.mobile-tab__subtab:focus-visible,
.mobile-tab button:focus-visible,
.mobile-tab__privacy > summary:focus-visible,
.mobile-tab__advanced > summary:focus-visible {
  outline: 2px solid var(--accent, #f2a63b);
  outline-offset: 2px;
}

/* The two halves of this tab. A rule rather than a blank line, because the account half is a whole
   page's worth of controls and the pairing half below it is a different subject. */
.mobile-tab__section {
  display: grid;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border, #333);
}
.mobile-tab__overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.mobile-tab__summary-card {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 13px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}
.mobile-tab__summary-card--ready {
  border-color: color-mix(in srgb, #34d399 34%, var(--border, #333));
}
.mobile-tab__summary-card--wide {
  grid-column: 1 / -1;
}
.mobile-tab__summary-label {
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.mobile-tab__summary-note {
  color: var(--muted);
  font-size: 12px;
}
.mobile-tab__summary-status {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 24px;
}
.mobile-tab__state-icon {
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  flex: none;
  border-radius: 50%;
}
.mobile-tab__state-icon svg {
  width: 15px;
  height: 15px;
}
.mobile-tab__state-icon--ready {
  color: #34d399;
  background: rgba(52, 211, 153, 0.12);
}
.mobile-tab__state-icon--idle {
  color: var(--muted);
  background: rgba(var(--tint), 0.07);
}
.mobile-tab__paired-phones {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 3px;
}
.mobile-tab__phone-name {
  max-width: 100%;
  padding: 3px 7px;
  border: 1px solid var(--border, #333);
  border-radius: 5px;
  color: var(--text);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.mobile-tab__relay-traffic {
  display: grid;
  gap: 2px;
  margin-top: 3px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #333);
  font-size: 11px;
}
.mobile-tab__relay-traffic span {
  color: var(--muted);
}
.mobile-tab__relay-traffic strong {
  font-size: 12px;
}
.mobile-tab__card-action svg {
  width: 14px;
  height: 14px;
}
.mobile-tab__relay-action--stop {
  color: var(--text);
}
.mobile-tab__relay-action--stop svg {
  color: #ff8ca4;
}
.mobile-tab__relay-action--stop:hover:not(:disabled) {
  background: rgba(255, 111, 141, 0.11);
}
.mobile-tab__section--auxiliary {
  padding-bottom: 0;
  border-bottom: 0;
}
.mobile-tab__section--auxiliary:has(.account-tab:empty) {
  display: none;
}
.mobile-tab__card-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  justify-self: start;
  margin-top: auto;
}
.mobile-tab__inline-action {
  padding: 0;
  border: 0;
  color: var(--accent);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}
@media (max-width: 520px) {
  .mobile-tab__overview-grid {
    grid-template-columns: 1fr;
  }
}

.mobile-tab__section-title {
  margin: 0;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.mobile-tab__phone-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
.mobile-tab__steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: mobile-step;
}
.mobile-tab__steps li {
  display: grid;
  gap: 3px;
  padding: 10px;
  border: 1px solid var(--border, #333);
  border-radius: 7px;
  counter-increment: mobile-step;
}
.mobile-tab__steps li::before {
  content: counter(mobile-step);
  color: var(--accent, #f2a63b);
  font-size: 11px;
  font-weight: 700;
}
.mobile-tab__steps .mobile-tab__step--active {
  border-color: color-mix(in srgb, var(--accent, #f2a63b) 70%, var(--border, #333));
  background: color-mix(in srgb, var(--accent, #f2a63b) 8%, transparent);
}
.mobile-tab__steps strong {
  font-size: 12px;
}
.mobile-tab__steps span {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}
@media (max-width: 560px) {
  .mobile-tab__steps {
    grid-template-columns: 1fr;
  }
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
  padding-top: 8px;
  border-top: 1px solid var(--border, #333);
}

.mobile-tab__advanced[open] {
  display: grid;
  gap: 10px;
}

.mobile-tab__privacy > summary,
.mobile-tab__advanced > summary {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  user-select: none;
}
.mobile-tab__privacy > summary::-webkit-details-marker,
.mobile-tab__advanced > summary::-webkit-details-marker {
  display: none;
}
.mobile-tab__privacy > summary::before,
.mobile-tab__advanced > summary::before {
  content: "";
  width: 7px;
  height: 7px;
  flex: none;
  margin-left: 2px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(-45deg);
}
.mobile-tab__privacy[open] > summary::before,
.mobile-tab__advanced[open] > summary::before {
  transform: rotate(45deg);
}
.mobile-tab__privacy > summary:hover,
.mobile-tab__advanced > summary:hover {
  color: var(--text);
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
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
}
.mobile-tab__privacy-copy {
  margin: 4px 0 0 19px;
}
.mobile-tab__resume-card {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent, #f2a63b) 55%, var(--border, #333));
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent, #f2a63b) 8%, transparent);
  font-size: 12px;
}
.mobile-tab__resume-card > span {
  color: var(--muted);
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

/* Monospace and wide-tracked: this is typed digit by digit from a phone held next to the screen. Fits "0000 0000" with its tracking and padding. */
.pairing-sas__input {
  font-family: var(--font-mono, monospace);
  font-size: 22px;
  letter-spacing: 0.14em;
  width: calc(9ch + 9 * 0.14em + 32px);
  max-width: 100%;
  box-sizing: border-box;
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
.pairing-section__action {
  justify-self: start;
}

.pairing-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--accent, #f59e0b);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent, #f59e0b) 9%, transparent);
}

.pairing-progress__spinner {
  flex: none;
  width: 20px;
  height: 20px;
  border: 2px solid var(--accent, #f59e0b);
  border-top-color: transparent;
  border-radius: 50%;
  animation: mobile-tab-spin 0.8s linear infinite;
}

.pairing-progress strong {
  display: block;
}

.pairing-progress p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .pairing-progress__spinner {
    animation: none;
  }
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
  grid-template-columns: auto minmax(180px, 1fr);
  align-items: center;
  gap: 8px;
}
.pairing-qr__instructions {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 4px 8px;
}
.pairing-qr__instructions h3,
.pairing-qr__instructions p {
  margin: 0;
}
.pairing-qr__instructions h3 {
  font-size: 16px;
}
.pairing-qr__instructions > p:not(.pairing-qr__meta) {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.pairing-qr__step {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
@media (max-width: 620px) {
  .pairing-qr {
    grid-template-columns: 1fr;
    justify-items: start;
  }
  .pairing-qr__instructions {
    padding: 0;
  }
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
.device-item__fingerprint summary {
  cursor: pointer;
}
.device-item__fingerprint code {
  overflow-wrap: anywhere;
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

.device-item__connected {
  color: var(--success-fg, var(--success));
  font-weight: 600;
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
