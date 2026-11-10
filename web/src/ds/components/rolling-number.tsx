import { createEffect, For, Index, on, onMount, Show } from "solid-js";

import { animate } from "../motion/animate";
import { motionTokens } from "../motion/tokens";

/**
 * Numbers that roll to their new value digit by digit (Arc "Slot text" /
 * "Animated counter"). Columns are aligned from the right so a changing
 * value keeps its units in place; tabular digits keep every column the same
 * width, so only a gained or lost digit changes the width. The first render
 * spins up from zero with a short stagger; reduced motion shows the value.
 */
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function DigitColumn(props: { char: string; index: number }) {
  let strip!: HTMLSpanElement;
  const digit = () => Number(props.char);
  const position = (value: number) => `0px ${-value * 10}%`;
  onMount(() => {
    animate(strip, { translate: position(digit()) }, { ...motionTokens.spring.morph, delay: Math.min(props.index, 6) * motionTokens.stagger.item }, { from: { translate: position(0) } });
  });
  createEffect(on(digit, (value) => {
    animate(strip, { translate: position(value) }, motionTokens.spring.morph);
  }, { defer: true }));
  return (
    <span class="ui-roll-col">
      <span class="ui-roll-sizer">{props.char}</span>
      <span ref={strip} class="ui-roll-strip">
        <For each={DIGITS}>{(d) => <span>{d}</span>}</For>
      </span>
    </span>
  );
}

export function RollingNumber(props: { value: string | number; format?: (n: number) => string; class?: string }) {
  const text = () => {
    if (typeof props.value === "number") {
      return props.format ? props.format(props.value) : String(props.value);
    }
    return props.value;
  };
  // Right-aligned columns: index 0 is the last character.
  const reversed = () => [...text()].reverse();

  return (
    <span class={`ui-roll ${props.class ?? ""}`} role="img" aria-label={text()}>
      <span class="inline-flex flex-row-reverse items-baseline" aria-hidden="true">
        <Index each={reversed()}>
          {(char, index) => (
            <Show when={/\d/.test(char())} fallback={<span class="ui-roll-static">{char()}</span>}>
              <DigitColumn char={char()} index={index} />
            </Show>
          )}
        </Index>
      </span>
    </span>
  );
}
