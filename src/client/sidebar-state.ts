const SIDEBAR_KEY = "kangentix.sidebarCollapsed";

export function readSidebarCollapsed(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return (storage ?? sessionStorage).getItem(SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
}
export function saveSidebarCollapsed(collapsed: boolean, storage?: Pick<Storage, "setItem">) {
  try {
    (storage ?? sessionStorage).setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // The sidebar remains usable when browser session storage is unavailable.
  }
}
