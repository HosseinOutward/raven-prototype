//! Picture-in-picture windows keep the shape of their picture while being resized. Tauri
//! has no option for this, so on Windows the sizing rectangle is corrected as it is dragged.
//! Elsewhere `lib/pictureInPicture.ts` corrects the size once the drag settles.

/// Sets the shape the calling window keeps while it is being resized.
#[tauri::command]
pub fn window_lock_aspect(window: tauri::WebviewWindow, aspect: f64) -> Result<(), String> {
    if !aspect.is_finite() || aspect <= 0.0 {
        return Err("aspect must be a positive number".to_string());
    }
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        window
            .run_on_main_thread(move || platform::lock(hwnd, aspect))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

#[cfg(any(windows, test))]
mod sizing {
    /// The minimum in `lib/pictureInPicture.ts`, in logical pixels.
    pub const MIN_WIDTH: f64 = 240.0;
    pub const MIN_HEIGHT: f64 = 135.0;

    // WM_SIZING's WMSZ_* edge values.
    pub const LEFT: u32 = 1;
    pub const RIGHT: u32 = 2;
    pub const TOP: u32 = 3;
    pub const TOP_LEFT: u32 = 4;
    pub const TOP_RIGHT: u32 = 5;
    pub const BOTTOM: u32 = 6;
    pub const BOTTOM_LEFT: u32 = 7;
    #[cfg(test)]
    pub const BOTTOM_RIGHT: u32 = 8;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Bounds {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    /// The window bounds a drag should produce so the client area is `aspect` wide per unit
    /// of height. An edge drags the side it holds; a corner follows the axis moved furthest.
    /// The edge opposite the drag stays put. `frame` is window size minus client size.
    pub fn constrain(
        proposed: Bounds,
        client: (i32, i32),
        frame: (i32, i32),
        edge: u32,
        aspect: f64,
        scale: f64,
    ) -> Bounds {
        let width = f64::from(proposed.right - proposed.left - frame.0).max(1.0);
        let height = f64::from(proposed.bottom - proposed.top - frame.1).max(1.0);
        let follow_width = match edge {
            LEFT | RIGHT => true,
            TOP | BOTTOM => false,
            _ => {
                (width - f64::from(client.0)).abs() / f64::from(client.0.max(1))
                    >= (height - f64::from(client.1)).abs() / f64::from(client.1.max(1))
            }
        };
        let (width, height) = if follow_width {
            (width, width / aspect)
        } else {
            (height * aspect, height)
        };
        // Below the minimum Windows clamps each axis alone, which would break the shape.
        let grow = (MIN_WIDTH * scale / width)
            .max(MIN_HEIGHT * scale / height)
            .max(1.0);
        let window_width = (width * grow).round() as i32 + frame.0;
        let window_height = (height * grow).round() as i32 + frame.1;

        let mut bounds = proposed;
        if matches!(edge, LEFT | TOP_LEFT | BOTTOM_LEFT) {
            bounds.left = proposed.right - window_width;
        } else {
            bounds.right = proposed.left + window_width;
        }
        if matches!(edge, TOP | TOP_LEFT | TOP_RIGHT) {
            bounds.top = proposed.bottom - window_height;
        } else {
            bounds.bottom = proposed.top + window_height;
        }
        bounds
    }
}

#[cfg(windows)]
mod platform {
    use super::sizing::{constrain, Bounds};
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        UI::{
            HiDpi::GetDpiForWindow,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{GetClientRect, GetWindowRect, WM_NCDESTROY, WM_SIZING},
        },
    };

    const SUBCLASS_ID: usize = 0x5049_5041;
    /// The subclass's reference value holds the aspect as a fixed-point number, so changing
    /// it is one more `SetWindowSubclass` and there is nothing to free.
    const ASPECT_UNIT: f64 = 1_000_000.0;

    pub fn lock(hwnd: isize, aspect: f64) {
        let hwnd = HWND(hwnd as *mut _);
        let reference = (aspect * ASPECT_UNIT) as usize;
        // Safety: called on the window's own thread, and the procedure lives for the process.
        let attached =
            unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, reference) };
        if !attached.as_bool() {
            eprintln!("[raven] picture in picture could not lock its shape");
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        reference: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        } else if message == WM_SIZING {
            let mut window = RECT::default();
            let mut client = RECT::default();
            if GetWindowRect(hwnd, &mut window).is_ok() && GetClientRect(hwnd, &mut client).is_ok()
            {
                // Safety: for WM_SIZING, lparam points at the drag rectangle.
                let drag = &mut *(lparam.0 as *mut RECT);
                let client_size = (client.right - client.left, client.bottom - client.top);
                let bounds = constrain(
                    Bounds {
                        left: drag.left,
                        top: drag.top,
                        right: drag.right,
                        bottom: drag.bottom,
                    },
                    client_size,
                    (
                        window.right - window.left - client_size.0,
                        window.bottom - window.top - client_size.1,
                    ),
                    wparam.0 as u32,
                    reference as f64 / ASPECT_UNIT,
                    f64::from(GetDpiForWindow(hwnd)) / 96.0,
                );
                *drag = RECT {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                };
                return LRESULT(1);
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::sizing::*;

    const ASPECT: f64 = 16.0 / 9.0;

    fn drag(proposed: Bounds, edge: u32) -> Bounds {
        constrain(proposed, (400, 225), (16, 9), edge, ASPECT, 1.0)
    }

    fn client(bounds: Bounds) -> (i32, i32) {
        (
            bounds.right - bounds.left - 16,
            bounds.bottom - bounds.top - 9,
        )
    }

    #[test]
    fn a_side_edge_sets_the_height_and_keeps_the_top() {
        let bounds = drag(
            Bounds { left: 100, top: 100, right: 916, bottom: 334 },
            RIGHT,
        );
        assert_eq!(bounds.top, 100);
        assert_eq!(client(bounds), (800, 450));
    }

    #[test]
    fn a_top_edge_sets_the_width_and_keeps_the_bottom() {
        let bounds = drag(Bounds { left: 100, top: 0, right: 516, bottom: 459 }, TOP);
        assert_eq!(bounds.bottom, 459);
        assert_eq!(bounds.left, 100);
        assert_eq!(client(bounds), (800, 450));
    }

    #[test]
    fn a_corner_follows_the_axis_moved_furthest_and_keeps_the_far_corner() {
        let bounds = drag(
            Bounds { left: -300, top: 90, right: 516, bottom: 334 },
            TOP_LEFT,
        );
        assert_eq!((bounds.right, bounds.bottom), (516, 334));
        assert_eq!(client(bounds), (800, 450));
    }

    #[test]
    fn shrinking_stops_at_the_minimum_with_the_shape_kept() {
        let bounds = drag(
            Bounds { left: 100, top: 100, right: 130, bottom: 334 },
            BOTTOM_RIGHT,
        );
        assert_eq!(client(bounds), (240, 135));
    }

    #[test]
    fn the_minimum_follows_the_display_scale() {
        let proposed = Bounds { left: 0, top: 0, right: 40, bottom: 40 };
        let bounds = constrain(proposed, (800, 450), (0, 0), BOTTOM_LEFT, ASPECT, 2.0);
        assert_eq!(
            (bounds.right - bounds.left, bounds.bottom - bounds.top),
            (480, 270)
        );
    }
}
