//! Synthetic RTP/SRTP and Opus verification. No relay socket or external network.
use whatsapp_rust::{
    voip::{
        audio::{WaOpusDecoder, WaOpusEncoder},
        driver::RandTxIds,
    },
    wacore::voip::{
        audio::{AudioConfig, AudioFormat},
        engine::{CallConfig, CallEngine, Input, Output},
        session::{CallDirection, MediaPipeline, MediaPipelineParams},
        stun,
    },
};

const OWN: &str = "111111111:3@lid";
const PEER: &str = "222222222:7@lid";
const KEY: [u8; 32] = [7; 32];

fn config() -> CallConfig {
    CallConfig {
        call_id: "OFFLINE-MEDIA".into(),
        direction: CallDirection::Incoming,
        self_lid: OWN.into(),
        peer_lid: PEER.into(),
        call_key: KEY.to_vec(),
        ssrc: 17,
        audio: AudioConfig::encoded(AudioFormat::OPUS_16KHZ_60MS),
        relay_token: vec![0xab; 16],
        auth_token: vec![0xcd; 8],
        relay_ip: "203.0.113.7".into(),
        relay_port: 3478,
        integrity_key: b"synthetic-relay-key".to_vec(),
        warp_mi_tag_len: 4,
        enable_media: true,
        enable_video: false,
        enable_sframe: false,
    }
}

fn drain(engine: &mut CallEngine) -> Vec<Output> {
    let mut result = Vec::new();
    loop {
        match engine.poll_output() {
            Output::Timeout(_) => break,
            value => result.push(value),
        }
    }
    result
}

fn allocated() -> CallEngine {
    allocated_with(config())
}

fn allocated_with(config: CallConfig) -> CallEngine {
    let mut engine = CallEngine::new(config, Box::new(RandTxIds))
        .unwrap()
        .with_foreign_audio_codec(Box::new(crate::codec::PlatformOpus::new().unwrap()));
    engine.start(0, 0);
    let initial = drain(&mut engine);
    let transaction = initial
        .iter()
        .find_map(|output| match output {
            Output::Transmit(bytes)
                if stun::stun_message_type(bytes) == Some(stun::MSG_ALLOCATE_REQUEST) =>
            {
                stun::stun_transaction_id(bytes).map(|bytes| <[u8; 12]>::try_from(bytes).unwrap())
            }
            _ => None,
        })
        .unwrap();
    let success =
        stun::encode_stun_request(stun::MSG_ALLOCATE_SUCCESS, &transaction, &[], None, false);
    engine.handle_input(0, Input::RelayPacket(&success));
    drain(&mut engine);
    engine
}

#[test]
fn mlow_pcm_survives_a_synthetic_minute_through_the_actual_call_engines() {
    let mut recv_config = config();
    recv_config.audio = AudioConfig::MLOW_PCM;
    let mut send_config = recv_config.clone();
    send_config.self_lid = PEER.into();
    send_config.peer_lid = OWN.into();
    send_config.ssrc = 23;
    let mut sender = allocated_with(send_config);
    let mut receiver = allocated_with(recv_config);
    let mut produced = 0;
    for n in 0..1200u64 {
        let samples: Vec<i16> = (0..960)
            .map(|i| {
                (8000.0 * ((n * 960 + i) as f64 * 440.0 * std::f64::consts::TAU / 16000.0).sin())
                    as i16
            })
            .collect();
        sender.handle_input(n * 60 + 1, Input::MicFrame(&samples));
        for output in drain(&mut sender) {
            if let Output::Transmit(packet) = output {
                receiver.handle_input(n * 60 + 2, Input::RelayPacket(&packet));
            }
        }
        // PCM playout runs every 20 ms, even though each network packet spans 60 ms.
        for tick in 0..3 {
            receiver.handle_input(n * 60 + 3 + tick * 20, Input::Timeout);
            for output in drain(&mut receiver) {
                if let Output::Playout(pcm) = output {
                    produced += pcm.len();
                }
            }
        }
    }
    let stats = receiver.media_stats();
    assert!(stats.rtp_received >= 1190, "{stats:?}");
    assert_eq!(stats.srtp_unprotect_failed, 0);
    assert_eq!(stats.playout_trimmed_samples, 0);
    assert!(
        produced >= 16000 * 60,
        "decoded only {produced} PCM samples: {stats:?}"
    );
}

#[test]
fn three_minutes_of_synthetic_opus_authenticate_and_decode_without_missing_frames() {
    let mut engine = allocated();
    let mut sender = MediaPipeline::new(&MediaPipelineParams {
        call_key: &KEY,
        self_lid: PEER,
        peer_lid: OWN,
        ssrc: 23,
        samples_per_packet: 960,
        warp_mi_tag_len: 4,
    })
    .unwrap();
    assert!(sender.set_audio_payload_type(AudioFormat::OPUS_16KHZ_60MS.rtp_payload_type));
    sender.set_audio_mlow_profile(false);
    let mut encoder = WaOpusEncoder::new_resilient().unwrap();
    let mut decoder = WaOpusDecoder::new().unwrap();
    let mut frames = 0;
    for n in 0..3000u64 {
        let samples: Vec<i16> = (0..960)
            .map(|i| {
                (8000.0 * ((n * 960 + i) as f64 * 440.0 * std::f64::consts::TAU / 16000.0).sin())
                    as i16
            })
            .collect();
        let encoded = encoder.encode(&samples).unwrap();
        let packet = sender.protect_audio(&encoded);
        engine.handle_input(n * 60 + 1, Input::RelayPacket(&packet));
        for output in drain(&mut engine) {
            if let Output::EncodedAudio(frame) = output {
                let pcm = decoder.decode(&frame.data).unwrap();
                assert_eq!(pcm.len(), 960);
                if n > 10 {
                    assert!(pcm.iter().any(|sample| sample.unsigned_abs() > 500));
                }
                frames += 1;
            }
        }
    }
    assert_eq!(frames, 3000);
    assert_eq!(engine.media_stats().rtp_received, 3000);
}

#[test]
fn answering_device_identity_is_required_for_srtp_keys() {
    let mut sender = MediaPipeline::new(&MediaPipelineParams {
        call_key: &KEY,
        self_lid: PEER,
        peer_lid: OWN,
        ssrc: 23,
        samples_per_packet: 960,
        warp_mi_tag_len: 4,
    })
    .unwrap();
    let packet = sender.protect_audio(&[1, 2, 3, 4]);
    let mut wrong = MediaPipeline::new(&MediaPipelineParams {
        call_key: &KEY,
        self_lid: OWN,
        peer_lid: "222222222@lid",
        ssrc: 17,
        samples_per_packet: 960,
        warp_mi_tag_len: 4,
    })
    .unwrap();
    assert!(wrong.unprotect_audio(&packet).is_none());
    assert!(wrong.rekey_recv(&KEY, PEER));
    assert!(wrong.unprotect_audio(&packet).is_some());
}
