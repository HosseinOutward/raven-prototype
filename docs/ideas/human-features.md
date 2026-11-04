# Human features backlog

**Written:** 2026-10-14, after Raven 0.1.1.
**Status:** ideas, not decisions. Nothing here is approved until Soroush picks it.

## How to use this file

Raven's core works: nests, knocks, presence, voice and video, the mixer, text chat.
This is the list of features meant to give Raven its identity: a warm, safe home for
*human* communication, grounded in psychology, neurology and sociology, as opposed to
a playful but untrusted space (Discord).

Before building any item, read `docs/manifesto/` (both files) and the `raven-ui` and
`raven-media-engine` skills. Anything that changes who can see or reach whom must pass
the manifesto's Power Review Filter (§26) first.

Effort: **S** days, **M** a week or two, **L** larger.

Decisions already made that these ideas must respect:
- A nest knock is a heads-up with a ~3 s cancelable countdown and no approval step.
- Mute is hot-mic (the source stays captured and published, samples ramped to zero).
- Presence is consent, not telemetry: no "last seen", no durations, no counts.
- DM read status is DM-only and mutual.

## 1. Reachability: asking without intruding

### Porch light (M)
A time-boxed "I'm around for the next hour, come by", scoped to chosen friends or a
tree. Expires on its own.
- *Why:* people underestimate how much others enjoy talking with them (the "liking
  gap", Boothby et al. 2018), so they don't reach out. A standing invitation removes
  the fear of intruding.
- *In Raven:* the `open` presence plus an expiry and an audience. Because it expires,
  nobody is left looking "available" by accident.

### Answers to a knock: Coming · Give me 10 · Not today · Later (M)
- *Why:* the manifesto asks for "yes, no, later, or only under this condition".
  Ostracism research (Williams) shows silence hurts more than a polite no; a one-tap,
  kindly worded "Not today" is cheaper for both people.
- "Later" reminds only the knocker, at a time they pick. Raven never re-knocks itself.
- Silence stays acceptable: the knocker sees "No answer yet", never "Ignored", and the
  knock expires quietly.
- These are replies, not a gate. The no-approval nest knock is unchanged.

### Say why you're knocking (S)
An optional line ("quick question", "just want to hang out") or a weight: quick / hang
out / need to talk.
- *Why:* a context-free "can we talk?" makes people uneasy before they pick up.

### Quiet hours that hold messages and knocks (M)
Scheduled rest hours. Others see "Resting until 9:00" with no reason. DMs and knocks
sent then are held and arrive when the hours end; the sender sees "Arrives at 9:00
their time".
- *Why:* constant reachability is a steady low-level stress and late pings hurt sleep.
  The boundary enforces itself; nobody has to say no.

### Close circle (S)
A private list of the few people who still get through while you are Focused.
- *Why:* Dunbar's layers; the innermost is about 5 people.
- Must stay invisible to everyone, including the people on it, or it becomes a ranking.

## 2. In a call: the signals voice loses

### Spatial voices (M) — top pick
Each participant gets a fixed place in the stereo field.
- *Why:* spatial release from masking (the cocktail-party effect): voices from
  different directions are much easier to separate. Less fatigue, fewer collisions.
- *In Raven:* playback is mixed in Rust per receiver strip, so this is a pan stage and
  a default layout. A WebView app cannot do this well; it is Raven's "DAW-grade" signature.

### Ephemeral reactions (S/M)
Nod, laugh, ♥, "+1" on a listener's avatar for ~2 s. Never counted, never stored.
- *Why:* voice loses backchannel ("mm-hm", nodding); speakers without it get anxious
  and over-talk.
- *In Raven:* LiveKit data channel, nothing persisted, so it cannot become a metric.

### "I'd like to say something" (S)
A soft ring on your avatar (not a classroom hand) that clears when you speak.
- *Why:* turn gaps in natural talk are ~200 ms (Stivers et al. 2009); latency breaks
  that, and quieter people get talked over.

### Even out voices (S/M)
Receive-side loudness levelling per person, in the Mixer.
- *Why:* quiet voices often belong to shy people; levelling makes the room fairer.

### Step away (S)
Leave briefly without leaving: mic mutes, avatar dims with "Back soon", no join/leave
sounds.
- *Why:* leaving and rejoining is socially loud.

### Wave hello and goodbye (S)
An optional soft sound and a "Mina waved goodbye" line.
- *Why:* greetings and farewells frame an interaction (Goffman's access rituals); an
  abrupt silent exit can read as rejection.

### Ease video fatigue (S)
Small or hidden self-view after the first check; one-click "Camera rest" to voice only.
- *Why:* Bailenson (2021): mirror anxiety and constant close-up eye contact.

### Purpose line on a nest (S)
"Co-working, mics mostly off", "Venting, be gentle", shown on the threshold.
- *Why:* you consent to the room's mood before entering.

## 3. Together without having to talk

### Quiet company nests (M)
Everyone joins muted, nobody is expected to speak; a shoulder-tap unmutes just the two
of you.
- *Why:* body doubling helps many people with ADHD, and silent co-presence is its own
  closeness. Honest caveat: evidence for body doubling is mostly anecdotal so far.
- The clearest "warm home" feature; Discord has nothing like it.

### Room tone (S, engine)
Optional very quiet comfort noise so a silent call doesn't sound dead.
- *Why:* telephony adds comfort noise because total digital silence makes people
  unsure the line is alive.

### Recurring gatherings (M)
A nest that opens itself at a set time (Friday 20:00). No RSVP, no attendance.
- *Why:* shared rituals hold groups together. The opposite of a meeting invite.

## 4. Safety and distance in small groups

### Distance short of blocking (M)
- **Quiet:** you stop seeing their presence; their knocks arrive silently. They are not told.
- **Distance:** they stop seeing your presence.
- **Block:** as today.
- *Why:* in a small friend group a hard block can start a fight; people need ways to
  step back that don't announce a falling-out.

### See Raven as… (M)
Preview exactly what one friend or one tree can see of you right now.
- *Why:* manifesto §7.5, power must be explainable.

### Curtain hotkey (S)
One key cuts mic, camera and screen together, for when someone walks into your room.

### Safer screen sharing (S/M)
Pause share (freeze frame), "share a window, not the desk" as the default, keep
Raven's own windows out of capture (`WDA_EXCLUDEFROMCAPTURE`).

## 5. Accessibility and differing needs

### Local live captions (L)
On-device speech-to-text (Whisper-class). Others see "Mina has captions on", because
it transcribes their voices.
- *Why:* hard of hearing and second-language speakers. The manifesto permits
  locally controlled accessibility AI.

### Hearing profile (M)
Per-ear balance and a "voice clarity" EQ on what you hear, in the Mixer.

### Low-stimulation mode (S)
Softer or no sounds, no motion, fewer toasts.

## 6. QoL

| Idea | Why | Status |
|---|---|---|
| Remember each person's volume across calls | Fix "Ali is always too loud" once | 0.1.2 |
| "You're talking while muted" hint | Hot-mic mute keeps capture, so the level can be read locally; nothing new leaves the machine | 0.1.2 |
| Toast when Raven switches device ("Switched to your headset") | Devices are followed silently today | 0.1.2 |
| "Others hear you choppy" instead of only a network readout | Say what the number means for other people | 0.1.2 |
| Push-to-talk release tail (~200 ms) | Stops the last syllable being cut | done |
| Opt-in local time on a person's page ("It's 23:40 for Mina") | Reach people at a decent hour | idea |
| Name pronunciation and pronouns on profiles | Dignity | idea |

## Deliberately not building

Streaks, "you haven't talked to X in a while" nudges, talking-time stats (even
private), mood or emotion detection, AI summaries by default, followers, public
profiles, badges and levels. Each breaks the manifesto.

## Suggested order

Identity-defining and no new infrastructure: spatial voices, knock replies with
"Later", porch light, quiet hours with held delivery, quiet company nests, distance
short of blocking.
