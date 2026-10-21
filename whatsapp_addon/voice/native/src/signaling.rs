//! Call-only protocol glue. No Client, Bot, Signal store, login, or WhatsApp Web socket.
use crate::wire::{WireNode, decode_bytes};
use anyhow::{Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use whatsapp_rust::{
    Jid,
    wacore::stanza::call::*,
    wacore::types::call::{CallAction, IncomingCall},
};

pub fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .ok_or_else(|| anyhow!("missing_field"))
}
pub fn parse(value: &Value) -> Result<IncomingCall> {
    let wire: WireNode = serde_json::from_value(value.clone())?;
    let node = wire.owned()?;
    parse_call_stanza(node.get())?.ok_or_else(|| anyhow!("unsupported_call_action"))
}

pub fn incoming_opus(call: &IncomingCall, requested_opus: bool) -> bool {
    let capability = call
        .media()
        .and_then(|media| media.peer_device.as_ref())
        .map_or(CapabilityBit::Unknown, |device| {
            capability_bit(
                device.capability_version,
                device.capability(),
                CAPABILITY_INDEX_MLOW_V1,
            )
        });
    requested_opus || !mlow_after_peer_capability(true, capability)
}

pub fn peer(value: &Value) -> Result<Value> {
    let wire: WireNode = serde_json::from_value(
        value
            .get("node")
            .cloned()
            .ok_or_else(|| anyhow!("missing_node"))?,
    )?;
    let owned = wire.owned()?;
    let node = owned.get();
    let call = parse_call_stanza(node)?.ok_or_else(|| anyhow!("unsupported_call_action"))?;
    let audio = match &call.action {
        CallAction::PreAccept { audio, .. } | CallAction::Accept { audio, .. } => audio,
        _ => bail!("not_a_peer_answer"),
    };
    let capability = node
        .children()
        .and_then(|children| {
            children
                .iter()
                .find(|child| child.tag == "preaccept" || child.tag == "accept")
        })
        .and_then(|action| action.get_optional_child("capability"))
        .map_or(CapabilityBit::Unknown, |capability| {
            capability_bit(
                capability
                    .get_attr("ver")
                    .and_then(|version| version.as_str().parse().ok()),
                capability.content_bytes().unwrap_or_default(),
                CAPABILITY_INDEX_MLOW_V1,
            )
        });
    Ok(
        json!({"capability":match capability { CapabilityBit::Set=>"set",CapabilityBit::Clear=>"clear",CapabilityBit::Unknown=>"unknown" },
        "audio_supported":audio.is_empty() || audio.iter().any(|codec| codec.enc.eq_ignore_ascii_case("opus") && codec.rate == 16000)}),
    )
}
pub fn offer(value: &Value) -> Result<Value> {
    let peer: Jid = text(value, "peer_lid")?.parse()?;
    let own: Jid = text(value, "self_lid")?.parse()?;
    let keys = value
        .get("device_keys")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("missing_devices"))?;
    if keys.is_empty() || keys.len() > 64 {
        bail!("invalid_devices");
    }
    let keys = keys
        .iter()
        .map(|key| {
            Ok(OfferDeviceKey {
                device_jid: text(key, "jid")?.parse()?,
                enc_type: text(key, "enc_type")?.to_string(),
                ciphertext: decode_bytes(text(key, "ciphertext")?, 8192)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if keys
        .iter()
        .any(|key| !["msg", "pkmsg"].contains(&key.enc_type.as_str()))
    {
        bail!("invalid_enc_type");
    }
    let identity = value
        .get("device_identity")
        .and_then(Value::as_str)
        .map(|v| decode_bytes(v, 8192))
        .transpose()?;
    if keys.iter().any(|key| key.enc_type == "pkmsg") && identity.is_none() {
        bail!("missing_device_identity");
    }
    let privacy = value
        .get("privacy_token")
        .and_then(Value::as_str)
        .map(|v| decode_bytes(v, 8192))
        .transpose()?;
    let opus = value
        .get("audio_codec")
        .and_then(Value::as_str)
        .unwrap_or("opus")
        == "opus";
    let node = build_offer(&OfferParams {
        call_id: text(value, "call_id")?,
        to: &peer,
        call_creator: &own,
        device_keys: &keys,
        privacy_token: privacy.as_deref(),
        capability: Some(if opus {
            &CAPABILITY_STANDARD_OPUS_OFFER
        } else {
            &CAPABILITY_OFFER
        }),
        device_identity: identity.as_deref(),
        id: Some(text(value, "stanza_id")?),
        multi_device: value
            .get("multi_device")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        video: false,
        audio_rates: &["16000"],
    });
    Ok(json!({"node": WireNode::from_node(&node)}))
}
pub fn prepare(value: &Value) -> Result<Value> {
    let call = parse(value.get("node").ok_or_else(|| anyhow!("missing_node"))?)?;
    let CallAction::Offer {
        call_id,
        call_creator,
        is_video,
        group_jid,
        audio,
        ..
    } = &call.action
    else {
        bail!("not_an_offer");
    };
    if group_jid.is_some() || call.group.is_some() || *is_video {
        bail!("only_direct_audio_supported");
    }
    if !audio.is_empty()
        && !audio
            .iter()
            .any(|codec| codec.enc.eq_ignore_ascii_case("opus") && codec.rate == 16000)
    {
        bail!("unsupported_audio_rate");
    }
    let own: Jid = text(value, "self_lid")?.parse()?;
    let media = call.media().ok_or_else(|| anyhow!("missing_media"))?;
    let enc = media
        .enc_for(Some(&own))
        .ok_or_else(|| anyhow!("missing_device_call_key"))?;
    if enc.version != 2 {
        bail!("unsupported_padding_version");
    }
    let opus = value
        .get("audio_codec")
        .and_then(Value::as_str)
        .unwrap_or("opus")
        == "opus";
    let opus = incoming_opus(&call, opus);
    let preaccept = build_preaccept_with_capability(
        call_id,
        &call.from,
        call_creator,
        text(value, "preaccept_id")?,
        &["16000"],
        if opus {
            &CAPABILITY_STANDARD_OPUS_PREACCEPT
        } else {
            &CAPABILITY_PREACCEPT
        },
        false,
    );
    let accept = build_accept(&AcceptParams {
        call_id,
        to: &call.from,
        id: text(value, "accept_id")?,
        call_creator,
        audio_rates: &["16000"],
        relay_te: None,
        rte: None,
        voip_settings: opus.then(|| standard_opus_voip_settings(false)),
        capability: None,
        video: false,
        peer_abtest_bucket: None,
        peer_abtest_bucket_id_list: None,
    });
    let receipt = build_offer_ack_receipt(&call, Some(&own))
        .as_ref()
        .map(WireNode::from_node);
    Ok(
        json!({"call_id":call_id, "from":call.from.to_string(), "creator":call_creator.to_string(),
        "enc_type":enc.enc_type, "ciphertext":STANDARD.encode(&enc.ciphertext), "version":enc.version,
        "receipt":receipt, "preaccept":WireNode::from_node(&preaccept), "accept":WireNode::from_node(&accept)}),
    )
}
pub fn terminate(value: &Value) -> Result<Value> {
    let peer: Jid = text(value, "to")?.parse()?;
    let creator: Jid = text(value, "creator")?.parse()?;
    let reason = value.get("reason").and_then(Value::as_str);
    if reason.is_some_and(|r| !["accepted_elsewhere", "rejected_elsewhere", "timeout"].contains(&r))
    {
        bail!("invalid_termination_reason");
    }
    let node = build_terminate(&TerminateParams {
        call_id: text(value, "call_id")?,
        to: &peer,
        id: Some(text(value, "stanza_id")?),
        call_creator: &creator,
        reason,
    });
    Ok(json!({"node":WireNode::from_node(&node)}))
}
