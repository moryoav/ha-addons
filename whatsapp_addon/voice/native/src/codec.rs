//! The direct-call libopus adapter installed by whatsapp-rust's resident backend.
//! Kept here because that backend's adapter is private and its lifecycle owns a Client.
use anyhow::Result;
use whatsapp_rust::{
    voip::audio::{WaOpusDecoder, WaOpusEncoder},
    wacore::voip::audio::{ForeignAudioCodec, ForeignCodecError},
};

pub struct PlatformOpus {
    decoder: WaOpusDecoder,
    encoder: WaOpusEncoder,
}

impl PlatformOpus {
    pub fn new() -> Result<Self> {
        Ok(Self {
            decoder: WaOpusDecoder::new()?,
            encoder: WaOpusEncoder::new_resilient()?,
        })
    }
}

impl ForeignAudioCodec for PlatformOpus {
    fn decode(&mut self, payload: &[u8], out: &mut Vec<i16>) -> Result<(), ForeignCodecError> {
        out.extend_from_slice(
            self.decoder
                .decode(payload)
                .map_err(|_| ForeignCodecError::InvalidPayload)?,
        );
        Ok(())
    }
    fn conceal(&mut self, samples: usize, out: &mut Vec<i16>) {
        out.resize(out.len() + samples, 0);
    }
    fn encode(&mut self, pcm: &[i16], out: &mut Vec<u8>) -> Result<(), ForeignCodecError> {
        out.extend_from_slice(
            &self
                .encoder
                .encode(pcm)
                .map_err(|_| ForeignCodecError::BadFrameSize)?,
        );
        Ok(())
    }
}
