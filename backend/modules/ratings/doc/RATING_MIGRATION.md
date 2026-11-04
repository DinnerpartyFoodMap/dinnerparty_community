# Rating migration integration

The private Node service retains the legacy operations and adds `ratingestimate`, `ratingpredict`, and `listrank`. The public backend owns sources, permissions, source expiry, and response projection. Do not deploy the backend independently of its paired private service.

Bootstrap package implementation: private `main` commit `5a59ce7`. This repository contains the backend/UI integration; the private repository contains the models and offline trainer.

Current main extends this to `research-full-nonchain-v2`, preferred by the private service when its complete manifest is present. It adds the full non-chain P93 ranking family, pooled personal-rating model, P98 public rater correction and selected P86 risk tiers. The original bootstrap remains available through an explicitly selected model directory. See [full model integration](FULL_NONCHAIN.md) for feature/profile/encoder setup and evaluation boundaries.

Current source policy `retained-ratings-v2` retains persisted migration and creation defaults in public estimates and preference histories. It preserves withdrawals and ban exclusions. Map/detail display keeps the existing aggregate when an active estimate has no usable score, so model eligibility changes do not erase existing ratings from the UI. Six-axis presentation uses one point style and shared preference wording, without source badges or inference explanations.

## Current switches

- The paired private service packages `models/research-bootstrap-v1`: actual trained rating, low-tail risk, and choice trees. The backend activates a valid advertised immutable bundle by default. `RATING_ESTIMATE_MODE`, `RATING_PREDICTION_MODE`, `RATING_LIST_RANK_MODE`, and `RATING_RANDOM_RANK_MODE` support `active`, `shadow`, and `off`; explicit `off` restores the corresponding legacy path. Missing or incompatible capabilities retain the legacy path. A bootstrap result is published only with the matching model version/hash. A corrupt package disables bootstrap capability while preserving legacy private operations.
- Active public estimates use the trained rating model. Active individual predictions add the viewer's shrunk historical residual to an estimate computed without that viewer. Zero-vote public estimates remain unavailable. Personal cold starts remain unavailable in the UI.
- List ranking uses the complete filtered candidate set before pagination. The choice model's first five ranks receive internal bonuses `0.30 / 0.24 / 0.18 / 0.12 / 0.06`. These are product configuration, not a measured uplift. Random recommendation uses learned choice weights with at least 20% base exploration after cooldown. Pagination snapshots bind model identity and mode as well as data revision.
- The separate risk model adds a low-score risk hint on Web and iOS when its development-calibrated threshold is crossed. It does not overwrite either displayed score or permanently mark a store as avoided.
- `PLACE_VISIT_MODE=trial` with comma-separated `PLACE_VISIT_TRIAL_USERS` enables a limited cohort; `active` enables feedback-consenting users. Default is off. Inference still requires existing precise OS permission; the sampler does not request new permission automatically.

The prepared UI displays two scores: public estimate and the person's predicted rating. The hidden ranking score must never overwrite either displayed score. A cold-start prediction is unavailable, not a claimed personalized result. Existing API fields retain their original meaning for old clients; map avoidance reads legacy business fields independently of display selection.

## Visits

Foreground detail exposure for at least 800ms records a viewed candidate. New, non-IP GCJ-02 fixes with accuracy at most 25m are sampled every 60 seconds. A qualifying run requires at least 11 distinct samples, strictly more than ten minutes, no gap above 90 seconds, and distance plus accuracy at most 50m. Backgrounding, missing permission, a changed marker geometry, or ambiguous neighboring viewed stores prevents confirmation. The observation window is bounded to fifteen minutes.

The result is a client location inference, not trusted GPS attestation. It triggers the existing-style “visited / not visited / later” invitation. Only an explicit answer confirms a self-reported visit, and only a separate submitted rating creates a vote. Raw location sequences remain ephemeral on the device. Inferred and answered visits enter separate event kinds; unavailable evidence remains unknown.

## Retention

New-policy behavior and decisions expire 90 days after their source time. Existing packages retain their original absolute expiry; old grants retain their old purpose/expiry limits. Re-exporting does not renew data. The original 180-day profile read window and 30-day decay half-life are different concepts. Clear/opt-out deletes visit state and invalidates research eligibility.

## Verification

Run private `npm test`, then its `node scripts/run_backend_tests.js` driver for backend tests. Backend `test:rating-migration` and `test:visits` cover the new boundaries. Frontend `npm test` and build cover shared Web/iOS bridge rendering. Windows validation does not replace an Xcode build, physical-device location checks, or production rollout.

## Bootstrap scope and replacement

Python is used only for offline training; the online private service remains Node. Tree JSONs have SHA256 checks, a fixed feature order, explicit missing-value routing, and numerical parity fixtures. Set the private service's `RECOMMENDATION_MODEL_DIR` to another complete bundle and restart it to replace the model package. Deploy private service first, then its paired backend; inspect the advertised model identity before enabling clients.

This first package uses only the already-seen Google research development data. Yelp and sealed/test/confirmation data are excluded. The manifest records source hashes and unverified Google source licensing; it does not grant commercial rights. No raw public-user IDs, review text or original records are included in the deployment package.

The portable models use rating distributions and product-computable category/history/location summaries. They do not reproduce the full research winner's text embeddings and public-user/item co-occurrence coordinates. Five-star research labels and local four-level ratings use an explicitly versioned linear ordinal normalization; semantic equivalence and local uplift have not been established.

Initial development evaluation: normalized rating RMSE `0.12919`; risk AUC `0.80697`, recall `0.31537` at a threshold calibrated to development FPR `0.04997`; choice top-1 hit `0.192` on 10,000 held-out candidate groups. Risk threshold selection and reported FPR share the same development split, so this is a calibration description, not an independent false-positive guarantee. Choice train/evaluation groups are disjoint, while users/items may overlap. These numbers are not measurements on local product users.

On the same development samples, raw-mean rating RMSE was `0.23193`, and neutral shrinkage with strength 10 was `0.14680` (a comparison baseline, not the legacy product implementation). Choice hit was `0.1783` for popularity, `0.0344` for mean rating and `0.05813` for uniform sampling; the trained choice model was 1.37 percentage points above popularity. These descriptive comparisons do not establish an uplift over the existing product's recommendation policy.

Random decisions now persist the actual model identity and 13-feature candidate snapshots, and both research exporters retain them. This closes the random decision feature-snapshot gap; it does not establish actual traffic volume or label maturity.

The private repository's `docs/BOOTSTRAP_TRAINING.md` defines the six portable Parquet input tables and training command. Once authorized product data is sufficient, create temporal train/evaluation tables with genuine exposed candidate negatives, retrain all three models, validate Python/Node parity, and install the replacement bundle. The training command does not read production databases. A complete product-training exporter, complete list-exposure attribution, navigation/favorite/visit decision links, forward local rating validation and visit false-positive/coverage measurement remain follow-up work; the presence of this research bootstrap does not mean those data have already been collected.
