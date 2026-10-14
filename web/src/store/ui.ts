import { create } from "zustand";
import type { ServerView } from "@/api/types";

/** 全局对话框开关（顶栏、侧栏、首页都可以打开） */
interface UIState {
  add: boolean;
  edit: ServerView | null;
  paste: boolean;
  pasteText: string;
  exportAll: boolean;
  prefs: boolean;
}

export const useUI = create<UIState>(() => ({
  add: false,
  edit: null,
  paste: false,
  pasteText: "",
  exportAll: false,
  prefs: false,
}));

export const ui = {
  openAdd: () => useUI.setState({ add: true, edit: null }),
  openEdit: (s: ServerView) => useUI.setState({ add: true, edit: s }),
  closeAdd: () => useUI.setState({ add: false }),
  openPaste: (text = "") => useUI.setState({ paste: true, pasteText: text }),
  closePaste: () => useUI.setState({ paste: false }),
  setExportAll: (v: boolean) => useUI.setState({ exportAll: v }),
  setPrefs: (v: boolean) => useUI.setState({ prefs: v }),
};
