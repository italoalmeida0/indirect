import {
  createEffect,
  createMemo,
  createSignal,
   createUniqueId,
  For,
  Index,
  on,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import { animate } from "../motion/animate";
import { press } from "../motion/press";
import { reducedMotion } from "../motion/reduced";
import { motionTokens, type SpringTransition } from "../motion/tokens";
import { Glyph } from "./icon";

export type CalendarDateMatcher = (date: Date) => boolean;

export interface CalendarProps {
  value?: Date;
  onChange?: (date: Date) => void;
  month?: Date;
  onMonthChange?: (month: Date) => void;
  minDate?: Date;
  maxDate?: Date;
  disabledDates?: CalendarDateMatcher;
  locale?: string;
  class?: string;
  /** Adds a Today button that slides back to the current month and selects today when available. */
  showToday?: boolean;
}

const DAY_MS = 86_400_000;
export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
export const monthEnd = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);
export const sameDay = (a?: Date | null, b?: Date | null) =>
  Boolean(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
export const sameMonth = (a?: Date | null, b?: Date | null) =>
  Boolean(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth());
export const addDays = (date: Date, amount: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
export const addMonths = (date: Date, amount: number) =>
  new Date(date.getFullYear(), date.getMonth() + amount, 1);
export const shiftMonths = (date: Date, amount: number) =>
  new Date(
    date.getFullYear(),
    date.getMonth() + amount,
    Math.min(date.getDate(), new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate()),
  );
export const dayDiff = (a: Date, b: Date) =>
  Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS);
export const monthDiff = (a: Date, b: Date) =>
  (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth();
export const isBeforeDay = (a: Date, b?: Date) =>
  Boolean(b && startOfDay(a).getTime() < startOfDay(b).getTime());
export const isAfterDay = (a: Date, b?: Date) =>
  Boolean(b && startOfDay(a).getTime() > startOfDay(b).getTime());
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const fromDateKey = (key: string) => {
  const [y = 2026, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const makeWeeks = (month: Date, weekStartsOn: 0 | 1 = 0) => {
  const first = monthStart(month);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
  );
};

const STRIP_SPRING: SpringTransition = { type: "spring", visualDuration: 0.36, bounce: 0 };

/**
 * Word-by-word directional rolling text (Arc `Rolling` / `valueRoll`).
 * Words that stay the same hold still; changed words roll vertically in the
 * direction of time with a subtle blur crossfade.
 */
export function RollingText(props: { text: string; direction?: number; class?: string }) {
  const words = createMemo(() => props.text.split(/\s+/).filter(Boolean));
  return (
    <span class={`ui-rolling-text ${props.class ?? ""}`}>
      <span class="ui-rolling-words">
        <Index each={words()}>
          {(word, i) => {
            let el!: HTMLSpanElement;
            createEffect(
              on(
                word,
                () => {
                  if (!el || untrack(reducedMotion)) return;
                  const dir = props.direction ?? 1;
                  animate(
                    el,
                    { opacity: 1, translate: "0px 0px", filter: "blur(0px)" },
                    { duration: 0.26, ease: motionTokens.ease.enter },
                    {
                      from: {
                        opacity: 0.35,
                        translate: `0px ${dir * 0.38}em`,
                        filter: "blur(1.5px)",
                      },
                    },
                  );
                },
                { defer: true },
              ),
            );
            return (
              <>
                {i > 0 ? " " : ""}
                <span class="ui-rolling-word">
                  <span ref={el} class="ui-rolling-word-inner">
                    {word()}
                  </span>
                </span>
              </>
            );
          }}
        </Index>
      </span>
    </span>
  );
}

/**
 * Gliding circular selection disc for a single-date Calendar month pane.
 * Placed by (col, row) so it glides on a straight line between any two days.
 */
function SelectionDisc(props: { cell: number }) {
  let lastCol = 0;
  let lastRow = 0;

  const style = createMemo(() => {
    const cell = props.cell;
    if (cell >= 0) {
      lastCol = cell % 7;
      lastRow = Math.floor(cell / 7);
      return {
        transform: `translate(calc(${lastCol} * (100% + 4px)), calc(${lastRow} * (100% + 4px))) scale(1)`,
        opacity: "1",
      };
    }
    return {
      transform: `translate(calc(${lastCol} * (100% + 4px)), calc(${lastRow} * (100% + 4px))) scale(0.6)`,
      opacity: "0",
    };
  });

  return (
    <span class="ui-calendar-highlight" aria-hidden="true" style={style()}>
      <span class="ui-calendar-highlight-fill" />
    </span>
  );
}

export function Calendar(props: CalendarProps) {
  const titleId = createUniqueId();
  const today = startOfDay(new Date());
  const locale = () => props.locale ?? "en-US";
  const [internalMonth, setInternalMonth] = createSignal(
    monthStart(props.month ?? props.value ?? today),
  );
  const [focusedDate, setFocusedDate] = createSignal<Date | undefined>(props.value);
  const [leavingMonth, setLeavingMonth] = createSignal<Date | null>(null);
  const [direction, setDirection] = createSignal(0);

  let viewportRef: HTMLDivElement | undefined;
  let stripRef: HTMLDivElement | undefined;
  let titleRef: HTMLSpanElement | undefined;
  let focusRequest: string | null = null;

  const month = createMemo(() =>
    props.month ? monthStart(props.month) : internalMonth(),
  );

  // Sync month changes and animate the horizontal strip + header title
  let prevMonthTime = untrack(() => month().getTime());
  createEffect(() => {
    const current = month();
    const nextTime = current.getTime();
    if (nextTime === prevMonthTime) return;
    const prevDate = new Date(prevMonthTime);
    const dir = nextTime > prevMonthTime ? 1 : -1;
    prevMonthTime = nextTime;
    setDirection(dir);

    if (!untrack(reducedMotion)) {
      setLeavingMonth(prevDate);
      queueMicrotask(() => {
        if (stripRef) {
          animate(
            stripRef,
            { translate: "0% 0px" },
            STRIP_SPRING,
            { from: { translate: `${dir * 105}% 0px` } },
          ).finished.then(() => {
            setLeavingMonth((m) => (m && m.getTime() === prevDate.getTime() ? null : m));
          });
        }
        if (titleRef) {
          animate(
            titleRef,
            { opacity: 1, translate: "0px 0px" },
            { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter },
            { from: { opacity: 0, translate: `${dir * 12}px 0px` } },
          );
        }
      });
    } else {
      setLeavingMonth(null);
    }
  });

  const formatter = createMemo(
    () => new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }),
  );
  const weekdayFormatter = createMemo(
    () => new Intl.DateTimeFormat(locale(), { weekday: "short" }),
  );
  const weekdays = createMemo(() =>
    Array.from({ length: 7 }, (_, i) => weekdayFormatter().format(new Date(2024, 0, 7 + i)).slice(0, 2)),
  );
  const monthLabel = createMemo(() => formatter().format(month()));

  // Distance-aware number color flip delay as SelectionDisc glides across days
  const [handoff, setHandoff] = createSignal({ from: "", to: "", distance: 0 });
  let lastValueKey = untrack(() => (props.value ? dateKey(props.value) : ""));
  let lastValueDate = untrack(() => props.value);
  createEffect(() => {
    const val = props.value;
    const key = val ? dateKey(val) : "";
    if (key !== lastValueKey) {
      const days = lastValueDate && val ? dayDiff(val, lastValueDate) : 0;
      const cols = lastValueDate && val ? val.getDay() - lastValueDate.getDay() : 0;
      setHandoff({
        from: lastValueKey,
        to: key,
        distance: Math.hypot(cols, (days - cols) / 7),
      });
      lastValueKey = key;
      lastValueDate = val;
    }
  });

  const numberDelay = (key: string): JSX.CSSProperties | undefined => {
    const h = handoff();
    if (!h.distance || reducedMotion() || (key !== h.to && key !== h.from)) return undefined;
    const delay =
      key === h.to
        ? Math.min(260, 95 + 85 * Math.log(h.distance))
        : Math.max(20, 130 / h.distance);
    return { "--number-delay": `${Math.round(delay)}ms` };
  };

  const isDisabled = (date: Date) =>
    isBeforeDay(date, props.minDate) ||
    isAfterDay(date, props.maxDate) ||
    Boolean(props.disabledDates?.(date));

  const previousMonth = createMemo(() => addMonths(month(), -1));
  const nextMonth = createMemo(() => addMonths(month(), 1));
  const previousDisabled = createMemo(() =>
    Boolean(props.minDate && previousMonth().getTime() < monthStart(props.minDate).getTime()),
  );
  const nextDisabled = createMemo(() =>
    Boolean(props.maxDate && nextMonth().getTime() > monthStart(props.maxDate).getTime()),
  );
  const todaySelectable = () => !isDisabled(today) && Boolean(props.onChange);
  const todayIdle = () =>
    sameMonth(month(), today) && (!todaySelectable() || sameDay(props.value, today));

  const weeks = createMemo(() => makeWeeks(month()));
  const tabbableKey = createMemo(() => {
    const m = month();
    const open = (date?: Date) =>
      date && sameMonth(date, m) && !isDisabled(date) ? dateKey(date) : "";
    return (
      open(focusedDate()) ||
      open(props.value) ||
      open(today) ||
      dateKey(
        weeks()
          .flat()
          .find((d) => sameMonth(d, m) && !isDisabled(d)) ?? m,
      )
    );
  });

  const changeMonth = (target: Date) => {
    const normalized = monthStart(target);
    if (!props.month) setInternalMonth(normalized);
    props.onMonthChange?.(normalized);
  };

  const flushFocus = () => {
    if (!focusRequest) return;
    const key = focusRequest;
    queueMicrotask(() => {
      const btn = viewportRef?.querySelector<HTMLButtonElement>(
        `[data-present] [data-date="${key}"]`,
      );
      if (btn) {
        focusRequest = null;
        btn.focus({ preventScroll: true });
      }
    });
  };

  const moveFocus = (from: Date, target: Date, step: number) => {
    let next =
      isBeforeDay(target, props.minDate) && props.minDate
        ? startOfDay(props.minDate)
        : isAfterDay(target, props.maxDate) && props.maxDate
          ? startOfDay(props.maxDate)
          : target;
    for (let tries = 0; tries < 42 && isDisabled(next); tries += 1) {
      next = addDays(next, step);
    }
    if (isDisabled(next) || sameDay(next, from)) return;
    setFocusedDate(next);
    focusRequest = dateKey(next);
    if (!sameMonth(next, month())) changeMonth(next);
    flushFocus();
  };

  const onDayKeyDown = (event: KeyboardEvent, date: Date) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isDisabled(date)) props.onChange?.(date);
      return;
    }
    const moves: Record<string, [Date, number]> = {
      ArrowLeft: [addDays(date, -1), -1],
      ArrowRight: [addDays(date, 1), 1],
      ArrowUp: [addDays(date, -7), -1],
      ArrowDown: [addDays(date, 7), 1],
      Home: [addDays(date, -date.getDay()), 1],
      End: [addDays(date, 6 - date.getDay()), -1],
      PageUp: [shiftMonths(date, event.shiftKey ? -12 : -1), -1],
      PageDown: [shiftMonths(date, event.shiftKey ? 12 : 1), 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    moveFocus(date, move[0], move[1]);
  };

  const goToToday = () => {
    if (todayIdle()) return;
    setFocusedDate(today);
    if (!sameMonth(today, month())) changeMonth(today);
    if (todaySelectable() && !sameDay(props.value, today)) props.onChange?.(today);
  };

  const cellOf = (paneMonth: Date) => {
    const val = props.value;
    if (!val) return -1;
    const first = addDays(paneMonth, -paneMonth.getDay());
    const index = dayDiff(val, first);
    return index >= 0 && index < 42 ? index : -1;
  };

  const renderMonth = (paneMonth: Date, present: boolean) => {
    const paneWeeks = createMemo(() => makeWeeks(paneMonth));
    return (
      <>
        <SelectionDisc cell={cellOf(paneMonth)} />
        <div class="ui-calendar-grid" role="grid" aria-label={formatter().format(paneMonth)}>
          <For each={paneWeeks()}>
            {(week) => (
              <div class="ui-calendar-week" role="row">
                <For each={week}>
                  {(date) => {
                    const key = dateKey(date);
                    const selected = () => sameDay(date, props.value);
                    const isToday = sameDay(date, today);
                    const outside = !sameMonth(date, paneMonth);
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        data-date={key}
                        data-calendar-date={key}
                        aria-label={date.toLocaleDateString(locale(), { dateStyle: "full" })}
                        aria-selected={selected()}
                        aria-current={isToday ? "date" : undefined}
                        tabIndex={present && key === tabbableKey() ? 0 : -1}
                        disabled={isDisabled(date)}
                        style={present ? numberDelay(key) : undefined}
                        class={`ui-calendar-day ${outside ? "is-outside" : ""} ${selected() ? "is-selected" : ""} ${isToday ? "is-today" : ""}`}
                        onFocus={() => setFocusedDate(date)}
                        onKeyDown={(e) => onDayKeyDown(e, date)}
                        onClick={() => props.onChange?.(date)}
                      >
                        <span class="ui-calendar-day-num">{date.getDate()}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </>
    );
  };

  return (
    <section class={`ui-calendar ${props.class ?? ""}`} aria-labelledby={titleId}>
      <div class="ui-calendar-header">
        <h2 id={titleId} class="ui-calendar-heading">
          <span class="sr-only">{monthLabel()}</span>
          <span class="ui-calendar-title" aria-hidden="true">
            <span ref={titleRef} class="ui-calendar-title-row">
              {monthLabel()}
            </span>
          </span>
        </h2>
        <span class="sr-only" aria-live="polite">
          {direction() ? monthLabel() : ""}
        </span>
        <div class="ui-calendar-nav">
          <Show when={props.showToday}>
            <button
              type="button"
              class="ui-calendar-today-btn"
              aria-disabled={todayIdle() || undefined}
              aria-label={`Today, ${today.toLocaleDateString(locale(), { dateStyle: "full" })}`}
              onPointerDown={(e) => {
                if (!todayIdle()) press(e.currentTarget);
              }}
              onClick={goToToday}
            >
              Today
            </button>
          </Show>
          <button
            type="button"
            class="ui-calendar-nav-btn"
            aria-label="Previous month"
            data-tip="Previous month"
            aria-disabled={previousDisabled() || undefined}
            onPointerDown={(e) => {
              if (!previousDisabled()) press(e.currentTarget);
            }}
            onClick={() => {
              if (!previousDisabled()) changeMonth(previousMonth());
            }}
          >
            <Glyph icon="lucide:chevron-left" size={16} />
          </button>
          <button
            type="button"
            class="ui-calendar-nav-btn"
            aria-label="Next month"
            data-tip="Next month"
            aria-disabled={nextDisabled() || undefined}
            onPointerDown={(e) => {
              if (!nextDisabled()) press(e.currentTarget);
            }}
            onClick={() => {
              if (!nextDisabled()) changeMonth(nextMonth());
            }}
          >
            <Glyph icon="lucide:chevron-right" size={16} />
          </button>
        </div>
      </div>

      <div class="ui-calendar-weekdays" aria-hidden="true">
        <For each={weekdays()}>{(day) => <span>{day}</span>}</For>
      </div>

      <div ref={viewportRef} class="ui-calendar-viewport">
        <div ref={stripRef} class="ui-calendar-strip">
          <Show when={leavingMonth()}>
            {(leaving) => (
              <div
                class="ui-calendar-pane is-leaving"
                style={{ translate: `${-direction() * 105}% 0px` }}
                aria-hidden="true"
                inert
              >
                {renderMonth(leaving(), false)}
              </div>
            )}
          </Show>
          <div class="ui-calendar-pane" data-present="">
            {renderMonth(month(), true)}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ========================================================================== *
 * RangeCalendar — Arc UI stretching week-by-week bars + gliding endpoint     *
 * thumbs + continuous sliding month strip.                                   *
 * ========================================================================== */

export interface RangeSegment {
  left: number;
  width: number;
  active: boolean;
}

function RangeBar(props: { row: number; segment: RangeSegment | null }) {
  return (
    <span
      class="ui-range-bar"
      style={{
        top: `calc(${props.row} * var(--cell, 38px) + 3px)`,
        left: props.segment
          ? props.segment.active
            ? `calc(${props.segment.left}% + 3px)`
            : `${props.segment.left}%`
          : "0%",
        width: props.segment?.active ? `calc(${props.segment.width}% - 6px)` : "0px",
        opacity: props.segment?.active ? "1" : "0",
      }}
    />
  );
}

function RangeThumb(props: { cell: { row: number; col: number } | null }) {
  let lastCol = 0;
  let lastRow = 0;

  const style = createMemo(() => {
    const cell = props.cell;
    if (cell) {
      lastCol = cell.col;
      lastRow = cell.row;
      return {
        transform: `translate(${cell.col * 100}%, ${cell.row * 100}%) scale(1)`,
        opacity: "1",
      };
    }
    return {
      transform: `translate(${lastCol * 100}%, ${lastRow * 100}%) scale(0.78)`,
      opacity: "0",
    };
  });

  return (
    <span class="ui-range-thumb" style={style()}>
      <span class="ui-range-thumb-fill" />
    </span>
  );
}

export interface RangeCalendarProps {
  /** ISO date or datetime string `YYYY-MM-DD...` */
  from: string;
  /** ISO date or datetime string `YYYY-MM-DD...` */
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  showToday?: boolean;
  class?: string;
}

export function RangeCalendar(props: RangeCalendarProps) {
  const today = startOfDay(new Date());
  const todayKey = dateKey(today);
  const parseInitial = () => {
    const raw = props.from ? new Date(props.from) : today;
    return Number.isFinite(raw.getTime()) ? monthStart(raw) : monthStart(today);
  };
  const [month, setMonth] = createSignal(parseInitial());
  const [leavingMonth, setLeavingMonth] = createSignal<Date | null>(null);
  const [direction, setDirection] = createSignal(0);
  const [choosingEnd, setChoosingEnd] = createSignal(false);
  const [hover, setHover] = createSignal("");

  let stripRef: HTMLDivElement | undefined;
  let titleRef: HTMLSpanElement | undefined;
  let rootRef: HTMLDivElement | undefined;

  const fromDay = () => (props.from ? props.from.slice(0, 10) : todayKey);
  const toDay = () =>
    choosingEnd() && hover() ? hover() : props.to ? props.to.slice(0, 10) : fromDay();
  const startDay = () => (fromDay() <= toDay() ? fromDay() : toDay());
  const endDay = () => (fromDay() <= toDay() ? toDay() : fromDay());

  // Sync external `props.from` edits (e.g. typing in Start date and time input)
  let lastExternalFrom = untrack(fromDay);
  createEffect(() => {
    const raw = props.from;
    const day = raw ? raw.slice(0, 10) : "";
    if (!day || day === lastExternalFrom) return;
    lastExternalFrom = day;
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) {
      const target = monthStart(parsed);
      if (!sameMonth(target, untrack(month))) {
        setLeavingMonth(null);
        setMonth(target);
      }
    }
  });

  const moveMonthTo = (target: Date) => {
    const prev = untrack(month);
    const delta = monthDiff(target, prev);
    if (!delta) return;
    const dir = Math.sign(delta);
    setDirection(dir);
    setMonth(target);
    if (!untrack(reducedMotion)) {
      setLeavingMonth(prev);
      queueMicrotask(() => {
        if (stripRef) {
          animate(
            stripRef,
            { translate: "0% 0px" },
            STRIP_SPRING,
            { from: { translate: `${dir * 105}% 0px` } },
          ).finished.then(() => {
            setLeavingMonth((m) => (m && m.getTime() === prev.getTime() ? null : m));
          });
        }
        if (titleRef) {
          animate(
            titleRef,
            { opacity: 1, translate: "0px 0px" },
            { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter },
            { from: { opacity: 0, translate: `${dir * 12}px 0px` } },
          );
        }
      });
    } else {
      setLeavingMonth(null);
    }
  };

  const move = (amount: number) => {
    const cur = month();
    moveMonthTo(new Date(cur.getFullYear(), cur.getMonth() + amount, 1));
  };

  const goToToday = () => {
    moveMonthTo(monthStart(today));
    select(todayKey);
  };

  const select = (day: string) => {
    const fromTimePart = props.from.includes("T") ? props.from.slice(11, 16) || "00:00" : "00:00";
    const toTimePart = props.to.includes("T") ? props.to.slice(11, 16) || "23:59" : "23:59";
    if (!choosingEnd()) {
      lastExternalFrom = day;
      props.setFrom(`${day}T${fromTimePart}`);
      props.setTo(`${day}T${toTimePart}`);
      setChoosingEnd(true);
      setHover(day);
    } else {
      const start = fromDay();
      const lo = day < start ? day : start;
      const hi = day < start ? start : day;
      lastExternalFrom = lo;
      props.setFrom(`${lo}T${fromTimePart}`);
      props.setTo(`${hi}T${toTimePart}`);
      setChoosingEnd(false);
      setHover("");
    }
  };

  const navigate = (event: KeyboardEvent, date: Date) => {
    const amounts: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -date.getDay(),
      End: 6 - date.getDay(),
    };
    if (!(event.key in amounts) && event.key !== "PageUp" && event.key !== "PageDown") return;
    event.preventDefault();
    event.stopPropagation();
    const next = new Date(date);
    if (event.key === "PageUp" || event.key === "PageDown") {
      next.setMonth(next.getMonth() + (event.key === "PageUp" ? -1 : 1));
    } else {
      next.setDate(next.getDate() + amounts[event.key]!);
    }
    const nextKey = dateKey(next);
    if (choosingEnd()) setHover(nextKey);
    if (!sameMonth(next, month())) {
      moveMonthTo(monthStart(next));
    }
    requestAnimationFrame(() =>
      rootRef
        ?.querySelector<HTMLButtonElement>(`[data-present] [data-calendar-date="${nextKey}"]`)
        ?.focus({ preventScroll: true }),
    );
  };

  // Range summary & direction for RollingText
  const summaryDirection = (() => {
    let prevScore = 0;
    return createMemo(() => {
      const s = fromDateKey(startDay()).getTime();
      const e = fromDateKey(endDay()).getTime();
      const score = s * 2 + e;
      const dir = score >= prevScore ? 1 : -1;
      prevScore = score;
      return dir;
    });
  })();

  const dayCount = createMemo(() => {
    const s = fromDateKey(startDay());
    const e = fromDateKey(endDay());
    return Math.max(1, dayDiff(e, s) + 1);
  });

  const formattedRangeText = createMemo(() => {
    const s = fromDateKey(startDay());
    const e = fromDateKey(endDay());
    const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
    return sameDay(s, e) ? fmt.format(s) : `${fmt.format(s)} – ${fmt.format(e)}`;
  });

  const renderMonthPane = (paneMonth: Date, present: boolean) => {
    const rows = createMemo(() => makeWeeks(paneMonth, 0));
    const firstDay = createMemo(() => rows()[0]![0]!);

    const segments = createMemo<Array<RangeSegment | null>>(() => {
      const loStr = startDay();
      const hiStr = endDay();
      if (!loStr || !hiStr) return rows().map(() => null);
      const start = fromDateKey(loStr);
      const end = fromDateKey(hiStr);
      const unit = 100 / 7;
      const singleDay = loStr === hiStr;
      return rows().map((row) => {
        const rowFirst = row[0]!;
        const rowLast = row[6]!;
        const from = dayDiff(start, rowFirst) > 0 ? start : rowFirst;
        const to = dayDiff(end, rowLast) < 0 ? end : rowLast;
        const colOf = (d: Date) => dayDiff(d, rowFirst);
        if (dayDiff(from, to) <= 0) {
          const a = colOf(from);
          const b = colOf(to);
          if (singleDay) {
            return { left: (a + 0.5) * unit, width: 0, active: false };
          }
          return { left: a * unit, width: (b - a + 1) * unit, active: true };
        }
        if (dayDiff(rowLast, start) < 0) {
          return { left: 100, width: 0, active: false };
        }
        return { left: 0, width: 0, active: false };
      });
    });

    const startCell = createMemo(() => {
      const lo = fromDateKey(startDay());
      const idx = dayDiff(lo, firstDay());
      return idx >= 0 && idx < 42 ? { row: Math.floor(idx / 7), col: idx % 7 } : null;
    });

    const endCell = createMemo(() => {
      const loStr = startDay();
      const hiStr = endDay();
      if (!hiStr || hiStr === loStr) return null;
      const hi = fromDateKey(hiStr);
      const idx = dayDiff(hi, firstDay());
      return idx >= 0 && idx < 42 ? { row: Math.floor(idx / 7), col: idx % 7 } : null;
    });

    const monthStartKey = () => dateKey(paneMonth);
    const activeTabKey = () =>
      fromDay().slice(0, 7) === monthStartKey().slice(0, 7) ? fromDay() : monthStartKey();

    return (
      <div class="ui-range-month">
        <span class="ui-range-layer" aria-hidden="true">
          <Index each={segments()}>
            {(segment, rowIdx) => <RangeBar row={rowIdx} segment={segment()} />}
          </Index>
          <RangeThumb cell={startCell()} />
          <RangeThumb cell={endCell()} />
        </span>
        <div
          class="analytics-calendar-grid ui-range-grid"
          role="group"
          aria-label="Choose start and end dates"
          onPointerLeave={() => {
            if (choosingEnd()) setHover("");
          }}
        >
          <For each={rows().flat()}>
            {(date) => {
              const key = dateKey(date);
              const isStart = () => key === startDay();
              const isEnd = () => key === endDay();
              const selected = () => isStart() || isEnd();
              const between = () => key > startDay() && key < endDay();
              const hasSpan = () => startDay() !== endDay();
              const outside = date.getMonth() !== paneMonth.getMonth();
              return (
                <button
                  type="button"
                  data-calendar-date={present ? key : undefined}
                  data-date={key}
                  data-edge={selected() || undefined}
                  data-range={selected() || between() || undefined}
                  data-today={key === todayKey || undefined}
                  aria-label={date.toLocaleDateString("en", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  aria-pressed={selected()}
                  tabIndex={present && key === activeTabKey() ? 0 : -1}
                  class={`analytics-day ui-range-day ${outside ? "is-outside" : ""} ${selected() ? "is-selected" : between() ? "is-between" : ""} ${hasSpan() && isStart() ? "is-range-start" : ""} ${hasSpan() && isEnd() ? "is-range-end" : ""} ${key === todayKey ? "is-today" : ""}`}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => select(key)}
                  onPointerEnter={() => {
                    if (choosingEnd()) setHover(key);
                  }}
                  onKeyDown={(event) => navigate(event, date)}
                >
                  <span class="ui-range-day-num">{date.getDate()}</span>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    );
  };

  return (
    <div ref={rootRef} class={`analytics-calendar ui-range-calendar ${props.class ?? ""}`}>
      <div class="analytics-calendar-heading">
        <button
          type="button"
          aria-label="Previous month"
          data-tip="Previous month"
          class="analytics-icon-button"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => move(-1)}
        >
          <Glyph icon="lucide:chevron-left" size={16} />
        </button>
        <span class="analytics-calendar-title" aria-live="polite">
          <span ref={titleRef} class="ui-calendar-title-row">
            {month().toLocaleDateString("en", { month: "long", year: "numeric" })}
          </span>
        </span>
        <div class="inline-flex items-center gap-1">
          <Show when={props.showToday !== false}>
            <button
              type="button"
              class="ui-calendar-today-btn"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={goToToday}
            >
              Today
            </button>
          </Show>
          <button
            type="button"
            aria-label="Next month"
            data-tip="Next month"
            class="analytics-icon-button"
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => move(1)}
          >
            <Glyph icon="lucide:chevron-right" size={16} />
          </button>
        </div>
      </div>

      <div class="ui-range-weekdays" aria-hidden="true">
        <For each={["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]}>
          {(day) => <span class="analytics-weekday">{day}</span>}
        </For>
      </div>

      <div class="ui-calendar-viewport">
        <div ref={stripRef} class="ui-calendar-strip">
          <Show when={leavingMonth()}>
            {(leaving) => (
              <div
                class="ui-calendar-pane is-leaving"
                style={{ translate: `${-direction() * 105}% 0px` }}
                aria-hidden="true"
                inert
              >
                {renderMonthPane(leaving(), false)}
              </div>
            )}
          </Show>
          <div class="ui-calendar-pane" data-present="">
            {renderMonthPane(month(), true)}
          </div>
        </div>
      </div>

      <div class="ui-range-summary" aria-live="polite">
        <span class="ui-range-summary-dates">
          <RollingText text={formattedRangeText()} direction={summaryDirection()} />
        </span>
        <span class="ui-range-summary-badge">
          <RollingText
            text={
              choosingEnd()
                ? "Pick an end date"
                : `${dayCount()} ${dayCount() === 1 ? "day" : "days"}`
            }
            direction={summaryDirection()}
          />
        </span>
      </div>
    </div>
  );
}
