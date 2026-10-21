use serde_json::{Value, json};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub(crate) const FRAME_SAMPLES: usize = 960;

pub(crate) struct PlaybackState {
    samples: VecDeque<i16>,
    playing: bool,
    last_received: Option<Instant>,
    pub(crate) max_pump_gap_ms: u128,
    pub(crate) max_steady_pump_gap_ms: u128,
    pub(crate) created: Instant,
    prefill_ms: u64,
    target_ms: f64,
    rate: f64,
    integral: f64,
    phase: f64,
    previous_sample: i16,
    last_output: i16,
    recovering: bool,
    underruns: u64,
    padded_samples: u64,
    overflow_samples: u64,
    peak_samples: usize,
    pushed_samples: u64,
    played_samples: u64,
    rendered_samples: u64,
    startup_silence_samples: u64,
    idle_silence_samples: u64,
    started: bool,
    underrun_events: VecDeque<Value>,
}

impl PlaybackState {
    pub(crate) fn new(prefill_ms: u64) -> Self {
        Self {
            samples: VecDeque::new(),
            playing: false,
            last_received: None,
            max_pump_gap_ms: 0,
            max_steady_pump_gap_ms: 0,
            created: Instant::now(),
            prefill_ms,
            target_ms: prefill_ms as f64,
            rate: 1.0,
            integral: 0.0,
            phase: 0.0,
            previous_sample: 0,
            last_output: 0,
            recovering: false,
            underruns: 0,
            padded_samples: 0,
            overflow_samples: 0,
            peak_samples: 0,
            pushed_samples: 0,
            played_samples: 0,
            rendered_samples: 0,
            startup_silence_samples: 0,
            idle_silence_samples: 0,
            started: false,
            underrun_events: VecDeque::new(),
        }
    }

    pub(crate) fn push(&mut self, pcm: &[i16], now: Instant) {
        if pcm.is_empty() {
            return;
        }
        if let Some(last) = self.last_received {
            let gap = now.saturating_duration_since(last).as_secs_f64() * 1000.0;
            // A bounded target grows only from observed, short delivery gaps. Long idle periods
            // are not jitter. We recover the target gradually while continuing playback.
            if self.started && gap < 400.0 {
                self.target_ms = self
                    .target_ms
                    .max(gap + 60.0)
                    .min((self.prefill_ms + 180).min(1500) as f64);
            }
        }
        self.samples.extend(pcm);
        self.pushed_samples += pcm.len() as u64;
        self.last_received = Some(now);
        self.peak_samples = self.peak_samples.max(self.samples.len());
        while self.samples.len() > 64_000 {
            self.previous_sample = self.samples.pop_front().unwrap_or(0);
            self.overflow_samples += 1;
        }
    }

    pub(crate) fn clear(&mut self) {
        self.samples.clear();
        self.playing = false;
        self.phase = 0.0;
        self.integral = 0.0;
        self.rate = 1.0;
        self.last_output = 0;
        self.recovering = false;
    }

    pub(crate) fn render(&mut self, now: Instant) -> Vec<i16> {
        self.rendered_samples += FRAME_SAMPLES as u64;
        let age = self
            .last_received
            .map(|last| now.saturating_duration_since(last));
        let tail_timeout = Duration::from_millis((self.prefill_ms + 120).max(240));
        let tail_ready = !self.samples.is_empty() && age.is_some_and(|v| v >= tail_timeout);
        if !self.playing && (self.samples.len() >= self.prefill_ms as usize * 16 || tail_ready) {
            self.playing = true;
            self.started = true;
        }
        let mut frame = vec![0_i16; FRAME_SAMPLES];
        if !self.playing {
            if self.started {
                self.idle_silence_samples += FRAME_SAMPLES as u64;
            } else {
                self.startup_silence_samples += FRAME_SAMPLES as u64;
            }
            return frame;
        }

        // Match the source clock with a slow PI controller. A fixed initial cushion alone
        // eventually drains if the source is even 1-2% slower than the playback clock.
        // Corrections stay within 4%, slew gently, and use cubic sample interpolation.
        if now.saturating_duration_since(self.created) >= Duration::from_secs(1)
            && age.is_some_and(|v| v < Duration::from_millis(350))
        {
            let error_ms = self.samples.len() as f64 / 16.0 - (self.target_ms + 30.0);
            self.integral = (self.integral + error_ms * 0.000_001).clamp(-0.025, 0.025);
            let desired = (1.0 + error_ms * 0.000_3 + self.integral).clamp(0.96, 1.04);
            self.rate += (desired - self.rate).clamp(-0.002, 0.002);
        } else if tail_ready {
            self.rate = 1.0;
        }

        let was_recovering = self.recovering;
        let mut produced = 0;
        for sample in frame.iter_mut() {
            let i = self.phase.floor() as usize;
            let Some(&b) = self.samples.get(i) else {
                break;
            };
            let fraction = self.phase - i as f64;
            let a = if i == 0 {
                self.previous_sample
            } else {
                self.samples[i - 1]
            };
            let c = *self.samples.get(i + 1).unwrap_or(&b);
            let d = *self.samples.get(i + 2).unwrap_or(&c);
            let (a, b, c, d) = (a as f64, b as f64, c as f64, d as f64);
            let value = b + 0.5
                * fraction
                * (c - a
                    + fraction
                        * (2.0 * a - 5.0 * b + 4.0 * c - d + fraction * (3.0 * (b - c) + d - a)));
            let gain = if was_recovering && produced < 80 {
                (produced + 1) as f64 / 80.0
            } else {
                1.0
            };
            *sample = (value * gain)
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            self.phase += self.rate;
            produced += 1;
        }
        let consumed = (self.phase.floor() as usize).min(self.samples.len());
        for _ in 0..consumed {
            self.previous_sample = self.samples.pop_front().unwrap_or(0);
        }
        self.phase -= consumed as f64;
        self.played_samples += consumed as u64;

        self.recovering = produced < FRAME_SAMPLES;
        if self.recovering {
            self.phase = 0.0;
            self.underruns += 1;
            self.padded_samples += (FRAME_SAMPLES - produced) as u64;
            let fade_from = if produced == 0 {
                self.last_output
            } else {
                frame[produced - 1]
            };
            for (i, sample) in frame.iter_mut().skip(produced).take(80).enumerate() {
                *sample = (fade_from as f64 * (1.0 - (i + 1) as f64 / 80.0)).round() as i16;
            }
            self.underrun_events.push_back(json!({
                "at_ms":now.saturating_duration_since(self.created).as_millis(),
                "missing_ms":(FRAME_SAMPLES - produced) as f64 / 16.0,
                "last_chunk_age_ms":age.map(|v| v.as_millis())
            }));
            while self.underrun_events.len() > 64 {
                self.underrun_events.pop_front();
            }
            // A transient shortage never triggers a full refill pause. New audio is playable
            // on the next tick, while rate correction rebuilds the cushion in the background.
            if age.is_some_and(|v| v >= Duration::from_millis(600)) {
                self.playing = false;
                self.integral = 0.0;
                self.rate = 1.0;
            }
        }
        self.last_output = *frame.last().unwrap_or(&0);
        frame
    }

    pub(crate) fn summary(&self) -> Value {
        json!({"prefill_ms":self.prefill_ms, "target_ms":self.target_ms,
            "playback_rate":self.rate, "underruns":self.underruns,
            "padded_samples":self.padded_samples, "overflow_samples":self.overflow_samples,
            "peak_queue_ms":self.peak_samples as f64 / 16.0,
            "max_pump_gap_ms":self.max_pump_gap_ms,
            "max_steady_pump_gap_ms":self.max_steady_pump_gap_ms,
            "queued_ms":self.samples.len() as f64 / 16.0,
            "pushed_audio_ms":self.pushed_samples as f64 / 16.0,
            "played_audio_ms":self.played_samples as f64 / 16.0,
            "rendered_audio_ms":self.rendered_samples as f64 / 16.0,
            "startup_silence_ms":self.startup_silence_samples as f64 / 16.0,
            "idle_silence_ms":self.idle_silence_samples as f64 / 16.0,
            "buffering":!self.playing, "recent_underruns":self.underrun_events})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shortage_does_not_restart_the_full_cushion() {
        let mut b = PlaybackState::new(480);
        let t = b.created;
        b.push(&vec![1000; 7680], t);
        for n in 0..9 {
            b.render(t + Duration::from_millis(n * 60));
        }
        assert!(b.underruns > 0);
        b.push(&vec![2000; 320], t + Duration::from_millis(550));
        let resumed = b.render(t + Duration::from_millis(600));
        assert!(
            resumed[..320].iter().any(|v| *v > 1000),
            "A 20 ms chunk must resume immediately"
        );
        assert!(
            b.playing,
            "Transient starvation must not trigger a 480 ms refill"
        );
    }

    #[test]
    fn a_short_final_fragment_is_not_stranded() {
        let mut b = PlaybackState::new(180);
        let t = b.created;
        b.push(&[300; 240], t);
        assert!(
            b.render(t + Duration::from_millis(180))
                .iter()
                .all(|s| *s == 0)
        );
        let frame = b.render(t + Duration::from_millis(400));
        assert!(frame[..240].iter().all(|s| *s == 300));
        assert!(b.samples.is_empty());
        assert_eq!(b.played_samples, 240);
    }

    fn simulate(source_interval_ms: f64, jitter_ms: u64, buffer_ms: u64) -> PlaybackState {
        let mut b = PlaybackState::new(buffer_ms);
        let t = b.created;
        let mut chunk = 0;
        let mut previous_arrival = 0;
        for ms in (0..180_000).step_by(20) {
            loop {
                let delay = if chunk % 79 == 43 { jitter_ms } else { 0 };
                let arrival =
                    ((chunk as f64 * source_interval_ms) as u64 + delay).max(previous_arrival);
                if arrival > ms {
                    break;
                }
                let pcm: Vec<i16> = (0..320)
                    .map(|i| {
                        let phase =
                            (chunk * 320 + i) as f64 * 440.0 * std::f64::consts::TAU / 16000.0;
                        (8000.0 * phase.sin()) as i16
                    })
                    .collect();
                b.push(&pcm, t + Duration::from_millis(ms));
                previous_arrival = arrival;
                chunk += 1;
            }
            if ms % 60 == 0 {
                b.render(t + Duration::from_millis(ms));
            }
        }
        b
    }

    #[test]
    fn three_minutes_of_source_clock_drift_do_not_empty_a_180_ms_buffer() {
        let b = simulate(20.36, 80, 180);
        assert_eq!(b.underruns, 0, "Clock drift must not create periodic cuts");
        assert_eq!(b.overflow_samples, 0);
        assert!((0.97..1.0).contains(&b.rate));
        assert!(b.samples.len() > 320);
        assert!(b.peak_samples < 16 * 500);
    }

    #[test]
    fn three_minutes_of_faster_source_audio_remain_bounded() {
        let b = simulate(19.64, 80, 180);
        assert_eq!(b.underruns, 0);
        assert_eq!(b.overflow_samples, 0);
        assert!((1.0..1.03).contains(&b.rate));
        assert!(b.peak_samples < 16 * 500);
    }

    #[test]
    fn a_480_ms_setting_handles_ordered_280_ms_delivery_jitter() {
        let b = simulate(20.0, 280, 480);
        assert_eq!(b.underruns, 0);
        assert_eq!(b.overflow_samples, 0);
        assert!((0.96..=1.04).contains(&b.rate));
    }

    #[test]
    fn silence_remains_silent_and_clear_resets_playback() {
        let mut b = PlaybackState::new(180);
        let t = b.created;
        b.push(&vec![0; 2880], t);
        for n in 0..12 {
            assert!(
                b.render(t + Duration::from_millis(n * 60))
                    .iter()
                    .all(|v| *v == 0)
            );
        }
        b.clear();
        assert!(!b.playing);
        assert_eq!(b.phase, 0.0);
        assert_eq!(b.rate, 1.0);
    }
}
