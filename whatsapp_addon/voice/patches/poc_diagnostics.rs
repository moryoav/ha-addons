use std::sync::{OnceLock, atomic::{AtomicU64, Ordering}};
use std::time::Instant;
use bytes::Bytes;
use super::{RelayPacketKind, classify_relay_packet};

static ORIGIN: OnceLock<Instant> = OnceLock::new();
static QUEUED_RTP: AtomicU64 = AtomicU64::new(0);
static SUBMITTED_RTP: AtomicU64 = AtomicU64::new(0);
static QUEUE_FULL: AtomicU64 = AtomicU64::new(0);
static QUEUE_CLOSED: AtomicU64 = AtomicU64::new(0);
static QUEUE_DEPTH: AtomicU64 = AtomicU64::new(0);
static QUEUE_WAIT_US: AtomicU64 = AtomicU64::new(0);
static UDP_SENT: AtomicU64 = AtomicU64::new(0);
static UDP_ERRORS: AtomicU64 = AtomicU64::new(0);
static LAST_RTP_US: AtomicU64 = AtomicU64::new(0);
static RTP_GAP_US: AtomicU64 = AtomicU64::new(0);
static RTP_GAPS_OVER_120: AtomicU64 = AtomicU64::new(0);
static SCTP_BUFFERED: AtomicU64 = AtomicU64::new(0);
static SCTP_PEAK_BUFFERED: AtomicU64 = AtomicU64::new(0);
static SCTP_RTO_US: AtomicU64 = AtomicU64::new(0);
static SCTP_T3: AtomicU64 = AtomicU64::new(0);
static SCTP_FAST_RETRANS: AtomicU64 = AtomicU64::new(0);
static OUT_CHUNKS: [AtomicU64; 256] = [const { AtomicU64::new(0) }; 256];
static IN_CHUNKS: [AtomicU64; 256] = [const { AtomicU64::new(0) }; 256];

fn now_us() -> u64 { ORIGIN.get_or_init(Instant::now).elapsed().as_micros() as u64 + 1 }

pub fn reset_relay_diagnostics() {
    for counter in [&QUEUED_RTP, &SUBMITTED_RTP, &QUEUE_FULL, &QUEUE_CLOSED, &QUEUE_DEPTH,
        &QUEUE_WAIT_US, &UDP_SENT, &UDP_ERRORS, &LAST_RTP_US, &RTP_GAP_US, &RTP_GAPS_OVER_120,
        &SCTP_BUFFERED, &SCTP_PEAK_BUFFERED, &SCTP_RTO_US, &SCTP_T3, &SCTP_FAST_RETRANS] {
        counter.store(0, Ordering::Relaxed);
    }
    for counter in OUT_CHUNKS.iter().chain(IN_CHUNKS.iter()) { counter.store(0, Ordering::Relaxed); }
}

pub fn relay_diagnostics() -> serde_json::Value {
    let read = |c: &AtomicU64| c.load(Ordering::Relaxed);
    serde_json::json!({
        "queued_rtp_packets":read(&QUEUED_RTP), "submitted_rtp_packets":read(&SUBMITTED_RTP),
        "native_queue_full_waits":read(&QUEUE_FULL), "native_queue_closed_errors":read(&QUEUE_CLOSED),
        "max_native_queue_depth":read(&QUEUE_DEPTH), "max_native_queue_wait_ms":read(&QUEUE_WAIT_US) as f64 / 1000.0,
        "udp_datagrams_sent":read(&UDP_SENT), "udp_send_errors":read(&UDP_ERRORS),
        "max_rtp_submit_gap_ms":read(&RTP_GAP_US) as f64 / 1000.0,
        "rtp_submit_gaps_over_120_ms":read(&RTP_GAPS_OVER_120),
        "sctp_buffered_bytes":read(&SCTP_BUFFERED), "peak_sctp_buffered_bytes":read(&SCTP_PEAK_BUFFERED),
        "sctp_retransmit_timeout_ms":read(&SCTP_RTO_US) as f64 / 1000.0,
        "sctp_retransmission_timeouts":read(&SCTP_T3), "sctp_fast_retransmissions":read(&SCTP_FAST_RETRANS),
        "outgoing_sctp_chunks": {"data":read(&OUT_CHUNKS[0]), "sack":read(&OUT_CHUNKS[3]),
            "heartbeat":read(&OUT_CHUNKS[4]), "heartbeat_ack":read(&OUT_CHUNKS[5]), "forward_tsn":read(&OUT_CHUNKS[192])},
        "incoming_sctp_chunks": {"data":read(&IN_CHUNKS[0]), "sack":read(&IN_CHUNKS[3]),
            "heartbeat":read(&IN_CHUNKS[4]), "heartbeat_ack":read(&IN_CHUNKS[5]), "forward_tsn":read(&IN_CHUNKS[192])}
    })
}

pub async fn queue_relay_packet(outbound: &async_channel::Sender<Bytes>, data: Bytes) -> anyhow::Result<()> {
    let rtp = classify_relay_packet(&data) == RelayPacketKind::Rtp;
    match outbound.try_send(data) {
        Ok(()) => {},
        Err(async_channel::TrySendError::Full(data)) => {
            QUEUE_FULL.fetch_add(1, Ordering::Relaxed);
            let started = Instant::now();
            // The call driver already sends through a separate future. Waiting here preserves
            // that packet without stopping its timer, receive, or lifecycle branches.
            if outbound.send(data).await.is_err() {
                QUEUE_CLOSED.fetch_add(1, Ordering::Relaxed);
                anyhow::bail!("relay media channel closed");
            }
            QUEUE_WAIT_US.fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        },
        Err(async_channel::TrySendError::Closed(_)) => {
            QUEUE_CLOSED.fetch_add(1, Ordering::Relaxed);
            anyhow::bail!("relay media channel closed");
        },
    }
    if rtp { QUEUED_RTP.fetch_add(1, Ordering::Relaxed); }
    QUEUE_DEPTH.fetch_max(outbound.len() as u64, Ordering::Relaxed);
    Ok(())
}

pub(super) fn submitted(data: &Bytes) {
    if classify_relay_packet(data) != RelayPacketKind::Rtp { return; }
    SUBMITTED_RTP.fetch_add(1, Ordering::Relaxed);
    let now = now_us();
    let last = LAST_RTP_US.swap(now, Ordering::Relaxed);
    if last != 0 {
        let gap = now.saturating_sub(last);
        RTP_GAP_US.fetch_max(gap, Ordering::Relaxed);
        if gap > 120_000 { RTP_GAPS_OVER_120.fetch_add(1, Ordering::Relaxed); }
    }
}

pub(super) fn udp_sent() { UDP_SENT.fetch_add(1, Ordering::Relaxed); }
pub(super) fn udp_error() { UDP_ERRORS.fetch_add(1, Ordering::Relaxed); }
pub(super) fn sctp_packet(packet: &[u8], outbound: bool) {
    let counters = if outbound { &OUT_CHUNKS } else { &IN_CHUNKS };
    let mut at = 12; // SCTP common header; count chunk types, never inspect audio payloads.
    while at + 4 <= packet.len() {
        let size = u16::from_be_bytes([packet[at + 2], packet[at + 3]]) as usize;
        if size < 4 || at + size > packet.len() { break; }
        counters[packet[at] as usize].fetch_add(1, Ordering::Relaxed);
        at += (size + 3) & !3;
    }
}
pub(super) fn sctp_state(association: &mut rtc_sctp::Association, stream_id: rtc_sctp::StreamId) {
    let mut stats = association.stats();
    SCTP_T3.store(stats.get_num_t3timeouts(), Ordering::Relaxed);
    SCTP_FAST_RETRANS.store(stats.get_num_fast_retrans(), Ordering::Relaxed);
    // Despite its name, rtc-sctp rtt() currently returns rto_mgr.get_rto().
    SCTP_RTO_US.store(association.rtt().as_micros() as u64, Ordering::Relaxed);
    if let Ok(stream) = association.stream(stream_id)
        && let Ok(buffered) = stream.buffered_amount() {
        SCTP_BUFFERED.store(buffered as u64, Ordering::Relaxed);
        SCTP_PEAK_BUFFERED.fetch_max(buffered as u64, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_full_native_queue_preserves_the_next_packet() {
        let (tx, rx) = async_channel::bounded(1);
        tx.send(Bytes::from_static(b"first")).await.unwrap();
        let sender = tokio::spawn(async move { queue_relay_packet(&tx, Bytes::from_static(b"second")).await });
        tokio::task::yield_now().await;
        assert!(!sender.is_finished(), "Full queue must wait instead of silently discarding");
        assert_eq!(rx.recv().await.unwrap().as_ref(), b"first");
        sender.await.unwrap().unwrap();
        assert_eq!(rx.recv().await.unwrap().as_ref(), b"second");
    }

    #[tokio::test]
    async fn a_closed_native_queue_is_an_error() {
        let (tx, rx) = async_channel::bounded(1);
        drop(rx);
        assert!(queue_relay_packet(&tx, Bytes::from_static(b"packet")).await.is_err());
    }
}
