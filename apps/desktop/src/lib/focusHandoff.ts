/**
 * Where focus goes when a floating layer opens or closes. Radix hands focus to the first
 * control inside a popover, and a tooltip opens on focus: a popover whose first control
 * carries a tooltip would show it before anyone pointed at it.
 */

/** For a popover's `onOpenAutoFocus`: focus the panel itself. Tab still reaches the first control. */
export function focusPanelOnOpen(event: Event) {
  event.preventDefault();
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
}
