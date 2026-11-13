import { createSignal, For, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { Icon } from "../../components/icon";
import { animate } from "../../ds/motion/animate";
import { press } from "../../ds/motion/press";
import { reducedMotion } from "../../ds/motion/reduced";
import { motionTokens } from "../../ds/motion/tokens";

export interface PendingQuestion {
  id: string;
  questions: {header:string; question:string; options:{label:string; description?:string}[]; multiple?:boolean; custom?:boolean; recommend?:string; decide_later?:boolean}[];
}

const DELEGATE_LABEL = "Decide later (do whatever you think is best)";

/** One request stays mounted across live snapshots so typed answers survive. */
export function QuestionPanel(props: {
  request: PendingQuestion;
  connected: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (answers: string[][]) => void;
}) {
  const [step, setStep] = createSignal(0);
  const questions = () => Array.isArray(props.request?.questions) ? props.request.questions : [];
  const [drafts, setDrafts] = createStore(questions().map((q) => ({selected:[] as string[], custom:!q.options?.length, text:""})));
  const question = () => questions()[step()] || { header: "", question: "", options: [] };
  const draft = () => drafts[step()] || { selected: [], custom: false, text: "" };
  const answers = (i: number) => {
    const d = drafts[i];
    if (!d) return [];
    return [...d.selected, ...(d.custom && d.text.trim() ? [d.text.trim()] : [])];
  };
  const ready = (i: number) => answers(i).length > 0 && (!drafts[i]?.custom || !!drafts[i]?.text.trim());
  let heading: HTMLLegendElement | undefined;
  let fieldsetRef: HTMLFieldSetElement | undefined;
  let customTextareaRef: HTMLTextAreaElement | undefined;
  function move(next: number) {
    const dir = next >= step() ? 1 : -1;
    setStep(next);
    if (fieldsetRef && !untrack(reducedMotion)) {
      animate(
        fieldsetRef,
        { opacity: 1, translate: "0px 0px", filter: "blur(0px)" },
        { duration: 0.22, ease: motionTokens.ease.enter },
        {
          from: {
            opacity: 0.25,
            translate: `${dir * 16}px 0px`,
            filter: "blur(2.5px)",
          },
        },
      );
    }
    requestAnimationFrame(() => heading?.focus());
  }
  function choose(label: string, checked: boolean) {
    const q = question();
    const d = draft();
    if (q.multiple) setDrafts(step(), "selected", checked ? [...d.selected, label] : d.selected.filter((v) => v !== label));
    else setDrafts(step(), {selected:[label], custom:false});
  }
  return <section aria-label="Questions from assistant" class="mb-3 overflow-hidden rounded-panel border border-border bg-surface">
    <div class="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-subtle bg-surface-subtle text-xs text-fg-secondary">
      <Icon icon="lucide:message-circle-question" size={14} class="text-fg-muted shrink-0" />
      <span class="font-medium text-fg">Your input is needed</span>
      <Show when={questions().length > 1}>
        <div class="hidden sm:flex items-center gap-1 ml-1.5" aria-hidden="true">
          <For each={questions()}>
            {(_, idx) => (
              <span
                class={`h-1 rounded-full transition-all duration-200 ${
                  idx() === step()
                    ? "w-3.5 bg-fg"
                    : ready(idx())
                    ? "w-1.5 bg-success"
                    : "w-1.5 bg-border-strong"
                }`}
              />
            )}
          </For>
        </div>
      </Show>
      <span class="ml-auto font-mono text-2xs tabular-nums text-fg-muted" aria-live="polite">
        {step()+1} of {questions().length}
      </span>
    </div>
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!ready(step()) || props.submitting) return;
      if (step() < questions().length-1) move(step()+1);
      else if (props.connected && drafts.every((_, i) => ready(i))) props.onSubmit(drafts.map((_, i) => answers(i)));
    }}>
      <fieldset ref={fieldsetRef} disabled={props.submitting} class="px-3.5 py-3.5 max-h-[min(60dvh,26rem)] overflow-y-auto overscroll-contain min-w-0">
        <legend ref={heading} tabIndex={-1} class="float-left w-full mb-3 outline-none">
          <Show when={question().header}>
            <span class="block text-2xs font-medium text-accent mb-1">{question().header}</span>
          </Show>
          <span class="block text-sm font-medium text-fg whitespace-pre-wrap break-words leading-snug">{question().question}</span>
        </legend>
        <div class="clear-both space-y-2">
          <Show when={question().multiple}><p class="text-2xs text-fg-muted">Select all that apply.</p></Show>
          <For each={(() => {
            const opts = [...(question().options || [])];
            const rec = ((question() as any).recommend as string | undefined || "").trim().toLowerCase();
            if (rec && !question().multiple) {
              const i = opts.findIndex((o) => o.label.trim().toLowerCase() === rec);
              if (i > 0) { const [r] = opts.splice(i, 1); opts.unshift(r); }
            }
            return opts;
          })()}>{(option) => {
            const isSelected = () => draft().selected.includes(option.label);
            const isRec = () => Boolean((question() as any).recommend && option.label.trim().toLowerCase() === ((question() as any).recommend as string).trim().toLowerCase());
            return (
              <label
                onPointerDown={(e) => press(e.currentTarget)}
                class={`flex items-start gap-3 rounded-lg border px-3.5 py-2.5 min-h-10 [@media(pointer:coarse)]:min-h-11 cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
                  isSelected()
                    ? "border-[color-mix(in_oklab,var(--accent)_42%,var(--border))] bg-accent-subtle"
                    : "border-border bg-surface hover:bg-surface-muted hover:border-border-strong"
                }`}
              >
                <input
                  type={question().multiple ? "checkbox" : "radio"}
                  name={`${props.request.id}-${step()}`}
                  checked={isSelected()}
                  onChange={(e) => choose(option.label, e.currentTarget.checked)}
                  class="sr-only"
                />
                <span
                  aria-hidden="true"
                  class={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors ${
                    question().multiple ? "rounded" : "rounded-full"
                  } ${
                    isSelected()
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border-strong bg-surface"
                  }`}
                >
                  <Show when={isSelected()}>
                    <Show
                      when={question().multiple}
                      fallback={<span class="h-1.5 w-1.5 rounded-full bg-accent-foreground" />}
                    >
                      <Icon icon="lucide:check" size={11} />
                    </Show>
                  </Show>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 flex-wrap text-xs font-medium text-fg break-words">
                    <span>{option.label}</span>
                    <Show when={isRec()}>
                      <span class="rounded-full border border-[color-mix(in_oklab,var(--accent)_28%,var(--border))] bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-accent">
                        Recommended
                      </span>
                    </Show>
                  </span>
                  <Show when={option.description}>
                    <span class="block mt-1 text-xs text-fg-muted break-words leading-snug">{option.description}</span>
                  </Show>
                </span>
              </label>
            );
          }}</For>
          <Show when={(question() as any).decide_later && !question().multiple}>
            <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={() => {
              if (props.submitting) return;
              if (step() < questions().length-1) { setDrafts(step(), {selected:[DELEGATE_LABEL], custom:false}); move(step()+1); }
              else if (props.connected) props.onSubmit(drafts.map((_, i) => i === step() ? [DELEGATE_LABEL] : answers(i)));
            }} class="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-3.5 py-2.5 min-h-10 [@media(pointer:coarse)]:min-h-11 text-left text-xs text-fg-secondary transition-colors hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] hover:bg-accent-subtle hover:text-fg cursor-pointer">
              <Icon icon="lucide:sparkles" size={14} class="text-accent shrink-0" />
              <span>{DELEGATE_LABEL}. The assistant proceeds with its best judgment.</span>
            </button>
          </Show>
          <label
            onPointerDown={(e) => press(e.currentTarget)}
            class={`flex items-center gap-3 rounded-lg border px-3.5 py-2.5 min-h-10 [@media(pointer:coarse)]:min-h-11 cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
              draft().custom
                ? "border-[color-mix(in_oklab,var(--accent)_42%,var(--border))] bg-accent-subtle"
                : "border-border bg-surface hover:bg-surface-muted hover:border-border-strong"
            }`}
          >
            <input
              type={question().multiple ? "checkbox" : "radio"}
              name={`${props.request.id}-${step()}`}
              checked={draft().custom}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setDrafts(step(), "custom", checked);
                if (!question().multiple) setDrafts(step(), "selected", []);
                if (checked) {
                  requestAnimationFrame(() => customTextareaRef?.focus());
                }
              }}
              class="sr-only"
            />
            <span
              aria-hidden="true"
              class={`flex h-4 w-4 shrink-0 items-center justify-center border transition-colors ${
                question().multiple ? "rounded" : "rounded-full"
              } ${
                draft().custom
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border-strong bg-surface"
              }`}
            >
              <Show when={draft().custom}>
                <Show
                  when={question().multiple}
                  fallback={<span class="h-1.5 w-1.5 rounded-full bg-accent-foreground" />}
                >
                  <Icon icon="lucide:check" size={11} />
                </Show>
              </Show>
            </span>
            <span class="text-xs font-medium text-fg-secondary">Type your own answer</span>
          </label>
          <Show when={draft().custom}>
            <textarea ref={customTextareaRef} aria-label="Your answer" placeholder="Type your own answer or provide more details…" value={draft().text} maxLength={4000} rows={2} onInput={(e) => setDrafts(step(), "text", e.currentTarget.value)} class="block w-full resize-y rounded-lg border border-border bg-surface-subtle px-3.5 py-2.5 text-sm max-sm:text-base text-fg outline-none focus:border-accent focus:bg-surface placeholder:text-fg-muted transition-colors" />
          </Show>
        </div>
      </fieldset>
      <Show when={props.error}><p role="alert" class="px-3.5 pb-2 text-xs text-danger">{props.error}</p></Show>
      <div class="flex items-center gap-2 border-t border-border-subtle bg-surface-subtle px-3.5 py-2.5">
        <button type="button" disabled={step() === 0 || props.submitting} onPointerDown={(e) => { if (!e.currentTarget.disabled) press(e.currentTarget); }} onClick={() => move(step()-1)} class="min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted disabled:opacity-40 cursor-pointer disabled:cursor-default transition-colors">Back</button>
        <Show when={!props.connected}><span class="text-2xs text-warning flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />Reconnecting…</span></Show>
        <button type="submit" disabled={!ready(step()) || props.submitting || (step() === questions().length-1 && !props.connected)} onPointerDown={(e) => { if (!e.currentTarget.disabled) press(e.currentTarget); }} class="ml-auto min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg bg-accent hover:bg-accent-strong text-accent-foreground px-4 py-1.5 text-xs font-medium disabled:opacity-40 cursor-pointer disabled:cursor-default transition-colors">
          {props.submitting ? "Sending…" : step() < questions().length-1 ? "Next" : "Send answers"}
        </button>
      </div>
    </form>
  </section>;
}
