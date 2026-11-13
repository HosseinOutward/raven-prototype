//! MobileNative call eligibility. Calls run only in the foreground, so nothing owns a
//! call in the background. Closing this gate invalidates pending starts before
//! asynchronous device/network teardown can take its locks. Kept apart from `media.rs`
//! so its state machine is tested on the host.

#[derive(Debug)]
pub struct MobileNativeGate {
    pub foreground: bool,
    pub epoch: u64,
    pub call_active: bool,
    pub focused: bool,
    pub pending_stop: Option<u64>,
}

impl Default for MobileNativeGate {
    fn default() -> Self {
        Self {
            foreground: true,
            epoch: 0,
            call_active: false,
            focused: false,
            pending_stop: None,
        }
    }
}

impl MobileNativeGate {
    pub fn begin(&mut self, expected_epoch: u64) -> Result<(), &'static str> {
        if self.pending_stop.is_some() {
            return Err("The previous media is still stopping.");
        }
        if !self.foreground || self.epoch != expected_epoch {
            return Err("The call was cancelled while Raven was away.");
        }
        self.call_active = true;
        Ok(())
    }

    pub fn end(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.call_active = false;
        self.focused = false;
        self.pending_stop = Some(self.epoch);
    }

    pub fn finish_stop(&mut self, epoch: u64) {
        if self.pending_stop == Some(epoch) {
            self.pending_stop = None;
        }
    }

    pub fn background(&mut self) {
        self.foreground = false;
        self.end();
    }

    pub fn audio_allowed(&self) -> bool {
        self.foreground && self.call_active && self.focused
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_does_not_restore_call_or_validate_a_pending_start() {
        let mut gate = MobileNativeGate::default();
        let pending = gate.epoch;
        gate.begin(pending).unwrap();
        gate.focused = true;
        assert!(gate.audio_allowed());
        gate.background();
        gate.foreground = true;
        assert!(!gate.audio_allowed());
        assert!(gate.begin(pending).is_err());
        assert!(gate.begin(gate.epoch).is_err());
        gate.finish_stop(gate.epoch);
        gate.begin(gate.epoch).unwrap();
        assert!(!gate.audio_allowed());
        gate.focused = true;
        assert!(gate.audio_allowed());
    }

    #[test]
    fn focus_interruption_preserves_call_but_leave_cancels_its_recovery() {
        let mut gate = MobileNativeGate::default();
        gate.begin(0).unwrap();
        gate.focused = true;
        gate.focused = false;
        assert!(gate.call_active);
        assert!(!gate.audio_allowed());
        gate.end();
        gate.focused = true;
        assert!(!gate.audio_allowed());
        assert!(gate.begin(0).is_err());
    }

    #[test]
    fn older_teardown_cannot_release_a_newer_stop_barrier() {
        let mut gate = MobileNativeGate::default();
        gate.background();
        let old = gate.epoch;
        gate.end();
        gate.foreground = true;
        gate.finish_stop(old);
        assert!(gate.begin(gate.epoch).is_err());
        gate.finish_stop(gate.epoch);
        assert!(gate.begin(gate.epoch).is_ok());
    }
}
