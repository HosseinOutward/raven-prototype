//! Frame-rate pacing for video paths that receive frames faster than they should pass them on.
//!
//! The naive gate ("forward when at least one interval has passed since the last forwarded
//! frame") loses frames whenever the source rate is close to a multiple of the target: at
//! 60 Hz with a 30 fps target, a frame that arrives 0.1 ms early is dropped and the next one
//! comes a whole source period later, so the output lands well under the target. A
//! [`FramePacer`] instead keeps a deadline that advances by exactly one interval per
//! accepted frame and accepts a frame that arrives slightly early. The long-run rate is the
//! target (or the source rate, if that is lower), and a stall never causes a burst.

use std::time::{Duration, Instant};

/// How early a frame may arrive and still count for its deadline, as a fraction of the
/// target interval. Capture sources run at a steady display or sensor rate, so a quarter of
/// an interval absorbs their jitter without ever accepting the frame one source period
/// before the deadline (the source would have to run at more than 4× the target).
pub const CAPTURE_TOLERANCE: f64 = 0.25;

/// Decoded frames arrive with network jitter on top of the sender's own pacing, so the
/// display gate accepts frames up to a third of an interval early.
pub const DISPLAY_TOLERANCE: f64 = 1.0 / 3.0;

#[derive(Debug, Default)]
pub struct FramePacer {
    next_due: Option<Instant>,
}

impl FramePacer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The interval for a frame rate; non-positive or non-finite rates count as 1 fps.
    pub fn interval_for(fps: f64) -> Duration {
        let fps = if fps.is_finite() { fps.max(1.0) } else { 1.0 };
        Duration::from_secs_f64(1.0 / fps)
    }

    /// Whether a frame arriving at `now` is due. Does not consume the deadline.
    pub fn is_due(&self, now: Instant, interval: Duration, tolerance: f64) -> bool {
        match self.next_due {
            None => true,
            Some(due) => now + interval.mul_f64(tolerance) >= due,
        }
    }

    /// Record that the frame arriving at `now` was accepted and move the deadline on.
    ///
    /// The deadline advances by one interval from the previous deadline, so early and late
    /// arrivals average out and the long-run rate is exactly the target. If the frame came
    /// more than a whole interval after its deadline (a still screen, a network gap), the
    /// schedule restarts from `now` instead, so the pacer resumes at the target rate rather
    /// than catching up with a burst.
    pub fn accept(&mut self, now: Instant, interval: Duration) {
        self.next_due = Some(match self.next_due {
            Some(due) if now <= due + interval => due + interval,
            _ => now + interval,
        });
    }

    /// [`is_due`](Self::is_due) followed by [`accept`](Self::accept) when it is.
    pub fn admit(&mut self, now: Instant, interval: Duration, tolerance: f64) -> bool {
        if !self.is_due(now, interval, tolerance) {
            return false;
        }
        self.accept(now, interval);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic ±`jitter_ms` noise so a failing case reproduces.
    struct Jitter(u64);

    impl Jitter {
        fn next_ms(&mut self, jitter_ms: f64) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let unit = (self.0 >> 11) as f64 / (1_u64 << 53) as f64;
            (unit * 2.0 - 1.0) * jitter_ms
        }
    }

    struct Outcome {
        fps: f64,
        min_gap_ms: f64,
        max_gap_ms: f64,
        busiest_second: usize,
    }

    /// Feed `seconds` of frames from a `source_hz` source with ±`jitter_ms` arrival jitter
    /// through a pacer and measure what comes out.
    fn simulate(
        source_hz: f64,
        jitter_ms: f64,
        target_fps: f64,
        tolerance: f64,
        seconds: f64,
    ) -> Outcome {
        let start = Instant::now();
        let interval = FramePacer::interval_for(target_fps);
        let period_ms = 1_000.0 / source_hz;
        let mut jitter = Jitter(0x5eed);
        let mut pacer = FramePacer::new();
        let mut accepted = Vec::new();
        let frames = (seconds * source_hz) as usize;
        // Start a few periods in so negative jitter never lands before `start`.
        for index in 0..frames {
            let at_ms = 10.0 + index as f64 * period_ms + jitter.next_ms(jitter_ms);
            let now = start + Duration::from_secs_f64(at_ms / 1_000.0);
            if pacer.admit(now, interval, tolerance) {
                accepted.push(at_ms);
            }
        }
        let gaps: Vec<f64> = accepted.windows(2).map(|pair| pair[1] - pair[0]).collect();
        Outcome {
            fps: accepted.len() as f64 / seconds,
            min_gap_ms: gaps.iter().copied().fold(f64::INFINITY, f64::min),
            max_gap_ms: gaps.iter().copied().fold(0.0, f64::max),
            busiest_second: accepted
                .iter()
                .enumerate()
                .map(|(index, start)| {
                    accepted[index..]
                        .iter()
                        .take_while(|at| **at < start + 1_000.0)
                        .count()
                })
                .max()
                .unwrap_or(0),
        }
    }

    /// The old gate, kept here only to show what the pacer fixes.
    fn simulate_elapsed_gate(source_hz: f64, jitter_ms: f64, target_fps: f64, seconds: f64) -> f64 {
        let interval_ms = 1_000.0 / target_fps;
        let period_ms = 1_000.0 / source_hz;
        let mut jitter = Jitter(0x5eed);
        let mut last: Option<f64> = None;
        let mut count = 0;
        for index in 0..(seconds * source_hz) as usize {
            let at_ms = 10.0 + index as f64 * period_ms + jitter.next_ms(jitter_ms);
            if last
                .map(|previous| at_ms - previous >= interval_ms)
                .unwrap_or(true)
            {
                last = Some(at_ms);
                count += 1;
            }
        }
        count as f64 / seconds
    }

    #[test]
    fn capture_pacing_hits_the_target_from_60_and_144_hz_sources_with_jitter() {
        for source_hz in [60.0, 144.0] {
            for target in [15.0, 30.0, 60.0] {
                let outcome = simulate(source_hz, 2.0, target, CAPTURE_TOLERANCE, 20.0);
                let expected = f64::min(target, source_hz);
                assert!(
                    (outcome.fps - expected).abs() <= expected * 0.02,
                    "{source_hz} Hz → {target} fps produced {:.2} fps",
                    outcome.fps
                );
            }
        }
    }

    #[test]
    fn the_old_elapsed_gate_lost_frames_where_the_pacer_does_not() {
        // 60 Hz with a 30 fps target and ±2 ms jitter: about a third of output lost.
        let old = simulate_elapsed_gate(60.0, 2.0, 30.0, 20.0);
        assert!(old < 25.0, "elapsed gate produced {old:.2} fps");
        // At 60 fps on a 60 Hz display, half the frames are lost.
        let old = simulate_elapsed_gate(60.0, 2.0, 60.0, 20.0);
        assert!(old < 40.0, "elapsed gate produced {old:.2} fps");
    }

    #[test]
    fn no_one_second_window_exceeds_the_target() {
        for source_hz in [60.0, 144.0, 240.0] {
            for target in [15.0, 30.0, 60.0] {
                let outcome = simulate(source_hz, 2.0, target, CAPTURE_TOLERANCE, 10.0);
                assert!(
                    outcome.busiest_second <= target as usize + 1,
                    "{source_hz} Hz → {target} fps had {} frames in one second",
                    outcome.busiest_second
                );
            }
        }
    }

    #[test]
    fn a_30_fps_target_on_a_60_hz_source_keeps_frames_evenly_spaced() {
        let outcome = simulate(60.0, 2.0, 30.0, CAPTURE_TOLERANCE, 10.0);
        // Every accepted frame is one of every two source frames: 33 ms ± jitter.
        assert!(
            outcome.min_gap_ms > 28.0,
            "min gap {:.2}",
            outcome.min_gap_ms
        );
        assert!(
            outcome.max_gap_ms < 38.0,
            "max gap {:.2}",
            outcome.max_gap_ms
        );
    }

    #[test]
    fn a_stall_does_not_cause_a_burst_afterwards() {
        let start = Instant::now();
        let interval = FramePacer::interval_for(30.0);
        let mut pacer = FramePacer::new();
        assert!(pacer.admit(start, interval, CAPTURE_TOLERANCE));
        // Nothing for a second (a still screen), then frames at 60 Hz again.
        let resume = start + Duration::from_secs(1);
        let accepted = (0..6)
            .filter(|index| {
                let now = resume + Duration::from_secs_f64(*index as f64 / 60.0);
                pacer.admit(now, interval, CAPTURE_TOLERANCE)
            })
            .count();
        // 100 ms at 30 fps is three frames, not six.
        assert_eq!(accepted, 3);
    }

    #[test]
    fn display_pacing_keeps_every_frame_that_arrives_at_the_cap_with_network_jitter() {
        // A 30 fps share shown with a 30 fps cap, ±8 ms network jitter.
        for jitter_ms in [8.0, 15.0] {
            let outcome = simulate(30.0, jitter_ms, 30.0, DISPLAY_TOLERANCE, 20.0);
            assert!(
                outcome.fps >= 29.5,
                "±{jitter_ms} ms kept {:.2} fps",
                outcome.fps
            );
        }
        // A 60 fps share shown with a 30 fps cap is halved, not slowed further.
        let outcome = simulate(60.0, 4.0, 30.0, DISPLAY_TOLERANCE, 20.0);
        assert!(
            (outcome.fps - 30.0).abs() <= 0.6,
            "kept {:.2} fps",
            outcome.fps
        );
    }

    #[test]
    fn a_source_slower_than_the_target_is_passed_through() {
        let outcome = simulate(24.0, 2.0, 60.0, CAPTURE_TOLERANCE, 10.0);
        assert!(
            (outcome.fps - 24.0).abs() < 0.2,
            "kept {:.2} fps",
            outcome.fps
        );
    }
}
