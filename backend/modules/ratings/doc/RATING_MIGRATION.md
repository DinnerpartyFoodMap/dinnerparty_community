# Rating migration integration

The private Node service retains the legacy operations and adds `ratingestimate`, `ratingpredict`, and `listrank`. The public backend owns sources, permissions, source expiry, and response projection. Do not deploy the backend independently of its paired private service.

## Current switches

- `RATING_ESTIMATE_MODE=shadow` and `RATING_PREDICTION_MODE=shadow` enable additive experimental results. Default is off. The initial neutral prior and m=3 are a test configuration, deliberately incapable of active publication; an independently validated immutable configuration and activation flow are still required.
- `RATING_LIST_RANK_MODE=shadow` exercises the new list operation. No learned choice scores or bonuses are fabricated. Existing ranking remains active until a validated local model and bonus configuration are available.
- `PLACE_VISIT_MODE=trial` with comma-separated `PLACE_VISIT_TRIAL_USERS` enables a limited cohort; `active` enables feedback-consenting users. Default is off. Inference still requires existing precise OS permission; the sampler does not request new permission automatically.

The prepared UI displays two scores: public estimate and the person's predicted rating. The hidden ranking score must never overwrite either displayed score. A cold-start prediction is unavailable, not a claimed personalized result. Existing API fields retain their original meaning for old clients; map avoidance reads legacy business fields independently of display selection.

## Visits

Foreground detail exposure for at least 800ms records a viewed candidate. New, non-IP GCJ-02 fixes with accuracy at most 25m are sampled every 60 seconds. A qualifying run requires at least 11 distinct samples, strictly more than ten minutes, no gap above 90 seconds, and distance plus accuracy at most 50m. Backgrounding, missing permission, a changed marker geometry, or ambiguous neighboring viewed stores prevents confirmation. The observation window is bounded to fifteen minutes.

The result is a client location inference, not trusted GPS attestation. It triggers the existing-style “visited / not visited / later” invitation. Only an explicit answer confirms a self-reported visit, and only a separate submitted rating creates a vote. Raw location sequences remain ephemeral on the device. Inferred and answered visits enter separate event kinds; unavailable evidence remains unknown.

## Retention

New-policy behavior and decisions expire 90 days after their source time. Existing packages retain their original absolute expiry; old grants retain their old purpose/expiry limits. Re-exporting does not renew data. The original 180-day profile read window and 30-day decay half-life are different concepts. Clear/opt-out deletes visit state and invalidates research eligibility.

## Verification

Run private `npm test`, then its `node scripts/run_backend_tests.js` driver for backend tests. Backend `test:rating-migration` and `test:visits` cover the new boundaries. Frontend `npm test` and build cover shared Web/iOS bridge rendering. Windows validation does not replace an Xcode build, physical-device location checks, or production rollout.

Next evidence work: authorized local source audit, forward rating validation, real-exposure model training, immutable model activation, and visit false-positive/coverage measurement. No public research model weights are deployed by this integration.
