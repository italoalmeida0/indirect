import { Show } from "solid-js";
import type { UsageHistoryDto } from "./api";

const time = (value: number) => `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const bounds = (history: UsageHistoryDto) => `${history.effective.from === null ? "All history" : time(history.effective.from)} to ${time(history.effective.to)}`;

/** Archived events have daily, rather than millisecond, resolution. */
export function AnalyticsHistoryNotice(props: { history?: UsageHistoryDto | null; previous?: UsageHistoryDto | null }) {
  return <Show when={props.history?.adjusted || props.previous?.adjusted}>
    <p class="text-xs text-ink-500 mb-3" role="status">
      Older activity is retained by UTC day.
      <Show when={props.history?.adjusted && props.history}>{(history) => <> This range includes complete boundary days: {bounds(history())}.</>}</Show>
      <Show when={props.previous?.adjusted && props.previous}>{(history) => <> The comparison includes complete boundary days: {bounds(history())}.</>}</Show>
    </p>
  </Show>;
}

export function EventRetentionNotice(props: { history?: UsageHistoryDto | null }) {
  return <Show when={props.history?.rawFrom}>{(rawFrom) =>
    <p class="text-xs text-ink-500 px-5 pt-3">Individual requests are retained from {time(rawFrom())}. Older totals remain available in the charts.</p>
  }</Show>;
}
