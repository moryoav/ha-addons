//! A call-only native worker. Persistent WhatsApp authentication remains entirely in Baileys.
mod codec;
mod media;
#[cfg(test)]
mod offline_media;
mod playback;
mod recording;
mod signaling;
mod wire;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use whatsapp_rust::wacore::voip::driver::PeerAnswer;

fn emit(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, &value);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

async fn command(
    value: &Value,
    active: &mut Option<media::MediaCall>,
    network_allowed: bool,
) -> Result<Value> {
    let action = signaling::text(value, "action")?;
    match action {
        "offer" => signaling::offer(value),
        "prepare" => signaling::prepare(value),
        "peer" => signaling::peer(value),
        "terminate" => signaling::terminate(value),
        "start" => {
            if active.is_some() {
                bail!("call_busy");
            }
            *active = Some(media::MediaCall::start(value, network_allowed).await?);
            Ok(json!({"started":true}))
        }
        "audio" => {
            active
                .as_ref()
                .ok_or_else(|| anyhow!("no_call"))?
                .audio(value)?;
            Ok(Value::Null)
        }
        "flush" => {
            let call = active.as_ref().ok_or_else(|| anyhow!("no_call"))?;
            if signaling::text(value, "call_id")? != call.call_id {
                bail!("stale_call");
            }
            call.playback
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            Ok(Value::Null)
        }
        "answer" => {
            let call = active.as_ref().ok_or_else(|| anyhow!("no_call"))?;
            if signaling::text(value, "call_id")? != call.call_id {
                bail!("stale_call");
            }
            if let Some(recorder) = &call.recording { recorder.enable(); }
            let answer = PeerAnswer::builder()
                .answering_lid(signaling::text(value, "answering_lid")?.to_owned())
                .maybe_audio_codec(match value.get("audio_codec").and_then(Value::as_str) {
                    Some("opus") => Some(whatsapp_rust::wacore::voip::audio::AudioCodec::Opus),
                    Some("mlow") => Some(whatsapp_rust::wacore::voip::audio::AudioCodec::Mlow),
                    None => None,
                    _ => bail!("unsupported_audio_codec"),
                })
                .build();
            call.answer.try_send(answer)?;
            Ok(Value::Null)
        }
        "record" => {
            let call = active.as_ref().ok_or_else(|| anyhow!("no_call"))?;
            if signaling::text(value, "call_id")? != call.call_id { bail!("stale_call"); }
            if let Some(recorder) = &call.recording { recorder.enable(); }
            Ok(Value::Null)
        }
        "stop" => {
            if active.as_ref().is_some_and(|call| {
                value.get("call_id").and_then(Value::as_str) == Some(call.call_id.as_str())
            }) {
                active.take().unwrap().stop().await;
            }
            Ok(json!({"stopped":true}))
        }
        _ => bail!("unknown_command"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let network_allowed = std::env::args().skip(1).any(|arg| arg == "--allow-network");
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(64);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let read = input
                .by_ref()
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut line);
            if !matches!(read, Ok(n) if n > 0) || line.len() > 1024 * 1024 {
                break;
            }
            if let Ok(value) = serde_json::from_slice(&line) {
                if tx.blocking_send(value).is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });
    emit(json!({"type":"ready","protocol":1,"network_allowed":network_allowed}));
    let mut active = None;
    loop {
        tokio::select! {
            value = rx.recv() => {
                let Some(value) = value else { break; };
                let result = command(&value, &mut active, network_allowed).await;
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    match result {
                        Ok(result) => emit(json!({"type":"response","id":id,"ok":true,"result":result})),
                        Err(_) => emit(json!({"type":"response","id":id,"ok":false,"error":"worker_operation_failed"})),
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    if let Some(call) = active.take() {
        call.stop().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn media_start_is_denied_without_explicit_network_flag() {
        let mut active = None;
        assert!(
            command(&json!({"action":"start"}), &mut active, false)
                .await
                .is_err()
        );
        assert!(active.is_none());
    }
    #[tokio::test]
    async fn stale_stop_and_audio_cannot_create_a_call() {
        let mut active = None;
        assert!(
            command(
                &json!({"action":"stop","call_id":"synthetic"}),
                &mut active,
                false
            )
            .await
            .is_ok()
        );
        assert!(
            command(
                &json!({"action":"audio","call_id":"synthetic","data":"AAA="}),
                &mut active,
                false
            )
            .await
            .is_err()
        );
    }
}
