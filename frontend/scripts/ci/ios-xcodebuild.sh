#!/usr/bin/env bash
# Only retry transient Swift Package Manager network failures; compilation errors fail immediately.
set -euo pipefail

log_file="${XCODEBUILD_LOG:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/xcodebuild.log}"
mkdir -p "$(dirname "$log_file")"
: > "$log_file"

for attempt in 1 2 3; do
    attempt_log="${log_file%.log}-attempt-${attempt}.log"
    set +e
    xcodebuild "$@" 2>&1 | tee "$attempt_log" | tail -50
    status=${PIPESTATUS[0]}
    set -e
    cat "$attempt_log" >> "$log_file"
    if [ "$status" -eq 0 ]; then exit 0; fi

    echo "::group::xcodebuild errors (attempt $attempt)"
    grep -nE 'error:|The following build commands failed|Command .* failed' "$attempt_log" | head -80 || true
    tail -120 "$attempt_log"
    echo '::endgroup::'

    if [ "$attempt" -lt 3 ] \
        && grep -qiE 'failed downloading|Could not resolve package dependencies|Failed to clone repository|Failed to fetch' "$attempt_log" \
        && grep -qiE 'badResponseStatusCode\((429|500|502|503|504)\)|HTTP[^[:digit:]]*(429|500|502|503|504)|timed out|timeout|Could not resolve host|network connection was lost|connection reset|remote end hung up' "$attempt_log"; then
        echo "::warning::Temporary Swift package download failure; retrying xcodebuild ($attempt/3)."
        sleep "$((attempt * 10))"
    else
        exit "$status"
    fi
done
