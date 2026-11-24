import { pushToast } from "../../ds/components/toast";

export type NoticeKind = "ok" | "err";

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Ephemeral floating toast notifier backed by the portaled DS ToastRegion. */
export function createNotice() {
  const appNotice = (): { message: string; kind: NoticeKind } | null => null;
  const setAppNotice = (_next: { message: string; kind: NoticeKind } | null) => {};
  function toast(message: string, kind: NoticeKind = "ok") {
    pushToast(capitalizeFirst(message), kind);
  }
  return { appNotice, setAppNotice, toast };
}

export type Notice = ReturnType<typeof createNotice>;
