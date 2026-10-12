/** Anything can ask the title bar to focus search (for example "Find a tree"). */
export const FOCUS_SEARCH_EVENT = "raven:focus-search";

export function focusGlobalSearch() {
  window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
}
