import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import { anchorFloat } from "../../floating";
import { animate } from "../motion/animate";
import { createPresence, cssExit } from "../motion/presence";
import { press } from "../motion/press";
import { reducedMotion } from "../motion/reduced";
import { motionTokens } from "../motion/tokens";
import { pushLayer } from "../primitives/layers";
import {
  Calendar,
  monthStart,
  RollingText,
  type CalendarDateMatcher,
} from "./calendar";
import { Glyph } from "./icon";

export interface DatePickerProps {
  label?: string;
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  description?: string;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  disabledDates?: CalendarDateMatcher;
  locale?: string;
  format?: Intl.DateTimeFormatOptions;
  showToday?: boolean;
  disabled?: boolean;
  class?: string;
  ariaLabel?: string;
}

export function DatePicker(props: DatePickerProps) {
  const id = createUniqueId();
  const locale = () => props.locale ?? "en-US";
  const formatOpts = () =>
    props.format ?? { month: "short", day: "numeric", year: "numeric" };
  const formatter = createMemo(
    () => new Intl.DateTimeFormat(locale(), formatOpts()),
  );
  const [open, setOpen] = createSignal(false);
  const [month, setMonth] = createSignal(monthStart(props.value ?? new Date()));
  const [popoverEl, setPopoverEl] = createSignal<HTMLDivElement>();
  const presence = createPresence(open, { exit: (el) => cssExit(el, 140) });

  let rootRef!: HTMLDivElement;
  let triggerRef!: HTMLButtonElement;
  let statusEl: HTMLSpanElement | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  let prevTime: number | null = untrack(() => props.value?.getTime() ?? null);
  const [direction, setDirection] = createSignal(1);
  createEffect(() => {
    const t = props.value?.getTime() ?? null;
    if (t !== prevTime) {
      setDirection(t === null || prevTime === null || t >= prevTime ? 1 : -1);
      prevTime = t;
    }
  });

  const shown = createMemo(() =>
    props.value ? formatter().format(props.value) : props.placeholder ?? "Select a date",
  );
  const statusText = createMemo(() =>
    props.value ? `Selected ${formatter().format(props.value)}` : "Choose a day",
  );

  // Status confirmation line rises in on change
  createEffect(
    on(
      statusText,
      () => {
        if (!statusEl || untrack(reducedMotion)) return;
        animate(
          statusEl,
          { opacity: 1, translate: "0px 0px", filter: "blur(0px)" },
          { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter },
          {
            from: {
              opacity: 0,
              translate: "0px 0.3em",
              filter: `blur(${motionTokens.blur.soft}px)`,
            },
          },
        );
      },
      { defer: true },
    ),
  );

  const close = (restoreFocus = false) => {
    clearTimeout(closeTimer);
    const activeInPopover = popoverEl()?.contains(document.activeElement);
    setOpen(false);
    if (restoreFocus || activeInPopover) {
      triggerRef?.focus({ preventScroll: true });
    }
  };

  const show = () => {
    clearTimeout(closeTimer);
    setMonth(monthStart(props.value ?? new Date()));
    setOpen(true);
    queueMicrotask(() => {
      popoverEl()
        ?.querySelector<HTMLButtonElement>('[data-present] [data-date][tabindex="0"]')
        ?.focus({ preventScroll: true });
    });
  };

  const selectDate = (date: Date | undefined) => {
    props.onChange?.(date);
    clearTimeout(closeTimer);
    if (reducedMotion() || !date) {
      close(true);
    } else {
      closeTimer = setTimeout(() => close(true), 280);
    }
  };

  createEffect(() => {
    if (!open()) return;
    const offLayer = pushLayer({
      kind: "popover",
      contains: (node) => rootRef.contains(node) || !!popoverEl()?.contains(node),
      onEscape: () => close(true),
      onOutside: () => close(false),
    });
    onCleanup(() => offLayer());
  });

  onCleanup(() => clearTimeout(closeTimer));

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (
      (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") &&
      !open()
    ) {
      event.preventDefault();
      show();
    } else if (event.key === "Escape" && open()) {
      event.preventDefault();
      close(true);
    }
  };

  return (
    <div ref={rootRef} class={`ui-date-picker ${props.class ?? ""}`}>
      <Show when={props.label}>
        <label for={id} class="ui-label">
          {props.label}
        </label>
      </Show>
      <div class="ui-date-picker-anchor">
        <button
          ref={triggerRef}
          id={id}
          type="button"
          disabled={props.disabled}
          aria-label={props.ariaLabel ? `${props.ariaLabel}: ${shown()}` : undefined}
          aria-haspopup="dialog"
          aria-expanded={open()}
          aria-describedby={props.description ? `${id}-desc` : undefined}
          class="ui-date-picker-trigger"
          onClick={() => (open() ? close() : show())}
          onKeyDown={onTriggerKeyDown}
        >
          <Glyph icon="lucide:calendar-days" size={16} class="ui-date-picker-icon" />
          <span
            class={`ui-date-picker-value ${props.value ? "" : "is-placeholder"}`}
          >
            <RollingText text={shown()} direction={direction()} />
          </span>
          <Glyph
            icon="lucide:chevron-down"
            size={15}
            class={`ui-select-chevron ${open() ? "is-open" : ""}`}
          />
        </button>

        <Show when={presence.present()}>
          <Portal>
            <div
              ref={(el) => {
                setPopoverEl(el);
                presence.ref(el);
                const anchor = triggerRef.getBoundingClientRect();
                const below = document.documentElement.clientHeight - anchor.bottom;
                onCleanup(
                  anchorFloat(triggerRef, el, {
                    placement: below >= 390 || below >= anchor.top ? "bottom-start" : "top-start",
                    flip: false,
                    gap: 8,
                    padding: 12,
                  }),
                );
                onCleanup(() => setPopoverEl(undefined));
              }}
              role="dialog"
              aria-label={`${props.label ?? props.ariaLabel ?? "Date"} calendar`}
              class="ui-popover ui-date-picker-popover"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close(true);
                }
              }}
            >
              <Calendar
                value={props.value}
                onChange={selectDate}
                month={month()}
                onMonthChange={setMonth}
                minDate={props.minDate}
                maxDate={props.maxDate}
                disabledDates={props.disabledDates}
                locale={locale()}
                showToday={props.showToday ?? true}
              />
              <div class="ui-date-picker-footer">
                <button
                  type="button"
                  class="ui-date-picker-clear"
                  disabled={!props.value}
                  onPointerDown={(e) => {
                    if (props.value) press(e.currentTarget);
                  }}
                  onClick={() => selectDate(undefined)}
                >
                  Clear
                </button>
                <span class="ui-date-picker-status" aria-live="polite">
                  <span ref={statusEl}>{statusText()}</span>
                </span>
              </div>
            </div>
          </Portal>
        </Show>
      </div>
      <Show when={props.description}>
        <span id={`${id}-desc`} class="ui-hint">
          {props.description}
        </span>
      </Show>
    </div>
  );
}

/* ========================================================================== *
 * TimePicker — Arc UI clock-roll trigger + centered scrollable listbox       *
 * ========================================================================== */

export interface TimePickerProps {
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  description?: string;
  placeholder?: string;
  minuteStep?: 1 | 5 | 10 | 15 | 30;
  format?: "12h" | "24h";
  disabled?: boolean;
  class?: string;
  ariaLabel?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const toMinutes = (raw: string) => {
  const [h = NaN, m = NaN] = raw.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};

export function TimePicker(props: TimePickerProps) {
  const id = createUniqueId();
  const [internal, setInternal] = createSignal(props.defaultValue ?? "09:00");
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const [menuEl, setMenuEl] = createSignal<HTMLDivElement>();
  const presence = createPresence(open, { exit: (el) => cssExit(el, 120) });

  let rootRef!: HTMLDivElement;
  let triggerRef!: HTMLButtonElement;
  let centerOnOpen = false;

  const selected = () => props.value ?? internal();
  const step = () => props.minuteStep ?? 15;
  const options = createMemo(() =>
    Array.from({ length: Math.ceil(1440 / step()) }, (_, idx) => {
      const mins = idx * step();
      return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    }),
  );

  const display = (raw: string) => {
    if (!raw) return props.placeholder ?? "Select time";
    const mins = toMinutes(raw);
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    return (props.format ?? "12h") === "24h"
      ? `${pad2(hour)}:${pad2(minute)}`
      : `${hour % 12 || 12}:${pad2(minute)} ${hour < 12 ? "AM" : "PM"}`;
  };

  let prevVal = untrack(selected);
  const [direction, setDirection] = createSignal(1);
  createEffect(() => {
    const cur = selected();
    if (cur !== prevVal) {
      setDirection(toMinutes(cur) >= toMinutes(prevVal) ? 1 : -1);
      prevVal = cur;
    }
  });

  createEffect(() => {
    if (!open()) return;
    const idx = activeIndex();
    if (idx < 0) return;
    queueMicrotask(() => {
      const menu = menuEl();
      const opt = menu?.querySelector<HTMLElement>(`[data-time-idx="${idx}"]`);
      if (!menu || !opt) return;
      const top = opt.offsetTop;
      const bottom = top + opt.offsetHeight;
      if (centerOnOpen) {
        centerOnOpen = false;
        menu.scrollTop = top - (menu.clientHeight - opt.offsetHeight) / 2;
      } else if (top < menu.scrollTop) {
        menu.scrollTop = top;
      } else if (bottom > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = bottom - menu.clientHeight;
      }
    });
  });

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef?.focus({ preventScroll: true });
  };

  const openMenu = () => {
    const opts = options();
    const selIdx = opts.indexOf(selected());
    setActiveIndex(selIdx >= 0 ? selIdx : 0);
    centerOnOpen = true;
    setOpen(true);
  };

  const choose = (next: string) => {
    if (props.value === undefined) setInternal(next);
    props.onChange?.(next);
    close(true);
  };

  createEffect(() => {
    if (!open()) return;
    const offLayer = pushLayer({
      kind: "menu",
      contains: (node) => rootRef.contains(node) || !!menuEl()?.contains(node),
      onEscape: () => close(true),
      onOutside: () => close(false),
    });
    onCleanup(() => offLayer());
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open() && activeIndex() >= 0) {
        const opt = options()[activeIndex()];
        if (opt) choose(opt);
      } else {
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) {
        openMenu();
        return;
      }
      const len = options().length;
      setActiveIndex((idx) => (idx + (event.key === "ArrowDown" ? 1 : -1) + len) % len);
    }
  };

  return (
    <div ref={rootRef} class={`ui-time-picker ${props.class ?? ""}`}>
      <Show when={props.label}>
        <label for={id} class="ui-label">
          {props.label}
        </label>
      </Show>
      <div class="ui-time-picker-anchor">
        <button
          ref={triggerRef}
          id={id}
          type="button"
          disabled={props.disabled}
          aria-label={props.ariaLabel ? `${props.ariaLabel}: ${display(selected())}` : undefined}
          aria-haspopup="listbox"
          aria-expanded={open()}
          aria-controls={open() ? `${id}-listbox` : undefined}
          class="ui-date-picker-trigger"
          onClick={() => (open() ? close() : openMenu())}
          onKeyDown={onKeyDown}
        >
          <Glyph icon="lucide:clock" size={16} class="ui-date-picker-icon" />
          <span
            class={`ui-date-picker-value ${selected() ? "" : "is-placeholder"}`}
          >
            <RollingText text={display(selected())} direction={direction()} />
          </span>
          <Glyph
            icon="lucide:chevron-down"
            size={15}
            class={`ui-select-chevron ${open() ? "is-open" : ""}`}
          />
        </button>

        <Show when={presence.present()}>
          <Portal>
            <div
              id={`${id}-listbox`}
              ref={(el) => {
                setMenuEl(el);
                presence.ref(el);
                const anchor = triggerRef.getBoundingClientRect();
                const below = document.documentElement.clientHeight - anchor.bottom;
                onCleanup(
                  anchorFloat(triggerRef, el, {
                    placement: below >= 260 || below >= anchor.top ? "bottom-start" : "top-start",
                    flip: false,
                    gap: 6,
                    padding: 12,
                    matchWidth: true,
                    maxHeight: 250,
                  }),
                );
                onCleanup(() => setMenuEl(undefined));
              }}
              role="listbox"
              data-layer-managed=""
              aria-label={`${props.label ?? props.ariaLabel ?? "Time"} options`}
              class="ui-popover ui-time-picker-menu"
              onKeyDown={onKeyDown}
            >
              <For each={options()}>
                {(option, index) => (
                  <button
                    type="button"
                    role="option"
                    data-time-idx={index()}
                    aria-selected={option === selected()}
                    data-active={activeIndex() === index() || undefined}
                    class="ui-time-picker-option"
                    onPointerMove={() => {
                      if (activeIndex() !== index()) setActiveIndex(index());
                    }}
                    onClick={() => choose(option)}
                  >
                    <span>{display(option)}</span>
                    <Show when={option === selected()}>
                      <span class="ui-time-picker-dot" aria-hidden="true" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Portal>
        </Show>
      </div>
      <Show when={props.description}>
        <span class="ui-hint">{props.description}</span>
      </Show>
    </div>
  );
}

/* ========================================================================== *
 * DateTimePicker — Combines DatePicker + TimePicker on an ISO local string   *
 * (`YYYY-MM-DDTHH:mm`) while keeping an accessible input for programmatic    *
 * form fills.                                                                *
 * ========================================================================== */

export interface DateTimePickerProps {
  label?: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  minuteStep?: 1 | 5 | 10 | 15 | 30;
  format?: "12h" | "24h";
  disabled?: boolean;
  class?: string;
}

const formatIsoDatePart = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function DateTimePicker(props: DateTimePickerProps) {
  const parsedDate = createMemo<Date | undefined>(() => {
    if (!props.value) return undefined;
    const d = new Date(props.value);
    return Number.isFinite(d.getTime()) ? d : undefined;
  });

  const timePart = createMemo(() => {
    if (!props.value) return "09:00";
    const idx = props.value.indexOf("T");
    if (idx >= 0 && props.value.length >= idx + 6) {
      return props.value.slice(idx + 1, idx + 6);
    }
    const d = parsedDate();
    return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "09:00";
  });

  const handleDateChange = (nextDate: Date | undefined) => {
    if (!nextDate) {
      props.onChange("");
      return;
    }
    props.onChange(`${formatIsoDatePart(nextDate)}T${timePart()}`);
  };

  const handleTimeChange = (nextTime: string) => {
    const baseDate = parsedDate() ?? new Date();
    props.onChange(`${formatIsoDatePart(baseDate)}T${nextTime}`);
  };

  return (
    <div class={`ui-datetime-picker ${props.class ?? ""}`}>
      <Show when={props.label}>
        <span class="ui-label">{props.label}</span>
      </Show>
      <div class="ui-datetime-picker-row">
        <DatePicker
          value={parsedDate()}
          onChange={handleDateChange}
          placeholder={props.placeholder ?? "Select date"}
          minDate={props.minDate}
          maxDate={props.maxDate}
          disabled={props.disabled}
          ariaLabel={props.ariaLabel ? `${props.ariaLabel} date` : "Expiration date"}
          class="flex-1 min-w-0"
        />
        <TimePicker
          value={timePart()}
          onChange={handleTimeChange}
          minuteStep={props.minuteStep ?? 15}
          format={props.format ?? "24h"}
          disabled={props.disabled}
          ariaLabel={props.ariaLabel ? `${props.ariaLabel} time` : "Expiration time"}
          class="w-36 shrink-0"
        />
      </div>
    </div>
  );
}
