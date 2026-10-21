"""Apply small, guarded changes to the exact pinned build dependency, outside runtime data."""
from pathlib import Path
import hashlib
import shutil
import sys


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError("Pinned source patch anchor does not match exactly once")
    return text.replace(before, after, 1)


def apply(root):
    native_path = root / "src/voip/transport/native.rs"
    audio_path = root / "src/voip/audio.rs"
    native = native_path.read_text(encoding="utf-8")
    audio = audio_path.read_text(encoding="utf-8")
    expected = {
        "native": "4b175b1cb08768f1279f5df4173a7235ac704c7f44c6aa2f721f8afe7cb683c2",
        "audio": "5e7e3b6a885dd3ecf0945b2f6e97a6576eb94ad3e862a689ea7fd94ca63755bd",
    }
    for name, value in (("native", native), ("audio", audio)):
        if hashlib.sha256(value.encode()).hexdigest() != expected[name]:
            raise RuntimeError("Dependency source differs from the pinned revision: " + name)
    native = replace_once(native, "use std::time::Instant;", """use std::time::Instant;
mod poc_diagnostics { include!("poc_diagnostics.rs"); }
pub use poc_diagnostics::{relay_diagnostics, reset_relay_diagnostics, queue_relay_packet};""")
    start = native.index("        match self.outbound.try_send(data) {")
    end = native.index("\n    async fn disconnect(&self)", start)
    native = native[:start] + "        poc_diagnostics::queue_relay_packet(&self.outbound, data).await\n    }\n" + native[end:]
    native = replace_once(native, "Ok(packet) => stack.write_media(now(), &packet),", """Ok(packet) => {
                    let result = stack.write_media(now(), &packet);
                    if result.is_ok() { poc_diagnostics::submitted(&packet); }
                    result
                },""")
    native = replace_once(native, "if let Err(e) = socket.send(&datagram).await {", """if let Err(e) = socket.send(&datagram).await {
                poc_diagnostics::udp_error();""")
    native = replace_once(native, """                finish(&events, &open, announced, dropped_inbound, reason).await;
                return;
            }
        }
        while let Some(packet) = stack.poll_inbound()""", """                finish(&events, &open, announced, dropped_inbound, reason).await;
                return;
            }
            poc_diagnostics::udp_sent();
        }
        while let Some(packet) = stack.poll_inbound()""")
    native = replace_once(native, """        if let Some(e) = ended {
            *stopped = true;""", """        poc_diagnostics::sctp_state(association, MEDIA_STREAM_ID);
        if let Some(e) = ended {
            *stopped = true;""")
    native = replace_once(native, """    fn feed_association(&mut self, now: Instant, packet: Bytes) {
        let Self""", """    fn feed_association(&mut self, now: Instant, packet: Bytes) {
        poc_diagnostics::sctp_packet(&packet, false);
        let Self""")
    native = replace_once(native, """                for packet in packets {
                    dtls.write""", """                for packet in packets {
                    poc_diagnostics::sctp_packet(&packet, true);
                    dtls.write""")
    audio = replace_once(audio, "    /// Configure libopus for the standard-Opus escape", """    /// Standard Opus with in-band repair data for a lossy voice link.
    pub fn new_resilient() -> Result<Self> {
        let mut encoder = Self::new()?;
        encoder.enc.set_inband_fec(true)
            .map_err(|e| anyhow!("opus set_inband_fec: {e}"))?;
        encoder.enc.set_packet_loss_perc(10)
            .map_err(|e| anyhow!("opus set_packet_loss_perc: {e}"))?;
        Ok(encoder)
    }

    /// Configure libopus for the standard-Opus escape""")
    native_path.write_text(native, encoding="utf-8", newline="\n")
    audio_path.write_text(audio, encoding="utf-8", newline="\n")
    shutil.copyfile(Path(__file__).with_name("poc_diagnostics.rs"), native_path.with_name("poc_diagnostics.rs"))
    print("Applied guarded relay diagnostics, queue preservation, and Opus repair changes")


if __name__ == "__main__":
    if len(sys.argv) == 2:
        apply(Path(sys.argv[1]))
    else:
        roots = list(Path("/usr/local/cargo/git/checkouts").glob("*/0dc38af*"))
        roots = [p for p in roots if (p / "src/voip/transport/native.rs").is_file()]
        if len(roots) != 1:
            raise RuntimeError("Expected one pinned WhatsApp dependency checkout")
        apply(roots[0])
