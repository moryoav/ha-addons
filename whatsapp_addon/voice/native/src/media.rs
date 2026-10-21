use crate::{
    emit,
    playback::PlaybackState,
    recording::{Direction, Recorder},
    signaling::{parse, text},
    wire::{WireNode, decode_bytes},
};
use anyhow::{Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;
use whatsapp_rust::voip::{
    driver::RandTxIds,
    transport::{RelayMediaChannelFactory, relay_diagnostics, reset_relay_diagnostics},
};
use whatsapp_rust::wacore::voip::{
    CallChannels, CallEvent,
    audio::{AudioCodec, AudioConfig, AudioFormat},
    driver::{PeerAnswer, video_control_channel},
    engine::{CallConfig, CallEngine},
    media_stats::MediaStatsCell,
    transport::{RelayTransport, RelayTransportFactory},
};
use whatsapp_rust::wacore::voip_control::relay_parse::parse_relay_data_from_ack;
use whatsapp_rust::{
    Runtime, TokioRuntime, async_channel,
    voip::audio::{WaOpusDecoder, WaOpusEncoder},
};

pub struct MediaCall {
    pub call_id: String,
    pub playback: Arc<Mutex<PlaybackState>>,
    pub answer: async_channel::Sender<PeerAnswer>,
    pub recording: Option<Arc<Recorder>>,
    transport: Arc<dyn RelayTransport>,
    ended: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
    _video_control: whatsapp_rust::wacore::voip::driver::VideoControlSender,
}

impl MediaCall {
    pub async fn start(value: &Value, network_allowed: bool) -> Result<Self> {
        if !network_allowed {
            bail!("network_disabled");
        }
        let call_id = text(value, "call_id")?.to_owned();
        let own = text(value, "self_lid")?;
        let peer = text(value, "peer_lid")?;
        let key = decode_bytes(text(value, "call_key")?, 32)?;
        if key.len() != 32 {
            bail!("invalid_call_key");
        }
        let buffer = value
            .get("playback_buffer_ms")
            .and_then(Value::as_u64)
            .unwrap_or(180);
        if !(120..=1500).contains(&buffer) {
            bail!("invalid_buffer");
        }
        let node: WireNode = serde_json::from_value(
            value
                .get("node")
                .cloned()
                .ok_or_else(|| anyhow!("missing_node"))?,
        )?;
        let incoming = value.get("direction").and_then(Value::as_str) == Some("incoming");
        let relay = if incoming {
            let call = parse(&serde_json::to_value(&node)?)?;
            if call.action.call_id() != call_id {
                bail!("mismatched_call");
            }
            call.media()
                .and_then(|media| media.relay.clone())
                .ok_or_else(|| anyhow!("missing_relay"))?
        } else {
            parse_relay_data_from_ack(node.owned()?.get())
                .ok_or_else(|| anyhow!("missing_relay"))?
        };
        let mut config = if incoming {
            CallConfig::for_incoming(&call_id, own, peer, key, &relay)?
        } else {
            CallConfig::for_outgoing(&call_id, own, peer, key, &relay)?
        };
        let opus = value
            .get("audio_codec")
            .and_then(Value::as_str)
            .unwrap_or("opus")
            == "opus";
        let negotiated_opus = opus
            || (incoming
                && crate::signaling::incoming_opus(&parse(&serde_json::to_value(&node)?)?, false));
        config.audio = if opus {
            AudioConfig::encoded(AudioFormat::OPUS_16KHZ_60MS)
        } else if negotiated_opus {
            AudioConfig::OPUS_PCM
        } else {
            AudioConfig::MLOW_PCM
        };
        let address = std::net::SocketAddr::new(config.relay_ip.parse()?, config.relay_port);
        let engine = CallEngine::new(config, Box::new(RandTxIds))?
            .with_foreign_audio_codec(Box::new(crate::codec::PlatformOpus::new()?));
        let runtime: Arc<dyn Runtime> = Arc::new(TokioRuntime);
        reset_relay_diagnostics();
        let factory = RelayMediaChannelFactory::new(address, runtime.clone());
        let (transport, relay_events) =
            tokio::time::timeout(Duration::from_secs(15), factory.connect()).await??;
        let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(4);
        let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(32);
        let (encoded_tx, encoded_rx) = async_channel::bounded::<Bytes>(4);
        let (playout_tx, playout_rx) =
            async_channel::bounded::<whatsapp_rust::wacore::voip::audio::EncodedAudioFrame>(32);
        let (events_tx, events_rx) = async_channel::bounded(64);
        let (answer_tx, answer_rx) = async_channel::bounded(1);
        let (_, video_in) = async_channel::bounded(1);
        let (video_out, _) = async_channel::bounded(1);
        let (video_ctl_tx, video_ctl) = video_control_channel();
        let stats = Arc::new(MediaStatsCell::default());
        let channels = CallChannels {
            mic: mic_rx.clone(),
            speaker: spk_tx.clone(),
            encoded_audio_in: encoded_rx,
            encoded_audio_out: playout_tx,
            events: events_tx,
            rekey: Some(answer_rx),
            video_in,
            timed_video_in: None,
            video_out,
            video_ctl,
            group_ctl: None,
            media_stats: stats.clone(),
        };
        let mut tasks = Vec::new();
        if opus {
            let source = mic_rx;
            let sink = spk_tx;
            let mut encoder = WaOpusEncoder::new_resilient()?;
            let mut decoder = WaOpusDecoder::new()?;
            tasks.push(tokio::task::spawn_blocking(move || {
                while let Ok(pcm) = source.recv_blocking() {
                    let Ok(payload) = encoder.encode(&pcm) else {
                        break;
                    };
                    if encoded_tx.send_blocking(Bytes::from(payload)).is_err() {
                        break;
                    }
                }
            }));
            tasks.push(tokio::task::spawn_blocking(move || {
                while let Ok(frame) = playout_rx.recv_blocking() {
                    if frame.codec != AudioCodec::Opus {
                        break;
                    }
                    let Ok(pcm) = decoder.decode(&frame.data) else {
                        continue;
                    };
                    if sink.send_blocking(pcm.to_vec()).is_err() {
                        break;
                    }
                }
            }));
        } else {
            drop(encoded_tx);
            drop(playout_rx);
            drop(mic_rx);
            drop(spk_tx);
        }
        let ended = Arc::new(AtomicBool::new(false));
        let recording = value.get("recording_filename").and_then(Value::as_str).and_then(|name| {
            match Recorder::spawn(std::path::Path::new(crate::recording::ROOT), name, call_id.clone()) {
                Ok(recorder) => Some(recorder),
                Err(_) => { emit(json!({"type":"recording_failed", "call_id":call_id})); None }
            }
        });
        if value.get("recording_active").and_then(Value::as_bool) == Some(true) {
            if let Some(recorder) = &recording { recorder.enable(); }
        }
        let playback = Arc::new(Mutex::new(PlaybackState::new(buffer)));
        let running_id = call_id.clone();
        let running_transport = transport.clone();
        let running_ended = ended.clone();
        tasks.push(tokio::spawn(async move {
            let _ = whatsapp_rust::wacore::voip::run_call(
                runtime,
                running_transport,
                relay_events,
                channels,
                engine,
            )
            .await;
            if !running_ended.swap(true, Ordering::SeqCst) {
                emit(json!({"type":"media_ended", "call_id":running_id}));
            }
        }));
        let running_id = call_id.clone();
        let running_ended = ended.clone();
        let source = playback.clone();
        let outbound_recording = recording.clone();
        tasks.push(tokio::spawn(async move {
            let start = Instant::now();
            let mut tick = tokio::time::interval(Duration::from_millis(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_tick = Instant::now();
            let mut last_report = last_tick;
            while !running_ended.load(Ordering::Relaxed) {
                tick.tick().await;
                let now = Instant::now();
                let (frame, report) = {
                    let mut state = source.lock().unwrap_or_else(|e| e.into_inner());
                    let gap = now.duration_since(last_tick).as_millis();
                    state.max_pump_gap_ms = state.max_pump_gap_ms.max(gap);
                    if now.duration_since(start) > Duration::from_secs(5) { state.max_steady_pump_gap_ms = state.max_steady_pump_gap_ms.max(gap); }
                    let frame = state.render(now);
                    let report = (now.duration_since(last_report) >= Duration::from_secs(1)).then(|| state.summary());
                    (frame, report)
                };
                if let Some(report) = report {
                    last_report = now;
                    emit(json!({"type":"playback_stats", "call_id":running_id,"at_ms":start.elapsed().as_millis(),"stats":report,"transport_stats":relay_diagnostics()}));
                    let snapshot = stats.snapshot();
                    emit(json!({"type":"media_stats", "call_id":running_id,"stats":{
                        "rtp_received":snapshot.rtp_received,
                        "rtp_payload_type_unexpected":snapshot.rtp_payload_type_unexpected,
                        "srtp_unprotect_failed":snapshot.srtp_unprotect_failed,
                        "audio_frames_decoded":snapshot.audio_frames_decoded,
                        "audio_frames_delivered":snapshot.audio_frames_delivered,
                        "audio_frames_concealed":snapshot.audio_frames_concealed,
                        "foreign_frames_decoded":snapshot.foreign_frames_decoded,
                        "audio_frames_without_decoder":snapshot.audio_frames_without_decoder,
                        "outbound_frames_without_encoder":snapshot.outbound_frames_without_encoder,
                        "playout_trimmed_samples":snapshot.playout_trimmed_samples,
                        "inbound_pipe_dropped":snapshot.inbound_pipe_dropped,
                        "audio_sink_dropped":snapshot.audio_sink_dropped,
                        "relay_packet_unclassified":snapshot.relay_packet_unclassified,
                        "codec_switches":snapshot.codec_switches
                    }}));
                }
                last_tick = now;
                if let Some(recorder) = &outbound_recording { recorder.capture(Direction::Assistant, &frame, now); }
                if mic_tx.send(frame).await.is_err() { break; }
            }
        }));
        let running_id = call_id.clone();
        let inbound_recording = recording.clone();
        tasks.push(tokio::spawn(async move {
            while let Ok(pcm) = spk_rx.recv().await {
                if let Some(recorder) = &inbound_recording { recorder.capture(Direction::Caller, &pcm, Instant::now()); }
                let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
                emit(json!({"type":"audio","call_id":running_id,"data":STANDARD.encode(bytes)}));
            }
        }));
        let running_id = call_id.clone();
        tasks.push(tokio::spawn(async move {
            let start = Instant::now();
            while let Ok(event) = events_rx.recv().await {
                match event {
                    CallEvent::RtcpReceived { reports_audio:true, report_blocks, .. } => {
                        for block in report_blocks {
                            emit(json!({"type":"network_stats","call_id":running_id,"at_ms":start.elapsed().as_millis(),"peer_loss_percent":f64::from(block.fraction_lost)*100.0/256.0,"peer_cumulative_lost":block.cumulative_lost,"peer_extended_highest_sequence":block.extended_highest_sequence,"peer_jitter_ticks":block.jitter}));
                        }
                    }
                    CallEvent::AudioCodecSourceIsFixed { .. } => emit(json!({"type":"media_ended","call_id":running_id})),
                    CallEvent::AudioCodecSwitched { to, .. } => emit(json!({"type":"codec_observed","call_id":running_id,"codec":format!("{to:?}").to_lowercase()})),
                    CallEvent::OutboundMediaDropped { packets, .. } => emit(json!({"type":"network_stats","call_id":running_id,"at_ms":start.elapsed().as_millis(),"outbound_dropped_packets":packets})),
                    CallEvent::RelayAllocated => emit(json!({"type":"call_event","call_id":running_id,"event":"relay_allocated"})),
                    _ => {}
                }
            }
        }));
        emit(
            json!({"type":"call_started","call_id":call_id,"audio_codec":if negotiated_opus {"opus"} else {"mlow"},"playback_buffer_ms":buffer}),
        );
        Ok(Self {
            call_id,
            playback,
            answer: answer_tx,
            recording,
            transport,
            ended,
            tasks,
            _video_control: video_ctl_tx,
        })
    }

    pub fn audio(&self, value: &Value) -> Result<()> {
        if text(value, "call_id")? != self.call_id {
            bail!("stale_call");
        }
        let bytes = decode_bytes(
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("missing_audio"))?,
            64 * 1024,
        )?;
        if bytes.len() % 2 != 0 {
            bail!("partial_pcm_sample");
        }
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|p| i16::from_le_bytes([p[0], p[1]]))
            .collect();
        self.playback
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(&samples, Instant::now());
        Ok(())
    }
    pub async fn stop(mut self) {
        self.ended.store(true, Ordering::SeqCst);
        if let Some(recorder) = &self.recording { recorder.stop(); }
        for task in &self.tasks {
            task.abort();
        }
        self.answer.close();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.transport.disconnect()).await;
        for task in self.tasks.drain(..) {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }
        if let Some(recorder) = self.recording.take() { recorder.finish().await; }
    }
}
