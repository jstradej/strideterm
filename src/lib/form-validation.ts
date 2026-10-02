/** App-wide, accessible copy for browser-native constraint validation. */

type ValidatableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface FeedbackState {
  message: HTMLDivElement;
  previousInvalid: string | null;
  previousDescribedBy: string | null;
  messageId: string;
  text: string;
}

const feedback = new WeakMap<ValidatableControl, FeedbackState>();
let nextMessageId = 0;
let firstInvalid: ValidatableControl | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;

function isControl(target: EventTarget | null): target is ValidatableControl {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
  );
}

function cleanCaption(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*[*:]\s*$/, "")
    .trim();
}

function fieldLabel(control: ValidatableControl): string {
  const explicit = control.dataset.validationLabel?.trim();
  if (explicit) return explicit;

  const captions = control.labels
    ? Array.from(control.labels)
        .map((label) => {
          const copy = label.cloneNode(true) as HTMLElement;
          copy
            .querySelectorAll(
              "input, select, textarea, button, .form-help, .help-text, .hint, .app-form-validation-error",
            )
            .forEach((node) => node.remove());
          return cleanCaption(copy.textContent || "");
        })
        .filter(Boolean)
    : [];
  if (captions.length) return captions[0];

  const ariaLabel = control.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const name = control.getAttribute("name")?.trim();
  if (name) return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return "this field";
}

function validationMessage(control: ValidatableControl): string {
  const validity = control.validity;
  const label = fieldLabel(control);
  if (validity.customError) return control.validationMessage || `Check the value for ${label}.`;
  if (validity.valueMissing) {
    const expected = control.dataset.validationRequired?.trim();
    if (expected) return expected;
    return `Enter ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}.`;
  }
  if (validity.typeMismatch) {
    if (control instanceof HTMLInputElement && control.type === "email")
      return `Enter a valid email address for ${label}.`;
    if (control instanceof HTMLInputElement && control.type === "url")
      return `Enter a complete web address for ${label}.`;
    return `Enter a valid value for ${label}.`;
  }
  if (validity.rangeUnderflow && control instanceof HTMLInputElement)
    return `Enter a value of at least ${control.min} for ${label}.`;
  if (validity.rangeOverflow && control instanceof HTMLInputElement)
    return `Enter a value no greater than ${control.max} for ${label}.`;
  if (validity.stepMismatch && control instanceof HTMLInputElement) {
    const step = control.step;
    return step && step !== "any" ? `Enter ${label} in increments of ${step}.` : `Enter a valid value for ${label}.`;
  }
  if (validity.tooShort && control instanceof HTMLInputElement)
    return `Enter at least ${control.minLength} characters for ${label}.`;
  if (validity.tooLong && control instanceof HTMLInputElement)
    return `Enter no more than ${control.maxLength} characters for ${label}.`;
  if (validity.patternMismatch) {
    const patternGuide = control.dataset.validationPattern?.trim();
    if (patternGuide) return patternGuide;
    const title = control.getAttribute("title")?.trim();
    if (title && title.length <= 120) return title;
    return `Enter ${label} in the required format.`;
  }
  if (validity.badInput) return `Enter a valid value for ${label}.`;
  return `Check the value for ${label}.`;
}

function showFeedback(control: ValidatableControl): void {
  const text = validationMessage(control);
  const existing = feedback.get(control);
  if (existing) {
    existing.text = text;
    existing.message.textContent = text;
    if (!existing.message.isConnected) insertFeedback(control, existing.message);
    return;
  }

  const messageId = `form-validation-error-${++nextMessageId}`;
  const message = document.createElement("div");
  message.id = messageId;
  message.className = "app-form-validation-error";
  message.setAttribute("role", "alert");
  message.textContent = text;

  const state: FeedbackState = {
    message,
    messageId,
    text,
    previousInvalid: control.getAttribute("aria-invalid"),
    previousDescribedBy: control.getAttribute("aria-describedby"),
  };
  feedback.set(control, state);

  const describedBy = (state.previousDescribedBy || "").split(/\s+/).filter(Boolean);
  if (!describedBy.includes(messageId)) describedBy.push(messageId);
  control.setAttribute("aria-describedby", describedBy.join(" "));
  control.setAttribute("aria-invalid", "true");

  insertFeedback(control, message);
}

function insertFeedback(control: ValidatableControl, message: HTMLElement): void {
  const field = control.closest<HTMLElement>(".field");
  if (field?.parentElement?.classList.contains("quick-grid")) {
    // Keep all controls in their original grid positions, then let feedback
    // occupy following rows instead of inserting new grid items between them.
    field.parentElement.append(message);
    return;
  }
  if (field) {
    // Field wrappers are the stable unit in both stacked forms and labeled
    // grid columns. Appending avoids creating siblings that perturb layouts.
    field.append(message);
    return;
  }
  const label = control.closest("label");
  if (label) {
    // Some forms use a bare label as the field wrapper. Append after its
    // input/action row so feedback does not split a compound control.
    label.append(message);
    return;
  }
  const group = control.closest<HTMLElement>(".input-group, .input-row, .field-control, .form-control-wrap");
  (group || control).insertAdjacentElement("afterend", message);
}

function clearFeedback(control: ValidatableControl): void {
  const state = feedback.get(control);
  if (!state) return;
  state.message.remove();

  const describedBy = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  const remaining = describedBy.filter((id) => id !== state.messageId);
  if (remaining.length) control.setAttribute("aria-describedby", remaining.join(" "));
  else control.removeAttribute("aria-describedby");
  if (state.previousDescribedBy) {
    const original = state.previousDescribedBy.split(/\s+/).filter(Boolean);
    const merged = [...new Set([...original, ...remaining])];
    control.setAttribute("aria-describedby", merged.join(" "));
  }

  if (state.previousInvalid === null) control.removeAttribute("aria-invalid");
  else control.setAttribute("aria-invalid", state.previousInvalid);
  feedback.delete(control);
}

function queueFirstInvalidFocus(control: ValidatableControl): void {
  if (!firstInvalid) firstInvalid = control;
  if (focusTimer !== null) return;
  focusTimer = setTimeout(() => {
    const target = firstInvalid;
    firstInvalid = null;
    focusTimer = null;
    if (target?.isConnected && !target.validity.valid) target.focus();
  }, 0);
}

/** Install once on a document; delegated listeners cover forms mounted later. */
export function installFormValidationFeedback(doc: Document = document): () => void {
  const onInvalid = (event: Event): void => {
    if (!isControl(event.target) || !event.target.willValidate) return;
    event.preventDefault();
    showFeedback(event.target);
    queueFirstInvalidFocus(event.target);
  };
  const onCorrection = (event: Event): void => {
    if (isControl(event.target) && event.target.validity.valid) clearFeedback(event.target);
  };

  doc.addEventListener("invalid", onInvalid, true);
  doc.addEventListener("input", onCorrection, true);
  doc.addEventListener("change", onCorrection, true);
  return () => {
    doc.removeEventListener("invalid", onInvalid, true);
    doc.removeEventListener("input", onCorrection, true);
    doc.removeEventListener("change", onCorrection, true);
    if (focusTimer !== null) clearTimeout(focusTimer);
    focusTimer = null;
    firstInvalid = null;
  };
}
