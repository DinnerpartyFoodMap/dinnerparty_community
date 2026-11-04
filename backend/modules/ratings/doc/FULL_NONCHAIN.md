# Full non-chain research models

This migration extends the three product paths beyond the original 6/13-feature bootstrap. Chain identity, brand priors and explicit chain properties are excluded. Google commercial data use is user-confirmed. Published research numbers remain historical evidence; non-chain models have their own recorded development results.

“Non-chain” names the feature ablation, not a restriction to independent restaurants: existing restaurants and ratings are not removed based on ownership. Raw place names remain part of the description text, so text embeddings can still carry implicit name information. No brand registry, chain matching or cross-branch score prior is built.

## Computation and display

- Public scores: local joint additive store quality and rater leniency, with shrinkage and a minimum rater-history requirement. Local users and places are fitted from local ratings; Google user/store parameters are never copied.
- Public grouping uses the known primary restaurant category, matching P98's style-group prior; missing groups use the global prior. The individual-rating feature family separately includes city/category statistics when available. P98 configuration is store strength 10, rater strength 5, group strength 10, 30 iterations and at least 3 ratings for nonzero rater bias. Separately learned prefix-prior strengths are not substituted for these parameters because their labels differ.
- Individual predictions: pooled multi-quarter rating model and P87 historical rating-habit features. The target user's target vote is excluded from consumed prediction features; leniency is not added a second time after the model has used it.
- Choice: P93 candidate-group LambdaRank with public, category, price, attribute, item-item co-visit, description/review profile, embedding and multi-interest features. The selected research arm does not consume SVD features, so no unused factorization is required online.
- Risk: P86 content model without chain features, separately fitted for first-1/3/5-rating prefixes. It predicts later low ratings, not fraudulent review behavior. The independent risk hint retains its existing presentation.

Existing defaults and migrated ratings remain in scores/history. Withdrawals and bans remain effective. Missing review text never becomes a synthetic review or an inferred vote. The UI keeps public estimate and personal prediction; top-five bonuses remain hidden ranking values. Six-axis presentation remains unified and does not show inference provenance or explanations.

## Assets and model identity

The private `research-full-nonchain-v2` directory carries the model files, manifest, feature contract, frozen profile normalization and PCA transforms, provenance and Python numeric fixtures. All inference model files and transforms are fingerprinted. Responses and pagination bind the actual model ID/hash; a same-name package with changed weights cannot silently reuse the previous identity.

The source Qwen3-Embedding-0.6B checkpoint and the product's existing 4B map vectors are different assets. Full-model embeddings use revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`, last-token left-padded L2 pooling and research float16 storage rounding. Description/P93 review inputs use 128 tokens. Model-specific PCA transforms remain frozen; matching dimension alone does not establish compatibility.

`PlaceModelProfile` stores versioned derived assets and input hashes. The background worker processes visible places, retries malformed/failed extraction and rejects writes when content changes during a request. It reads genuine comments for review features. Ranking requests read current matching assets and do not call an LLM or encoder. Original-recipe mean imputation is explicit in the feature contract; raw missing status is retained.

## Deployment

Paired private implementation and frozen package: private `main` commit `1690eb0`.

Deploy the paired private Node model package before the backend. Configure the auxiliary frozen encoder on the private network using the private repository's `workers/README.md`:

- `MODEL_FEATURE_EMBEDDING_URL`: complete internal `/v1/embeddings` endpoint.
- `MODEL_FEATURE_EMBEDDING_TOKEN`: private bearer token, matching the encoder's `FEATURE_EMBEDDING_TOKEN`.
- Existing DeepSeek configuration supplies asynchronous DS/RV profile extraction. No credentials or source user IDs enter the prompt.
- `MODEL_PROFILE_MODE=off` disables profile extraction. Setting all four rating/ranking modes to `off` also stops background extraction during rollback.

No bulk production backfill or deployment is performed by this code change. Without configured profile/encoder services, the contract's missing-feature behavior applies while the existing map aggregate fallback is preserved. Operational validation must check how many current places have ready profiles and matching embeddings; model availability alone does not mean all inputs are populated.

## Four-level adaptation

Research stars and product levels use the declared linear ordinal mapping `native5 = 1 + 4*(local4-1)/3`. Native5 histogram fields use adjacent-bin fractional mass so counts and means are conserved. Variance and threshold features use the actual mapped scores. This is a feature adapter, not a statement that local levels are equivalent to Google stars. For example, the original `>=4` positive-history test selects only local level4 under this mapping. Later native-four-level training can replace this adapter through a new contract/version.

Risk thresholds are calibrated on already-seen development data and do not guarantee the same local false-positive rate. Ratings and recommendation hit rates need forward local evaluation; original Google full-chain improvements cannot be claimed for this non-chain ablation. Sealed test/confirmation data are not opened as part of migration.

## Frozen development result and verification

The full non-chain ranker uses 254 features and 300 LambdaRank trees, trained on 2,421,171 candidate rows (131,390 groups) and evaluated on 2,986,323 rows (161,694 groups). Target-micro first-pick hit with deterministic ascending-ID tie break is 21.9421%; the identical original benchmark identities give 18.0236% without history and 21.9551% for the original full feature reference. This is not the original user-macro/tie-credit metric and must not be compared directly to the 23.24% confirmation headline.

Personal-rating training uses 89,492 examples across 12 quarters and 11,773 development-evaluation examples; native-five-star per-user MSE is 1.02938. Public P98 correction is a separate local fit, not a claim that this personal-rating metric measures the displayed public score.

Matched development risk controls select content without chain features for prefixes 1 and 3; at prefix 5, the leniency-only model has stronger matched-threshold recall and is selected. This is post-hoc development selection, and the old requirement of content improvement at all tiers is not reproduced. Selected operating-point results are in the manifest's `deployed_risk_metrics`; original all-content metrics remain separately recorded.

Verification: actual Python/Node model predictions, all 254 original P93 synthetic-feature columns, P86 prefix/rater/content golden features, synthetic v2 authenticated HTTP integration and actual frozen-pack product regressions. Frozen encoder checks are separate from numerical tree parity because CPU/GPU arithmetic can differ. No production backfill, container build, Xcode build or server rollout is claimed.

The private `scripts/train_full_feature_tables.py` provides a standalone own-data retraining entry. It uses only a frozen base feature contract and ten prepared rating/choice/risk-tier fit/evaluation Parquet tables, fits five new models and emits a replacement schema2 package. The original research data directory is not required. See private `docs/FULL_NONCHAIN_TRAINING.md` for the explicit label-scale flag and table schema. Preparing genuine exposure negatives and time-correct future labels remains separate from fitting the models.
