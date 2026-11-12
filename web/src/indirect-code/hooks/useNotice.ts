import { pushToast } from "../../ds/components/toast";

export type NoticeKind = "ok" | "err";

/** Ephemeral floating toast notifier backed by the portaled DS ToastRegion. */
export function createNotice() {
  const appNotice = (): { message: string; kind: NoticeKind } | null => null;
  const setAppNotice = (_next: { message: string; kind: NoticeKind } | null) => {};
  function toast(message: string, kind: NoticeKind = "ok") {
    pushToast(message, kind);
  }
  return { appNotice, setAppNotice, toast };
}

export type Notice = ReturnType<typeof createNotice>;
