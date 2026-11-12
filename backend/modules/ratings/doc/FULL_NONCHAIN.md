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

The private `research-full-nonchain-4b-v3` directory carries the model files, manifest, feature contract, profile normalization and newly fitted 4B PCA transforms, provenance and Python numeric fixtures. All inference model files and transforms are fingerprinted. Responses and pagination bind the actual model ID/hash; a same-name package with changed weights cannot silently reuse the previous identity.

Full-model embeddings now reuse the backend's existing `Qwen/Qwen3-Embedding-4B` API at 1024 dimensions. They use explicit L2 normalization then float32 rounding; real reviews are individually encoded before averaging. Descriptions use the research template with a 400-character description body, reviews are trimmed to 300 characters, and complete inputs are capped at 12000 characters. Provider tokenization/pooling replaces the old local 128-token/float16 path. The recipe ID `siliconflow-4b-1024-l2-f32-v1` is our preprocessing version, not a provider-pinned checkpoint. Hosted numerical variation/upstream changes remain possible; changing providers/models requires re-encoding and retraining. Map/six-axis vectors keep their existing 4B model, but the map text template differs and those cached vectors are not reused as rating features.

Re-encoding uses the same previously seen Google development inputs: 58,723 descriptions and 1,166,202 eligible review records (1,156,532 unique texts), yielding mean review vectors for 48,136 restaurants. No production or confirmation/sealed data is introduced.

`PlaceModelProfile` stores versioned derived assets and input hashes. The two 1024-dimension embeddings are BLOB columns `description_embedding` / `review_embedding` (little-endian float32, 4 KB each; readers get `Float32Array`); everything else, including the projections, stays JSON in `assets`. A review mean is rounded to float32 before projection, so stored and projected values agree. Databases from before this layout (vectors as JSON arrays inside `assets`, about 36 KB a row) are converted losslessly at startup by `initModelProfileSchema`, which then runs one `VACUUM` when a quarter or more of the file is free (if that VACUUM fails or is interrupted, SQLite reuses the free pages; run `VACUUM` by hand to shrink the file). The background worker processes visible places, retries malformed/failed extraction and rejects writes when content changes during a request. It reads genuine comments for review features. Ranking requests read current matching assets and do not call an LLM or encoder. Original-recipe mean imputation is explicit in the feature contract; raw missing status is retained.

## Deployment

Paired private implementation/package: private `main` commit `2d3ed8c`.

Deploy the paired private Node model package, including `research-full-nonchain-4b-v3`, before the backend. Remove an obsolete explicit `RECOMMENDATION_MODEL_DIR`, or point it to the 4B package. See the private repository's `docs/UNIFIED_4B.md`:

- Reuse existing `SILICONFLOW_API_KEY`, `SILICONFLOW_BASE_URL` and `EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B`.
- `MODEL_FEATURE_EMBEDDING_URL/TOKEN` are obsolete and ignored; no auxiliary encoder, Python/Torch image or Hugging Face cache is required in production.
- Existing DeepSeek configuration supplies asynchronous DS/RV profile extraction. No credentials or source user IDs enter the prompt.
- `MODEL_PROFILE_MODE=off` disables profile extraction. Setting all four rating/ranking modes to `off` also stops background extraction during rollback.

No production database is accessed or deployed by this code change. Background profiles use the new model hash, so old 0.6B assets cannot be mistaken for 4B. While new assets warm or API calls fail, the contract's missing-feature behavior applies and existing map aggregate fallback is preserved. Operational validation must check ready profile/embedding coverage; model availability alone does not mean all inputs are populated. Frontend and iOS display contracts are unchanged and do not require rebuilding for this encoder migration.

## Four-level adaptation

Research stars and product levels use the declared linear ordinal mapping `native5 = 1 + 4*(local4-1)/3`. Native5 histogram fields use adjacent-bin fractional mass so counts and means are conserved. Variance and threshold features use the actual mapped scores. This is a feature adapter, not a statement that local levels are equivalent to Google stars. For example, the original `>=4` positive-history test selects only local level4 under this mapping. Later native-four-level training can replace this adapter through a new contract/version.

Risk thresholds are calibrated on already-seen development data and do not guarantee the same local false-positive rate. Ratings and recommendation hit rates need forward local evaluation; original Google full-chain improvements cannot be claimed for this non-chain ablation. Sealed test/confirmation data are not opened as part of migration.

## Frozen development result and verification

The full non-chain ranker uses 254 features and 300 LambdaRank trees, trained on 2,421,171 candidate rows (131,390 groups) and evaluated on 2,986,323 rows (161,694 groups). The 4B target-micro first-pick hit is 21.9860%, versus the frozen 0.6B result 21.9421%; every evaluation target/user/candidate/label and row order is checked equal. This is a small development-set difference, not an established product gain. Identical original benchmark identities give 18.0236% without history and 21.9551% for the old full-feature reference. This is not the original user-macro/tie-credit metric and must not be compared directly to the 23.24% confirmation headline.

Personal-rating training uses 89,492 examples across 12 quarters and 11,773 development-evaluation examples; 4B native-five-star per-user MSE is 1.02630 versus 1.02938 for 0.6B on the same samples. Public P98 correction is a separate local fit, not a claim that this personal-rating metric measures the displayed public score.

The risk recipe is frozen from v2 before the 4B evaluation: content without chain features at prefixes 1 and 3, leniency-only at prefix 5. The 4B AUCs are 0.78632/0.80650/0.84094; recall at approximately 5% development FPR is 0.26648/0.34808/0.39809. Risk does not improve consistently. Original recipe selection was post-hoc development selection; neither old nor new thresholds imply an independent future guarantee.

Verification covers actual Python/Node model predictions, all 254 original P93 synthetic-feature columns, P86 prefix/rater/content golden features, authenticated HTTP integration and actual frozen-pack product regressions. Hosted encoder compatibility is checked separately from deterministic numerical tree parity. No container build, Xcode build or server rollout is claimed.

The completed 4B verification passes 71/71 private Node tests with zero skips, 63/63 paired backend test files, desktop/mobile browser regressions, standalone five-model own-data retraining and the encoding cache/protocol tests. The frozen manifest hash is `efc045a0254dc04c522e8b9414d18ee78370940b8b80e13db5e7a5485c7ee869`.

The private `scripts/train_full_feature_tables.py` provides a standalone own-data retraining entry. It uses only a frozen base feature contract and ten prepared rating/choice/risk-tier fit/evaluation Parquet tables, fits five new models and emits a replacement schema2 package. The original research data directory is not required. See private `docs/FULL_NONCHAIN_TRAINING.md` for the explicit label-scale flag and table schema. Preparing genuine exposure negatives and time-correct future labels remains separate from fitting the models.
