//! Auto-level: moves each incoming microphone's receiver fader so everyone's speech lands
//! at the same loudness, for this listener only.
//!
//! The rule everything here follows is to measure speech, not time. A person who is
//! muted, quiet or typing says nothing about how loud they are, so only windows the
//! speech detector calls speech are counted, and silence leaves the estimate exactly
//! where it was. Otherwise a quiet minute would push someone's fader to the top and the
//! next word would be a shout.
//!
//! This module is pure logic: the mic readers feed it one observation per meter window,
//! the state steps it on a timer and applies the fader moves it returns.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::audio::domain::{AutoLevelStatus, ParticipantId};

/// Where speech should land: K-weighted mean square of speech, in dB relative to full
/// scale (roughly LUFS). Calibrated so a Raven microphone on its default chain needs
/// about 0 dB.
pub const TARGET_DB: f32 = -23.0;
/// The fader range Auto-level may use. Lower than the fader's own floor on purpose:
/// nobody is so loud that they need more than −24 dB, and anything near the floor would
/// mean the estimate was wrong.
pub const MIN_GAIN_DB: f32 = -24.0;
pub const MAX_GAIN_DB: f32 = 12.0;
/// A window counts as speech at the threshold the speaking ring uses.
pub const SPEECH_PROBABILITY: f32 = 0.6;
/// Quieter than this is not speech worth levelling, whatever the detector says.
const ABSOLUTE_GATE_DB: f32 = -60.0;
/// A window this far under someone else's concurrent speech is taken as bleed: the
/// call coming back through this person's speakers into their microphone.
const BLEED_MARGIN_DB: f32 = 20.0;
/// How close in time two windows must be to count as concurrent. Meter windows are
/// 120 ms, and readers are not aligned with each other.
const CONCURRENT_WINDOW: Duration = Duration::from_millis(150);
/// The estimate forgets with this much *speech*, never wall time.
const SPEECH_TIME_CONSTANT_S: f32 = 30.0;
/// How much speech is heard before a person's fader is first moved.
const SPEECH_BEFORE_FIRST_MOVE_S: f32 = 3.0;
/// BS.1770's relative gate: windows this far under the ungated loudness are left out.
const RELATIVE_GATE_DB: f32 = 10.0;
/// The recent speech that is compared with the estimate, to follow a big change fast.
const RECENT_SPEECH_S: f32 = 2.0;
/// When the recent speech is this far from the estimate, the estimate starts over from it.
const RESTART_DIFFERENCE_DB: f32 = 8.0;
/// A fader this close to where it should be is left alone.
const DEADBAND_DB: f32 = 1.5;
/// How fast a fader glides once it moves.
pub const GLIDE_DB_PER_S: f32 = 1.5;

const HISTOGRAM_FLOOR_DB: f32 = -70.0;
const HISTOGRAM_BIN_DB: f32 = 0.5;
/// Bins are centred on the 0.5 dB grid, −70 to 0 inclusive.
const HISTOGRAM_BINS: usize = 141;

/// One biquad section, direct form I, coefficients normalised by a0.
#[derive(Clone, Copy, Debug, Default)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn process(&mut self, input: f64) -> f64 {
        let output = self.b[0] * input + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [input, self.x[0]];
        self.y = [output, self.y[0]];
        output
    }
}

/// Speech loudness of one microphone, the way BS.1770 measures programme loudness: the
/// K-weighting pre-filter (a high shelf for the head, a high-pass for rumble) and then
/// the mean square of a window, in LUFS. Coefficients are derived for the stream's rate
/// so 16, 44.1 and 48 kHz all weigh the same.
#[derive(Clone, Debug)]
pub(crate) struct SpeechLoudnessMeter {
    channels: usize,
    shelf: Biquad,
    high_pass: Biquad,
    sum_squares: f64,
    count: usize,
}

impl SpeechLoudnessMeter {
    pub(crate) fn new(sample_rate: u32, channels: usize) -> Self {
        let rate = f64::from(sample_rate.max(1));
        let (shelf, high_pass) = k_weighting(rate);
        Self {
            channels: channels.max(1),
            shelf,
            high_pass,
            sum_squares: 0.0,
            count: 0,
        }
    }

    /// Listen to interleaved samples (-1.0..1.0). Only the first channel is read, like
    /// the speech detector: a microphone arrives as the same voice on both.
    pub(crate) fn process(&mut self, interleaved: &[f32]) {
        for frame in interleaved.chunks_exact(self.channels) {
            let weighted = self
                .high_pass
                .process(self.shelf.process(f64::from(frame[0])));
            self.sum_squares += weighted * weighted;
            self.count += 1;
        }
    }

    /// Loudness since the last call, in LUFS; −90 for an empty window.
    pub(crate) fn take(&mut self) -> f32 {
        let mean = if self.count == 0 {
            0.0
        } else {
            self.sum_squares / self.count as f64
        };
        self.sum_squares = 0.0;
        self.count = 0;
        if mean <= 1e-9 {
            -90.0
        } else {
            (-0.691 + 10.0 * mean.log10()) as f32
        }
    }
}

/// BS.1770's two K-weighting stages for a sample rate, from the analogue prototypes
/// (the same derivation libebur128 uses), rather than the 48 kHz table.
fn k_weighting(rate: f64) -> (Biquad, Biquad) {
    use std::f64::consts::PI;
    let shelf = {
        let f0 = 1_681.974_450_955_533;
        let gain_db = 3.999_843_853_973_347;
        let q = 0.707_175_236_955_419_6;
        let k = (PI * f0 / rate).tan();
        let vh = 10f64.powf(gain_db / 20.0);
        let vb = vh.powf(0.499_666_774_154_541_6);
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [
                (vh + vb * k / q + k * k) / a0,
                2.0 * (k * k - vh) / a0,
                (vh - vb * k / q + k * k) / a0,
            ],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            ..Default::default()
        }
    };
    let high_pass = {
        let f0 = 38.135_470_876_024_44;
        let q = 0.500_327_037_323_877_3;
        let k = (PI * f0 / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [1.0, -2.0, 1.0],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            ..Default::default()
        }
    };
    (shelf, high_pass)
}

/// One meter window of one person's microphone, measured before the listener's fader.
#[derive(Clone, Copy, Debug)]
pub struct LevelObservation {
    /// K-weighted mean square of the window, in dB.
    pub loudness_db: f32,
    pub voice_probability: f32,
    /// The sender muted their microphone: their samples are ramped to zero.
    pub sender_muted: bool,
    /// How much audio the window covers.
    pub duration: Duration,
}

/// A fader move the state should apply.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaderMove {
    pub participant_id: ParticipantId,
    pub gain_db: f32,
    /// The glide reached where it was going: the place to save the fader.
    pub settled: bool,
}

#[derive(Clone, Copy, Debug)]
struct RecentWindow {
    at: Instant,
    loudness_db: f32,
    speech: bool,
}

/// How loud one person speaks: a histogram of their speech windows, weighted by seconds
/// of speech and aged by speech.
#[derive(Clone, Debug)]
struct SpeechEstimate {
    bins: [f32; HISTOGRAM_BINS],
    /// Seconds of speech heard, not aged; only decides when the first move may happen.
    heard_s: f32,
    /// The last few seconds of speech, oldest first.
    recent: VecDeque<(f32, f32)>,
    recent_s: f32,
}

impl Default for SpeechEstimate {
    fn default() -> Self {
        Self {
            bins: [0.0; HISTOGRAM_BINS],
            heard_s: 0.0,
            recent: VecDeque::new(),
            recent_s: 0.0,
        }
    }
}

fn bin_of(loudness_db: f32) -> usize {
    let index = ((loudness_db - HISTOGRAM_FLOOR_DB) / HISTOGRAM_BIN_DB).round();
    index.clamp(0.0, (HISTOGRAM_BINS - 1) as f32) as usize
}

fn bin_level(index: usize) -> f32 {
    HISTOGRAM_FLOOR_DB + index as f32 * HISTOGRAM_BIN_DB
}

/// Power mean of weighted levels, in dB.
fn power_mean(levels: impl Iterator<Item = (f32, f32)>) -> Option<f32> {
    let (mut energy, mut weight) = (0.0_f64, 0.0_f64);
    for (level_db, w) in levels {
        energy += f64::from(w) * 10f64.powf(f64::from(level_db) / 10.0);
        weight += f64::from(w);
    }
    (weight > 1e-6).then(|| (10.0 * (energy / weight).log10()) as f32)
}

impl SpeechEstimate {
    fn seeded(loudness_db: f32) -> Self {
        let mut estimate = Self::default();
        estimate.bins[bin_of(loudness_db)] = SPEECH_BEFORE_FIRST_MOVE_S;
        estimate.heard_s = SPEECH_BEFORE_FIRST_MOVE_S;
        estimate
    }

    fn add(&mut self, loudness_db: f32, seconds: f32) {
        let keep = (-seconds / SPEECH_TIME_CONSTANT_S).exp();
        for bin in &mut self.bins {
            *bin *= keep;
        }
        self.bins[bin_of(loudness_db)] += seconds;
        self.heard_s = (self.heard_s + seconds).min(3600.0);

        self.recent.push_back((loudness_db, seconds));
        self.recent_s += seconds;
        while self.recent_s - self.recent.front().map_or(0.0, |(_, s)| *s) >= RECENT_SPEECH_S {
            let (_, s) = self.recent.pop_front().unwrap();
            self.recent_s -= s;
        }

        // A mic swap, or the sender turning their gain right up, is followed in seconds
        // instead of over the whole time constant.
        if self.recent_s >= RECENT_SPEECH_S {
            let recent = power_mean(self.recent.iter().copied());
            if let (Some(recent), Some(estimate)) = (recent, self.loudness_db()) {
                if (recent - estimate).abs() > RESTART_DIFFERENCE_DB {
                    self.bins = [0.0; HISTOGRAM_BINS];
                    for (level, s) in &self.recent {
                        self.bins[bin_of(*level)] += s;
                    }
                }
            }
        }
    }

    /// Gated loudness of the speech heard so far.
    fn loudness_db(&self) -> Option<f32> {
        let weighted = || {
            self.bins
                .iter()
                .enumerate()
                .filter(|(_, w)| **w > 0.0)
                .map(|(index, w)| (bin_level(index), *w))
        };
        let ungated = power_mean(weighted())?;
        power_mean(weighted().filter(|(level, _)| *level >= ungated - RELATIVE_GATE_DB))
    }

    fn ready(&self) -> bool {
        self.heard_s >= SPEECH_BEFORE_FIRST_MOVE_S
    }
}

#[derive(Clone, Debug, Default)]
struct Person {
    estimate: SpeechEstimate,
    latest: Option<RecentWindow>,
    /// The listener moved this fader by hand; Auto-level leaves it alone.
    held: bool,
    gliding: bool,
    /// The leveler's view of the fader after the last step, for the status.
    at_limit: bool,
}

#[derive(Debug, Default)]
pub struct AutoLeveler {
    enabled: bool,
    people: HashMap<ParticipantId, Person>,
    /// The listener's own microphone, so their voice coming back through someone else's
    /// speakers is not learned as that person.
    own_voice: Option<RecentWindow>,
}

impl AutoLeveler {
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Turning Auto-level on (again) hands every person back to it.
    pub fn set_enabled(&mut self, enabled: bool) {
        if enabled && !self.enabled {
            for person in self.people.values_mut() {
                person.held = false;
            }
        }
        if !enabled {
            for person in self.people.values_mut() {
                person.gliding = false;
            }
        }
        self.enabled = enabled;
    }

    /// The listener set this person's fader by hand.
    pub fn hold(&mut self, participant_id: ParticipantId) {
        if self.enabled {
            let person = self.people.entry(participant_id).or_default();
            person.held = true;
            person.gliding = false;
        }
    }

    pub fn resume(&mut self, participant_id: ParticipantId) {
        if let Some(person) = self.people.get_mut(&participant_id) {
            person.held = false;
        }
    }

    /// Start from a loudness remembered from an earlier call: ready at once, refined by
    /// what is heard now. Ignored once this person has been heard in this session.
    pub fn seed(&mut self, participant_id: ParticipantId, loudness_db: f32) {
        if !loudness_db.is_finite() {
            return;
        }
        let person = self.people.entry(participant_id).or_default();
        if person.estimate.heard_s == 0.0 {
            person.estimate = SpeechEstimate::seeded(loudness_db);
        }
    }

    /// The listener's own microphone, for the bleed check.
    pub fn observe_own_voice(&mut self, loudness_db: f32, voice_probability: f32, now: Instant) {
        self.own_voice = Some(RecentWindow {
            at: now,
            loudness_db,
            speech: voice_probability >= SPEECH_PROBABILITY,
        });
    }

    /// One meter window of a person's microphone. Learning runs whether Auto-level is on
    /// or not, so turning it on acts at once.
    pub fn observe(
        &mut self,
        participant_id: ParticipantId,
        observation: LevelObservation,
        now: Instant,
    ) {
        let LevelObservation {
            loudness_db,
            voice_probability,
            sender_muted,
            duration,
        } = observation;
        let speech = !sender_muted
            && loudness_db.is_finite()
            && voice_probability >= SPEECH_PROBABILITY
            && loudness_db >= ABSOLUTE_GATE_DB;
        let bleed = speech && {
            let louder = |window: &RecentWindow| {
                window.speech
                    && now.saturating_duration_since(window.at) <= CONCURRENT_WINDOW
                    && window.loudness_db - loudness_db >= BLEED_MARGIN_DB
            };
            self.own_voice.as_ref().is_some_and(louder)
                || self
                    .people
                    .iter()
                    .filter(|(id, _)| **id != participant_id)
                    .filter_map(|(_, person)| person.latest.as_ref())
                    .any(louder)
        };
        let person = self.people.entry(participant_id).or_default();
        person.latest = Some(RecentWindow {
            at: now,
            loudness_db,
            speech: speech && !bleed,
        });
        if speech && !bleed {
            person
                .estimate
                .add(loudness_db, duration.as_secs_f32().min(1.0));
        }
    }

    /// The speech loudness learned for a person, to remember between calls.
    pub fn loudness_db(&self, participant_id: ParticipantId) -> Option<f32> {
        let person = self.people.get(&participant_id)?;
        person
            .estimate
            .ready()
            .then(|| person.estimate.loudness_db())
            .flatten()
    }

    /// Where a person's fader should go, and whether that is at the edge of the range.
    fn desired(person: &Person) -> Option<(f32, bool)> {
        if !person.estimate.ready() {
            return None;
        }
        let wanted = TARGET_DB - person.estimate.loudness_db()?;
        let desired = wanted.clamp(MIN_GAIN_DB, MAX_GAIN_DB);
        Some((desired, (wanted - desired).abs() > 0.01))
    }

    /// Advance the glides by `elapsed`. `faders` are the microphones being heard now and
    /// their current faders in dB.
    pub fn step(&mut self, faders: &[(ParticipantId, f32)], elapsed: Duration) -> Vec<FaderMove> {
        let mut moves = Vec::new();
        if !self.enabled {
            return moves;
        }
        let max_step = GLIDE_DB_PER_S * elapsed.as_secs_f32();
        for (participant_id, current) in faders {
            let Some(person) = self.people.get_mut(participant_id) else {
                continue;
            };
            if person.held {
                continue;
            }
            let Some((desired, limited)) = Self::desired(person) else {
                continue;
            };
            let current = *current;
            person.at_limit = limited && (desired - current).abs() <= DEADBAND_DB;
            if !person.gliding && (desired - current).abs() > DEADBAND_DB {
                person.gliding = true;
            }
            if !person.gliding {
                continue;
            }
            let next = if desired > current {
                (current + max_step).min(desired)
            } else {
                (current - max_step).max(desired)
            };
            let settled = (next - desired).abs() < 1e-3;
            if settled {
                person.gliding = false;
                person.at_limit = limited;
            }
            if (next - current).abs() > 1e-4 || settled {
                moves.push(FaderMove {
                    participant_id: *participant_id,
                    gain_db: next,
                    settled,
                });
            }
        }
        moves
    }

    pub fn status(&self, participant_id: ParticipantId) -> AutoLevelStatus {
        if !self.enabled {
            return AutoLevelStatus::Off;
        }
        let Some(person) = self.people.get(&participant_id) else {
            return AutoLevelStatus::Listening;
        };
        if person.held {
            AutoLevelStatus::Manual
        } else if !person.estimate.ready() {
            AutoLevelStatus::Listening
        } else if person.gliding {
            AutoLevelStatus::Adjusting
        } else if person.at_limit {
            AutoLevelStatus::AtLimit
        } else {
            AutoLevelStatus::Leveled
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_millis(120);

    fn speech(loudness_db: f32) -> LevelObservation {
        LevelObservation {
            loudness_db,
            voice_probability: 0.9,
            sender_muted: false,
            duration: WINDOW,
        }
    }

    struct Call {
        leveler: AutoLeveler,
        now: Instant,
        faders: Vec<(ParticipantId, f32)>,
    }

    impl Call {
        fn new(people: usize) -> Self {
            let mut leveler = AutoLeveler::default();
            leveler.set_enabled(true);
            Self {
                leveler,
                now: Instant::now(),
                faders: (0..people).map(|_| (ParticipantId::new(), 0.0)).collect(),
            }
        }

        fn id(&self, index: usize) -> ParticipantId {
            self.faders[index].0
        }

        fn fader(&self, index: usize) -> f32 {
            self.faders[index].1
        }

        /// Run for `seconds`, each person sending what `windows` says for that window
        /// (None sends nothing), stepping every 250 ms like the state does. Returns the
        /// moves made.
        fn run(
            &mut self,
            seconds: f32,
            mut windows: impl FnMut(usize) -> Option<LevelObservation>,
        ) -> Vec<FaderMove> {
            let mut moves = Vec::new();
            let ticks = (seconds * 1000.0 / 120.0) as usize;
            let mut since_step = Duration::ZERO;
            for _ in 0..ticks {
                self.now += WINDOW;
                for index in 0..self.faders.len() {
                    if let Some(observation) = windows(index) {
                        let id = self.id(index);
                        self.leveler.observe(id, observation, self.now);
                    }
                }
                since_step += WINDOW;
                if since_step >= Duration::from_millis(250) {
                    for change in self.leveler.step(&self.faders, since_step) {
                        let slot = self
                            .faders
                            .iter_mut()
                            .find(|(id, _)| *id == change.participant_id)
                            .unwrap();
                        slot.1 = change.gain_db;
                        moves.push(change);
                    }
                    since_step = Duration::ZERO;
                }
            }
            moves
        }
    }

    #[test]
    fn silence_mute_and_non_speech_never_move_anything() {
        let mut call = Call::new(1);
        let moves = call.run(60.0, |_| {
            Some(LevelObservation {
                loudness_db: -80.0,
                voice_probability: 0.0,
                sender_muted: false,
                duration: WINDOW,
            })
        });
        assert!(moves.is_empty());
        // Loud, but the sender is muted, or the detector says it is not speech (typing).
        let moves = call.run(30.0, |_| {
            Some(LevelObservation {
                sender_muted: true,
                ..speech(-45.0)
            })
        });
        assert!(moves.is_empty());
        let moves = call.run(30.0, |_| {
            Some(LevelObservation {
                voice_probability: 0.4,
                ..speech(-45.0)
            })
        });
        assert!(moves.is_empty());
        assert_eq!(call.leveler.loudness_db(call.id(0)), None);
        assert_eq!(call.leveler.status(call.id(0)), AutoLevelStatus::Listening);
    }

    #[test]
    fn a_quiet_person_is_raised_and_a_loud_one_cut() {
        let mut call = Call::new(2);
        // They take turns, about two seconds each, the way a conversation goes. Talking
        // over each other at a 20 dB difference would look like bleed.
        let mut window = 0_usize;
        call.run(40.0, |index| {
            if index == 0 {
                window += 1;
            }
            let turn = (window / 17) % 2;
            Some(if index == turn {
                speech(if index == 0 { -33.0 } else { -13.0 })
            } else {
                speech(-85.0).with_probability(0.05)
            })
        });
        assert!(
            (call.fader(0) - 10.0).abs() <= DEADBAND_DB,
            "{}",
            call.fader(0)
        );
        assert!(
            (call.fader(1) + 10.0).abs() <= DEADBAND_DB,
            "{}",
            call.fader(1)
        );
        assert_eq!(call.leveler.status(call.id(0)), AutoLevelStatus::Leveled);
    }

    #[test]
    fn nothing_moves_before_three_seconds_of_speech() {
        let mut call = Call::new(1);
        // Speech every other window: 2.5 s of it over 5 s.
        let mut odd = false;
        let moves = call.run(5.0, |_| {
            odd = !odd;
            Some(if odd {
                speech(-40.0)
            } else {
                speech(-40.0).with_probability(0.1)
            })
        });
        assert!(moves.is_empty());
        assert!(!call.run(1.0, |_| Some(speech(-40.0))).is_empty());
    }

    impl LevelObservation {
        fn with_probability(self, voice_probability: f32) -> Self {
            Self {
                voice_probability,
                ..self
            }
        }
    }

    #[test]
    fn faders_glide_slowly_and_rest_inside_the_deadband() {
        let mut call = Call::new(1);
        let moves = call.run(30.0, |_| Some(speech(-41.0)));
        for pair in moves.windows(2) {
            let delta = (pair[1].gain_db - pair[0].gain_db).abs();
            assert!(delta <= GLIDE_DB_PER_S * 0.36 + 1e-3, "jumped {delta} dB");
        }
        assert!(moves.last().unwrap().settled);
        assert!((call.fader(0) - 12.0).abs() < 0.01);
        assert_eq!(call.leveler.status(call.id(0)), AutoLevelStatus::AtLimit);

        // Already within the deadband: never touched.
        let mut call = Call::new(1);
        call.faders[0].1 = 1.0;
        assert!(call.run(30.0, |_| Some(speech(-23.0))).is_empty());
    }

    #[test]
    fn going_quiet_keeps_the_fader() {
        let mut call = Call::new(1);
        call.run(15.0, |_| Some(speech(-30.0)));
        let leveled = call.fader(0);
        let moves = call.run(60.0, |_| Some(speech(-85.0).with_probability(0.05)));
        assert!(moves.is_empty());
        let moves = call.run(30.0, |_| None);
        assert!(moves.is_empty());
        assert_eq!(call.fader(0), leveled);
    }

    #[test]
    fn bleed_from_someone_louder_is_not_learned() {
        let mut call = Call::new(2);
        // Person 1 talks; person 0's microphone only hears them faintly through speakers.
        call.run(20.0, |index| {
            Some(speech(if index == 0 { -50.0 } else { -20.0 }))
        });
        assert_eq!(call.leveler.loudness_db(call.id(0)), None);
        assert_eq!(call.fader(0), 0.0);

        // The listener's own voice coming back is not learned either.
        let mut leveler = AutoLeveler::default();
        let someone = ParticipantId::new();
        let mut now = Instant::now();
        for _ in 0..100 {
            now += WINDOW;
            leveler.observe_own_voice(-18.0, 0.9, now);
            leveler.observe(someone, speech(-50.0), now);
        }
        assert_eq!(leveler.loudness_db(someone), None);
    }

    #[test]
    fn a_big_change_on_the_sender_is_followed_in_seconds() {
        let mut call = Call::new(1);
        call.run(60.0, |_| Some(speech(-35.0)));
        assert!((call.fader(0) - 12.0).abs() < 0.01);
        // They turn their mic up by 12 dB.
        call.run(4.0, |_| Some(speech(-23.0)));
        let loudness = call.leveler.loudness_db(call.id(0)).unwrap();
        assert!((loudness + 23.0).abs() < 1.0, "{loudness}");
        call.run(10.0, |_| Some(speech(-23.0)));
        assert!(call.fader(0).abs() <= DEADBAND_DB, "{}", call.fader(0));
    }

    #[test]
    fn a_held_person_is_left_alone_until_resumed() {
        let mut call = Call::new(1);
        call.leveler.hold(call.id(0));
        assert!(call.run(20.0, |_| Some(speech(-35.0))).is_empty());
        assert_eq!(call.leveler.status(call.id(0)), AutoLevelStatus::Manual);
        call.leveler.resume(call.id(0));
        assert!(!call.run(1.0, |_| Some(speech(-35.0))).is_empty());

        // Off and on again hands everyone back too.
        call.leveler.hold(call.id(0));
        call.leveler.set_enabled(false);
        assert_eq!(call.leveler.status(call.id(0)), AutoLevelStatus::Off);
        assert!(call.run(5.0, |_| Some(speech(-35.0))).is_empty());
        call.leveler.set_enabled(true);
        assert_ne!(call.leveler.status(call.id(0)), AutoLevelStatus::Manual);
    }

    #[test]
    fn hold_while_off_does_nothing() {
        let mut leveler = AutoLeveler::default();
        let someone = ParticipantId::new();
        leveler.hold(someone);
        leveler.set_enabled(true);
        assert_eq!(leveler.status(someone), AutoLevelStatus::Listening);
    }

    #[test]
    fn a_remembered_loudness_acts_on_the_first_word() {
        let mut call = Call::new(1);
        let id = call.id(0);
        call.leveler.seed(id, -33.0);
        assert!(!call.run(0.5, |_| Some(speech(-33.0))).is_empty());
        // Seeding again later in the session does not throw away what was heard.
        call.run(10.0, |_| Some(speech(-33.0)));
        call.leveler.seed(id, -10.0);
        assert!((call.leveler.loudness_db(id).unwrap() + 33.0).abs() < 1.0);
    }

    #[test]
    fn learning_runs_while_off_so_turning_on_acts_at_once() {
        let mut call = Call::new(1);
        call.leveler.set_enabled(false);
        assert!(call.run(10.0, |_| Some(speech(-33.0))).is_empty());
        call.leveler.set_enabled(true);
        assert!(!call.run(0.5, |_| None).is_empty());
    }

    /// K-weighted loudness of a full-scale sine, after the filters settle.
    fn sine_loudness(rate: u32, frequency: f32) -> f32 {
        let mut meter = SpeechLoudnessMeter::new(rate, 2);
        let tone: Vec<f32> = (0..rate as usize)
            .flat_map(|n| {
                let sample = (std::f32::consts::TAU * frequency * n as f32 / rate as f32).sin();
                [sample, 0.0]
            })
            .collect();
        meter.process(&tone[..tone.len() / 2]);
        meter.take();
        meter.process(&tone[tone.len() / 2..]);
        meter.take()
    }

    #[test]
    fn k_weighting_matches_bs1770_at_every_rate() {
        // A 997 Hz full-scale sine reads −3.01 LUFS by the standard's own definition.
        // The shelf adds about +4 dB at the top; the high-pass takes the rumble out.
        for rate in [48_000_u32, 44_100, 16_000] {
            let reference = sine_loudness(rate, 997.0);
            assert!(
                (reference + 3.01).abs() < 0.1,
                "{rate} Hz: 997 Hz reads {reference}"
            );
            let presence = sine_loudness(rate, 6_000.0) - reference;
            assert!(
                (3.0..4.5).contains(&presence),
                "{rate} Hz: 6 kHz +{presence}"
            );
            let rumble = sine_loudness(rate, 20.0) - reference;
            assert!(rumble < -5.0, "{rate} Hz: 20 Hz {rumble}");
            let voice = sine_loudness(rate, 200.0) - reference;
            assert!(voice.abs() < 1.0, "{rate} Hz: 200 Hz {voice}");
        }
        assert_eq!(SpeechLoudnessMeter::new(48_000, 1).take(), -90.0);
    }

    #[test]
    fn the_relative_gate_ignores_trailing_syllables() {
        let mut call = Call::new(1);
        let mut n = 0;
        call.run(20.0, |_| {
            n += 1;
            // Every fourth window is a soft tail 20 dB under the voice.
            Some(speech(if n % 4 == 0 { -45.0 } else { -25.0 }))
        });
        let loudness = call.leveler.loudness_db(call.id(0)).unwrap();
        assert!((loudness + 25.0).abs() < 0.5, "{loudness}");
    }
}
