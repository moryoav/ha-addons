//! Optional recording. The media tasks only copy into a bounded, nonblocking
//! queue. One dedicated thread mixes both directions and owns every disk write.
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, BufWriter, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub const ROOT: &str = "/media/whatsapp/call-recordings";
const RATE: u64 = 16_000;
const BLOCK: u64 = 320;
const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const FINISHING: u8 = 2;
const FAILED: u8 = 3;
const MAX_SAMPLES: u64 = RATE * 920;
const MIX_WINDOW: u64 = RATE + RATE / 4;

#[derive(Clone, Copy)]
pub enum Direction {
    Caller,
    Assistant,
}

struct Frame {
    direction: Direction,
    at: u64,
    samples: Vec<i16>,
}

pub struct Recorder {
    sender: SyncSender<Frame>,
    state: Arc<AtomicU8>,
    origin: Instant,
    start_us: AtomicU64,
    writer: Mutex<Option<JoinHandle<()>>>,
}

pub fn valid_filename(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 53
        && bytes[8] == b'T'
        && bytes[15] == b'Z'
        && bytes[16] == b'-'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..15].iter().all(u8::is_ascii_digit)
        && bytes[17..49]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && &bytes[49..] == b".wav"
}

impl Recorder {
    pub fn spawn(root: &Path, name: &str, call_id: String) -> io::Result<Arc<Self>> {
        if !valid_filename(name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid_recording_name",
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(128);
        let state = Arc::new(AtomicU8::new(IDLE));
        let recorder = Arc::new(Self {
            sender,
            state: state.clone(),
            origin: Instant::now(),
            start_us: AtomicU64::new(0),
            writer: Mutex::new(None),
        });
        let destination = root.join(name);
        let writer = std::thread::Builder::new()
            .name("call-recording".into())
            .spawn(move || {
                let result = write_recording(&destination, receiver, &state);
                if result.is_err() {
                    state.store(FAILED, Ordering::Release);
                    // No paths, caller identities, audio, or filesystem errors in logs.
                    crate::emit(json!({"type":"recording_failed", "call_id":call_id}));
                }
            })?;
        *recorder.writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(writer);
        Ok(recorder)
    }

    pub fn enable(&self) {
        if self.state.load(Ordering::Acquire) == IDLE {
            self.start_us.store(
                self.origin.elapsed().as_micros() as u64 + 1,
                Ordering::Release,
            );
            let _ = self
                .state
                .compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire);
        }
    }

    pub fn capture(&self, direction: Direction, samples: &[i16], now: Instant) {
        if self.state.load(Ordering::Acquire) != RUNNING {
            return;
        }
        let start = self.start_us.load(Ordering::Acquire).saturating_sub(1);
        let at = (now.duration_since(self.origin).as_micros() as u64).saturating_sub(start) * RATE
            / 1_000_000;
        // Incoming decoded frames describe the interval just received. Outgoing
        // frames describe the interval about to be sent after the playback buffer.
        let at = match direction {
            Direction::Caller => at.saturating_sub(samples.len() as u64),
            Direction::Assistant => at,
        };
        self.enqueue(direction, at, samples);
    }

    fn enqueue(&self, direction: Direction, at: u64, samples: &[i16]) {
        if samples.len() > RATE as usize || at + samples.len() as u64 > MAX_SAMPLES {
            self.state.store(FAILED, Ordering::Release);
            return;
        }
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) =
            self.sender.try_send(Frame {
                direction,
                at,
                samples: samples.to_vec(),
            })
        {
            // A slow recorder never applies backpressure to the live media path.
            self.state.store(FAILED, Ordering::Release);
        }
    }

    pub fn stop(&self) {
        let _ = self
            .state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value != FAILED).then_some(FINISHING)
            });
    }

    pub async fn finish(&self) {
        self.stop();
        let writer = self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(writer) = writer {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                tokio::task::spawn_blocking(move || writer.join()),
            )
            .await;
        }
    }
}

// Retain the largest accepted frame (1 s) plus scheduling tolerance only in the
// recording writer, so a long decoded chunk can still mix with the other side.
// This is independent of playback and is flushed immediately when the call ends.
struct Mixer {
    blocks: BTreeMap<u64, Box<[i32; BLOCK as usize]>>,
    written: u64,
    end: u64,
    cursors: [Option<u64>; 2],
}

impl Mixer {
    fn new() -> Self {
        Self {
            blocks: BTreeMap::new(),
            written: 0,
            end: 0,
            cursors: [None, None],
        }
    }

    fn add(&mut self, mut frame: Frame) {
        let leg = match frame.direction {
            Direction::Caller => 0,
            Direction::Assistant => 1,
        };
        if let Some(cursor) = self.cursors[leg] {
            // Smooth packet scheduling jitter without stretching either voice or
            // overlapping a speaker with their own previous frame. Preserve DTX gaps.
            frame.at = if frame.at.abs_diff(cursor) <= RATE / 25 {
                cursor
            } else {
                frame.at.max(cursor)
            };
        }
        self.cursors[leg] = Some(frame.at + frame.samples.len() as u64);
        self.end = self.end.max(frame.at + frame.samples.len() as u64);
        for (index, sample) in frame.samples.into_iter().enumerate() {
            let at = frame.at + index as u64;
            if at < self.written {
                continue;
            }
            let block = self
                .blocks
                .entry(at / BLOCK)
                .or_insert_with(|| Box::new([0; BLOCK as usize]));
            block[(at % BLOCK) as usize] += i32::from(sample);
        }
    }

    fn flush(&mut self, file: &mut impl Write, through: u64) -> io::Result<()> {
        let through = through.min(MAX_SAMPLES);
        while self.written < through {
            let block_id = self.written / BLOCK;
            let limit = through.min((block_id + 1) * BLOCK);
            let block = self
                .blocks
                .remove(&block_id)
                .unwrap_or_else(|| Box::new([0; BLOCK as usize]));
            let bytes: Vec<u8> = (self.written..limit)
                .flat_map(|at| {
                    (block[(at % BLOCK) as usize].clamp(i16::MIN as i32, i16::MAX as i32) as i16)
                        .to_le_bytes()
                })
                .collect();
            file.write_all(&bytes)?;
            self.written = limit;
        }
        Ok(())
    }
}

fn header(samples: u64) -> [u8; 44] {
    let mut data = [0u8; 44];
    let bytes = (samples * 2) as u32;
    data[..4].copy_from_slice(b"RIFF");
    data[4..8].copy_from_slice(&(36 + bytes).to_le_bytes());
    data[8..16].copy_from_slice(b"WAVEfmt ");
    data[16..20].copy_from_slice(&16u32.to_le_bytes());
    data[20..22].copy_from_slice(&1u16.to_le_bytes());
    data[22..24].copy_from_slice(&1u16.to_le_bytes());
    data[24..28].copy_from_slice(&(RATE as u32).to_le_bytes());
    data[28..32].copy_from_slice(&(RATE as u32 * 2).to_le_bytes());
    data[32..34].copy_from_slice(&2u16.to_le_bytes());
    data[34..36].copy_from_slice(&16u16.to_le_bytes());
    data[36..40].copy_from_slice(b"data");
    data[40..44].copy_from_slice(&bytes.to_le_bytes());
    data
}

fn write_recording(
    destination: &Path,
    receiver: Receiver<Frame>,
    state: &AtomicU8,
) -> io::Result<()> {
    let partial = PathBuf::from(format!("{}.part", destination.display()));
    let mut owned_partial = false;
    let result = (|| {
        if destination.try_exists()? {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "recording_exists",
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = BufWriter::with_capacity(64 * 1024, options.open(&partial)?);
        owned_partial = true;
        file.write_all(&header(0))?;
        let mut mixer = Mixer::new();
        loop {
            if state.load(Ordering::Acquire) == FAILED {
                return Err(io::Error::other("recording_stopped"));
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(frame) => mixer.add(frame),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if state.load(Ordering::Acquire) == FINISHING {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Flush whole blocks only. Late arrivals cannot overwrite saved audio.
            // Use the received frame watermark rather than wall time. A delayed
            // disk writer can drain queued frames without replacing them with silence.
            while let Ok(frame) = receiver.try_recv() {
                if state.load(Ordering::Acquire) == FAILED {
                    return Err(io::Error::other("recording_stopped"));
                }
                mixer.add(frame);
            }
            let through = mixer.end.saturating_sub(MIX_WINDOW) / BLOCK * BLOCK;
            mixer.flush(&mut file, through)?;
        }
        if mixer.end == 0 {
            return Ok(());
        }
        mixer.flush(&mut file, mixer.end.max(mixer.written))?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&header(mixer.written))?;
        file.flush()?;
        file.get_ref().sync_all()?;
        drop(file);
        // The API only lists the completed .wav file, never a recording in progress.
        fs::rename(&partial, destination)?;
        owned_partial = false;
        Ok(())
    })();
    if owned_partial {
        let _ = fs::remove_file(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_recording_aligns_both_sides_silence_and_clips_overlap() {
        let mut mixer = Mixer::new();
        mixer.add(Frame {
            direction: Direction::Caller,
            at: 0,
            samples: vec![20_000; 320],
        });
        mixer.add(Frame {
            direction: Direction::Assistant,
            at: 160,
            samples: vec![20_000; 320],
        });
        mixer.add(Frame {
            direction: Direction::Assistant,
            at: 1600,
            samples: vec![-12_345; 320],
        });
        let mut bytes = Vec::new();
        mixer.flush(&mut bytes, 1920).unwrap();
        let pcm: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|p| i16::from_le_bytes([p[0], p[1]]))
            .collect();
        assert!(pcm[..160].iter().all(|&v| v == 20_000));
        assert!(pcm[160..320].iter().all(|&v| v == 32_767));
        assert!(pcm[320..480].iter().all(|&v| v == 20_000));
        assert!(pcm[480..1600].iter().all(|&v| v == 0));
        assert!(pcm[1600..].iter().all(|&v| v == -12_345));
    }

    #[test]
    fn disk_backpressure_never_blocks_a_media_producer() {
        let (sender, _blocked_writer) = mpsc::sync_channel(1);
        let recorder = Recorder {
            sender,
            state: Arc::new(AtomicU8::new(RUNNING)),
            origin: Instant::now(),
            start_us: AtomicU64::new(1),
            writer: Mutex::new(None),
        };
        recorder.enqueue(Direction::Caller, 0, &[1; 320]);
        let before = Instant::now();
        recorder.enqueue(Direction::Caller, 320, &[2; 320]);
        assert!(before.elapsed() < Duration::from_millis(50));
        assert_eq!(recorder.state.load(Ordering::Acquire), FAILED);
    }

    #[test]
    fn scheduling_jitter_cannot_overlap_a_voice_with_itself() {
        let mut mixer = Mixer::new();
        mixer.add(Frame {
            direction: Direction::Caller,
            at: 0,
            samples: vec![1000; 320],
        });
        mixer.add(Frame {
            direction: Direction::Caller,
            at: 160,
            samples: vec![1000; 320],
        });
        let mut bytes = Vec::new();
        mixer.flush(&mut bytes, 640).unwrap();
        assert!(
            bytes
                .chunks_exact(2)
                .all(|p| i16::from_le_bytes([p[0], p[1]]) == 1000)
        );
    }

    #[test]
    fn three_minutes_of_both_voices_keep_the_mixing_window_bounded() {
        let mut mixer = Mixer::new();
        let mut output = io::sink();
        for tick in 0..3000 {
            let at = tick * 960;
            mixer.add(Frame {
                direction: Direction::Caller,
                at,
                samples: vec![1000; 960],
            });
            mixer.add(Frame {
                direction: Direction::Assistant,
                at,
                samples: vec![2000; 960],
            });
            mixer
                .flush(
                    &mut output,
                    (mixer.end.saturating_sub(MIX_WINDOW) / BLOCK) * BLOCK,
                )
                .unwrap();
            assert!(mixer.blocks.len() < 80);
        }
        mixer.flush(&mut output, mixer.end).unwrap();
        assert_eq!(mixer.written, RATE * 180);
        assert!(mixer.blocks.is_empty());
    }

    #[test]
    fn interrupted_ai_speech_is_discarded_before_recording_the_next_frame() {
        let mut playback = crate::playback::PlaybackState::new(180);
        let now = playback.created;
        playback.push(&vec![1200; 16000], now);
        let spoken = playback.render(now);
        assert!(spoken.iter().any(|&sample| sample != 0));
        playback.clear();
        let after_interruption = playback.render(now + Duration::from_millis(60));
        assert!(after_interruption.iter().all(|&sample| sample == 0));
        let mut mixer = Mixer::new();
        mixer.add(Frame {
            direction: Direction::Assistant,
            at: 0,
            samples: spoken,
        });
        mixer.add(Frame {
            direction: Direction::Assistant,
            at: 960,
            samples: after_interruption,
        });
        let mut bytes = Vec::new();
        mixer.flush(&mut bytes, mixer.end).unwrap();
        assert_eq!(bytes.len(), 1920 * 2);
        assert!(bytes[1920..].iter().all(|&byte| byte == 0));
    }

    #[tokio::test]
    async fn completed_recording_has_playable_wave_header_and_private_permissions() {
        let root = std::env::temp_dir().join(format!("wa-recording-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let name = "20260102T030405Z-0123456789abcdef0123456789abcdef.wav";
        let recorder = Recorder::spawn(&root, name, "synthetic".into()).unwrap();
        assert_eq!(recorder.state.load(Ordering::Acquire), IDLE);
        recorder.capture(Direction::Caller, &[999; 320], Instant::now());
        recorder.enable();
        recorder.enqueue(Direction::Caller, 0, &[321; 16_000]);
        recorder.enqueue(Direction::Assistant, 0, &[123; 16_000]);
        recorder.finish().await;
        let bytes = fs::read(root.join(name)).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            16_000
        );
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            32_000
        );
        assert_eq!(bytes.len(), 32_044);
        assert!(
            bytes[44..]
                .chunks_exact(2)
                .all(|p| i16::from_le_bytes([p[0], p[1]]) == 444)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(root.join(name)).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn recording_paths_cannot_escape_the_fixed_media_directory() {
        for name in [
            "../outside.wav",
            "/tmp/out.wav",
            ".hidden.wav",
            "20260102T030405Z-0123456789abcdef0123456789abcdeG.wav",
        ] {
            assert!(!valid_filename(name));
        }
    }

    #[test]
    fn a_failed_writer_does_not_leave_a_playable_partial_recording() {
        let root = std::env::temp_dir().join(format!("wa-recording-failed-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("20260102T030405Z-0123456789abcdef0123456789abcdef.wav");
        let (_sender, receiver) = mpsc::sync_channel(1);
        assert!(write_recording(&destination, receiver, &AtomicU8::new(FAILED)).is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn an_unanswered_call_never_leaves_a_recording() {
        let root =
            std::env::temp_dir().join(format!("wa-recording-unanswered-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let recorder = Recorder::spawn(
            &root,
            "20260102T030405Z-0123456789abcdef0123456789abcdef.wav",
            "synthetic".into(),
        )
        .unwrap();
        recorder.capture(Direction::Assistant, &[1000; 960], Instant::now());
        recorder.finish().await;
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
}
