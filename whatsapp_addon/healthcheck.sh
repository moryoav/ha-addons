#!/bin/sh

# Docker health probe with privacy-safe, persistent failure diagnostics.
# The pending file is JSON Lines. Each line is a complete schema-1 failure or
# recovery record and contains no response body, URL, headers, or identifiers.

set -u
set -f

umask 077
export LC_ALL=C

health_url=${HA_HEALTH_URL:-http://127.0.0.1:3000/health}
curl_bin=${HA_HEALTH_CURL_BIN:-curl}
pending_file=${HA_HEALTH_FAILURE_PATH:-/data/healthcheck-failures.pending}
state_file=${HA_HEALTH_STATE_PATH:-/data/healthcheck-state}
heartbeat_file=${HA_RUNTIME_HEARTBEAT_PATH:-/tmp/whatsapp-runtime-heartbeat.json}
log_target=${HA_HEALTH_LOG_TARGET:-/proc/1/fd/2}
max_records=${HA_HEALTH_MAX_RECORDS:-50}

case "$max_records" in
  '' | *[!0-9]* | ????*) max_records=50 ;;
esac
if [ "$max_records" -lt 1 ] || [ "$max_records" -gt 200 ]; then
  max_records=50
fi

is_unsigned_integer() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_safe_decimal() {
  case "$1" in
    '' | *[!0-9.]* | *.*.* | .* | *.) return 1 ;;
    *) return 0 ;;
  esac
}

seconds_to_ms() {
  seconds_value=$1
  if ! is_safe_decimal "$seconds_value"; then
    printf '0\n'
    return
  fi

  awk -v value="$seconds_value" 'BEGIN {
    milliseconds = value * 1000
    if (value > 0 && milliseconds < 1) milliseconds = 1
    if (milliseconds < 0 || milliseconds > 600000) milliseconds = 0
    printf "%.0f\n", milliseconds
  }'
}

read_streak() {
  saved_streak=0
  if [ -f "$state_file" ]; then
    IFS= read -r saved_streak < "$state_file" || saved_streak=0
  fi
  if ! is_unsigned_integer "$saved_streak" || [ "${#saved_streak}" -gt 6 ]; then
    saved_streak=0
  fi
  printf '%s\n' "$saved_streak"
}

write_streak() {
  streak_value=$1
  state_dir=$(dirname "$state_file")
  state_temp="${state_file}.tmp.$$"
  mkdir -p "$state_dir" 2>/dev/null || return 1
  if ! printf '%s\n' "$streak_value" > "$state_temp"; then
    rm -f "$state_temp"
    return 1
  fi
  if ! mv -f "$state_temp" "$state_file"; then
    rm -f "$state_temp"
    return 1
  fi
}

append_record() {
  record_value=$1
  pending_dir=$(dirname "$pending_file")
  pending_temp="${pending_file}.tmp.$$"
  keep_records=$((max_records - 1))

  mkdir -p "$pending_dir" 2>/dev/null || return 1
  if ! {
    if [ "$keep_records" -gt 0 ] && [ -f "$pending_file" ]; then
      tail -n "$keep_records" "$pending_file" 2>/dev/null || :
    fi
    printf '%s\n' "$record_value"
  } > "$pending_temp"; then
    rm -f "$pending_temp"
    return 1
  fi
  if ! mv -f "$pending_temp" "$pending_file"; then
    rm -f "$pending_temp"
    return 1
  fi
}

emit_record() {
  record_value=$1
  printf '%s\n' "$record_value" >&2
  if [ -n "$log_target" ]; then
    { printf '%s\n' "$record_value" > "$log_target"; } 2>/dev/null || :
  fi
}

extract_heartbeat_number() {
  heartbeat_key=$1
  [ -f "$heartbeat_file" ] || return 1
  sed -n \
    "s/.*\"${heartbeat_key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\(\.[0-9][0-9]*\)\?\)[[:space:]]*[,}].*/\1/p" \
    "$heartbeat_file" 2>/dev/null | head -n 1
}

add_heartbeat_number() {
  heartbeat_key=$1
  heartbeat_max=$2
  heartbeat_value=$(extract_heartbeat_number "$heartbeat_key")
  if ! is_safe_decimal "$heartbeat_value" || [ "${#heartbeat_value}" -gt 16 ]; then
    return
  fi
  if ! awk -v value="$heartbeat_value" -v maximum="$heartbeat_max" \
    'BEGIN { exit !(value >= 0 && value <= maximum) }'; then
    return
  fi
  heartbeat_fields="${heartbeat_fields},\"${heartbeat_key}\":${heartbeat_value}"
}

build_heartbeat_fields() {
  heartbeat_fields=
  heartbeat_updated_at=$(extract_heartbeat_number updated_at_ms)
  now_seconds=$(date -u +%s 2>/dev/null || printf '0')
  if is_unsigned_integer "$heartbeat_updated_at" &&
    is_unsigned_integer "$now_seconds" &&
    [ "${#heartbeat_updated_at}" -le 16 ] &&
    [ "${#now_seconds}" -le 12 ]; then
    now_milliseconds=$((now_seconds * 1000))
    if [ "$heartbeat_updated_at" -ge "$now_milliseconds" ]; then
      heartbeat_age=0
    else
      heartbeat_age=$((now_milliseconds - heartbeat_updated_at))
    fi
    if [ "$heartbeat_age" -le 86400000 ]; then
      heartbeat_fields=",\"heartbeat_age_ms\":${heartbeat_age}"
    fi
  fi

  [ -n "$heartbeat_fields" ] || return
  add_heartbeat_number event_loop_lag_ms 3600000
  add_heartbeat_number event_loop_lag_max_ms 3600000
  add_heartbeat_number rss_mb 1048576
  add_heartbeat_number heap_used_mb 1048576
  add_heartbeat_number cpu_pct 10000
  add_heartbeat_number event_loop_utilization_pct 100
  add_heartbeat_number container_cpu_pct 10000
  add_heartbeat_number container_memory_mb 1048576
  add_heartbeat_number container_memory_limit_mb 1048576
  add_heartbeat_number container_memory_pct 10000
  add_heartbeat_number cpu_throttled_ms 86400000
  add_heartbeat_number oom_events 1000000000
}

classify_failure() {
  case "$curl_exit" in
    5 | 6) printf 'dns_failed\n' ;;
    7) printf 'connection_failed\n' ;;
    22) printf 'http_error\n' ;;
    28)
      if [ "$time_connect_ms" -eq 0 ]; then
        printf 'connect_timeout\n'
      elif [ "$time_starttransfer_ms" -eq 0 ]; then
        printf 'response_timeout\n'
      else
        printf 'transfer_timeout\n'
      fi
      ;;
    52) printf 'empty_response\n' ;;
    56) printf 'connection_reset\n' ;;
    127) printf 'curl_unavailable\n' ;;
    *) printf 'curl_error\n' ;;
  esac
}

curl_metrics=$("$curl_bin" \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  --max-time 5 \
  --header 'X-HA-Healthcheck: docker' \
  --write-out '%{http_code} %{time_connect} %{time_starttransfer} %{time_total}' \
  "$health_url" 2>/dev/null)
curl_exit=$?

http_code=000
time_connect=0
time_starttransfer=0
time_total=0
IFS=' ' read -r http_code time_connect time_starttransfer time_total <<EOF
$curl_metrics
EOF

case "$http_code" in
  [0-9][0-9][0-9]) ;;
  *) http_code=000 ;;
esac
if [ "$http_code" = 000 ] || [ "$http_code" -gt 599 ]; then
  http_code_number=0
else
  http_code_number=$http_code
fi
if ! is_unsigned_integer "$curl_exit" || [ "$curl_exit" -gt 255 ]; then
  curl_exit=255
fi

time_connect_ms=$(seconds_to_ms "$time_connect")
time_starttransfer_ms=$(seconds_to_ms "$time_starttransfer")
time_total_ms=$(seconds_to_ms "$time_total")
timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
build_heartbeat_fields

case "$http_code" in
  2[0-9][0-9]) http_ok=true ;;
  *) http_ok=false ;;
esac

if [ "$curl_exit" -eq 0 ] && [ "$http_ok" = true ]; then
  prior_streak=$(read_streak)
  if [ "$prior_streak" -gt 0 ]; then
    recovery_record="{\"schema\":1,\"type\":\"recovery\",\"timestamp\":\"${timestamp}\",\"prior_streak\":${prior_streak},\"time_total_ms\":${time_total_ms}${heartbeat_fields}}"
    append_record "$recovery_record" || :
    emit_record "$recovery_record"
    rm -f "$state_file"
  fi
  exit 0
fi

if [ "$curl_exit" -eq 0 ]; then
  curl_exit=22
fi
classification=$(classify_failure)
prior_streak=$(read_streak)
if [ "$prior_streak" -ge 10000 ]; then
  streak=10000
else
  streak=$((prior_streak + 1))
fi
failure_record="{\"schema\":1,\"type\":\"failure\",\"timestamp\":\"${timestamp}\",\"classification\":\"${classification}\",\"curl_exit\":${curl_exit},\"http_code\":${http_code_number},\"time_connect_ms\":${time_connect_ms},\"time_starttransfer_ms\":${time_starttransfer_ms},\"time_total_ms\":${time_total_ms},\"streak\":${streak}${heartbeat_fields}}"
append_record "$failure_record" || :
write_streak "$streak" || :
emit_record "$failure_record"
exit 1
