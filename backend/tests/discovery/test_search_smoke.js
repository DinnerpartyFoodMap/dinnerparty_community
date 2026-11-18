const express = require('express');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-search-'));
process.env.DB_FILE = path.join(tempDirectory, 'search.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { db, init } = require('../../infrastructure/database');
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
const searchRouter = require('../../modules/discovery/routes/search');
const {
    rankSemanticRows,
    buildEmbeddingQuery,
    placeDetailCompleteness,
    isConfidentRecommendationReview,
    passesLocalRecommendationThreshold
} = require('../../modules/discovery/services/semanticSearch');
const {
    parseIntentExpansionContent,
    parseRecommendationReviewsContent
} = require('../../infrastructure/aiClients');
const {
    renderTemplate,
    verifiedEvidence,
    pickTemplate,
    reasonSlots,
    recommendationReason,
    validateTemplates
} = require('../../modules/discovery/services/recommendationReason');
const recommendationTemplates = require('../../modules/discovery/recommendationTemplates.json');

async function main() {
    init();
    db._raw.exec('BEGIN');
    db._raw.prepare(`INSERT INTO Place (name, category, description, latitude, longitude)
                     VALUES (?, ?, ?, ?, ?)`)
        .run('搜索烟测地点', '测试分类', '包含双轨烟测关键词', 23.1291, 113.2644);
    const app = express();
    app.use(express.json());
    app.use('/api', searchRouter);

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const fastResponse = await fetch(`${baseUrl}/api/places/search/fast?q=${encodeURIComponent('双轨烟测关键词')}&lat=23.1291&lng=113.2644`);
        const fastBody = await fastResponse.json();
        if (!fastResponse.ok || !Array.isArray(fastBody) || !fastBody.some((place) => place.name === '搜索烟测地点')) {
            throw new Error('fast search did not match the fixture description');
        }
        const smokePlace = fastBody.find((place) => place.name === '搜索烟测地点');
        assert.equal(smokePlace.distance_km, 0, 'fast search should include distance from map center');

        const ranked = rankSemanticRows([
            { id: 1, name: '远处高语义地点', latitude: 39.9042, longitude: 116.4074, vector_distance: 0.02 },
            { id: 2, name: '附近匹配地点', latitude: 23.1301, longitude: 113.2654, vector_distance: 0.18 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(ranked[0]?.place?.id, 2, 'nearby semantic result should outrank a remote city');
        assert.equal(ranked.some((match) => match.place.id === 1), false, 'remote candidates should be excluded');
        const rankedInsideView = rankSemanticRows([
            { id: 4, name: '屏幕中心普通匹配', latitude: 23.1291, longitude: 113.2644, vector_distance: 0.16 },
            { id: 5, name: '屏幕边缘精准匹配', latitude: 23.155, longitude: 113.295, vector_distance: 0.05 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(rankedInsideView[0]?.place?.id, 5, 'distance inside the viewport must not override semantic relevance');
        assert.ok(rankedInsideView[0]?.score < rankedInsideView[0]?.semantic_score, 'sparse details should reduce recommendation weight');
        const widenedForRemoteMatch = rankSemanticRows([
            {
                id: 11,
                name: 'Weak local placeholder',
                category: '其他',
                description: '求探',
                latitude: 23.1291,
                longitude: 113.2644,
                vector_distance: 0.18
            },
            {
                id: 12,
                name: 'Strong remote match',
                category: 'Indian cuisine',
                description: 'Detailed evidence about Indian dishes, spices, dining experience, suitable guests, service, and other facts that directly support the requested cuisine.',
                per_person_cost: 68,
                latitude: 23.25,
                longitude: 113.34,
                vector_distance: 0.16
            }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(widenedForRemoteMatch[0]?.place?.id, 12, 'a weak in-view result must not block a stronger remote match');
        assert.equal(placeDetailCompleteness({ name: '森焱食馆', category: '其他', description: '', per_person_cost: null }), 0);
        assert.equal(placeDetailCompleteness({
            name: '资料完整地点',
            category: '印度菜',
            description: '这是一段超过八十字的详细介绍，包含餐厅的招牌风味、用餐环境、适合人群、营业时段和实际体验等有效信息，用于帮助用户理解这家店为什么符合当前搜索需求，而不是只有一个没有上下文的店名。',
            per_person_cost: 68
        }), 1);
        const detailWeighted = rankSemanticRows([
            { id: 9, name: '高语义但资料空白', category: '其他', description: '', per_person_cost: null, latitude: 23.1291, longitude: 113.2644, vector_distance: 0.03 },
            { id: 10, name: '资料完整且相关', category: '印度菜', description: '提供详细菜系、招牌风味、用餐环境和适合人群的信息，内容足以支撑推荐理由，并帮助用户判断是否符合当前需求。这家店还有清晰的人均价格和具体分类，不需要模型凭空猜测。', per_person_cost: 68, latitude: 23.13, longitude: 113.265, vector_distance: 0.16 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(detailWeighted[0]?.place?.id, 10, 'complete details should outweigh a slightly higher but unsupported semantic match');
        const rankedWithoutWarnings = rankSemanticRows([
            { id: 7, name: '高匹配避雷地点', category: '印度菜, 避雷', latitude: 23.1291, longitude: 113.2644, vector_distance: 0.01 },
            { id: 8, name: '正常推荐地点', category: '印度菜', latitude: 23.13, longitude: 113.265, vector_distance: 0.12 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(rankedWithoutWarnings[0]?.place?.id, 8, '避雷地点 must never enter AI recommendations');
        assert.equal(rankedWithoutWarnings.some((match) => match.place.id === 7), false);
        const parsedExpansion = parseIntentExpansionContent(
            '```json\n{"needs_expansion":true,"retrieval_text":"菜品摆盘精致、适合拍照且用餐环境有氛围感"}\n```',
            '想吃一顿漂亮饭'
        );
        const prettyMealProfile = buildEmbeddingQuery('想吃一顿漂亮饭', parsedExpansion);
        assert.equal(prettyMealProfile.expanded, true, 'a DeepSeek-classified implicit intent should be expanded');
        assert.match(prettyMealProfile.text, /摆盘精致/);
        assert.equal(prettyMealProfile.minimumSemanticScore, 0.55);
        const parsedLiteral = parseIntentExpansionContent(
            '{"needs_expansion":false,"retrieval_text":"印度菜"}',
            '印度菜'
        );
        const normalProfile = buildEmbeddingQuery('印度菜', parsedLiteral);
        assert.equal(normalProfile.expanded, false, 'a DeepSeek-classified literal query should keep the normal threshold');
        const malformedExpansion = parseIntentExpansionContent('not json', '随便吃点');
        assert.deepEqual(malformedExpansion, {
            needs_expansion: false,
            retrieval_text: '随便吃点',
            source: 'original'
        }, 'malformed DeepSeek output should fall back to the original query');
        const expandedIntentMatch = rankSemanticRows([
            { id: 6, name: '适合拍照的精致餐厅', latitude: 23.1291, longitude: 113.2644, vector_distance: 0.44 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5,
            minimumSemanticScore: prettyMealProfile.minimumSemanticScore
        });
        assert.equal(expandedIntentMatch[0]?.place?.id, 6, 'expanded slang intent should allow a moderately similar relevant place');
        const irrelevant = rankSemanticRows([
            { id: 3, name: '附近但不相关地点', latitude: 23.1291, longitude: 113.2644, vector_distance: 0.5 }
        ], {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 },
            limit: 5
        });
        assert.equal(irrelevant.length, 0, 'distance must not rescue a semantically irrelevant place');
        const reviewMatches = [
            { place: { name: 'Supported Place' } },
            { place: { name: 'Generic Place' } },
            { place: { name: 'Rejected Place' } }
        ];
        const parsedReviews = parseRecommendationReviewsContent(JSON.stringify({
            recommendations: [
                { name: 'Generic Place', relevant: true, confidence: 0.42, evidence: '  maybe   fits ' },
                { name: 'Supported Place', relevant: true, confidence: 0.91, evidence: 'fresh fish congee', reason: 'Supported Place is great!' },
                { name: 'Rejected Place', relevant: false, confidence: 0.9, evidence: 'should be dropped' }
            ]
        }), reviewMatches);
        assert.equal(isConfidentRecommendationReview(parsedReviews[0]), true, 'a well-supported review should pass');
        assert.equal(isConfidentRecommendationReview(parsedReviews[1]), false, 'a low-confidence review should be rejected');
        assert.equal(parsedReviews.filter((review) => isConfidentRecommendationReview(review)).length, 1, 'review filtering should preserve only confident matches');
        assert.equal(parsedReviews[0].evidence, 'fresh fish congee', 'evidence should map to the exact place name');
        assert.equal(parsedReviews[1].evidence, 'maybe fits', 'evidence whitespace should be normalised');
        assert.equal(parsedReviews[2].evidence, '', 'an irrelevant place keeps no evidence');
        assert.ok(parsedReviews.every((review) => !('reason' in review)), 'the review must not carry model-written reasons');
        const allLowConfidence = parseRecommendationReviewsContent(JSON.stringify({
            recommendations: reviewMatches.map((match) => ({
                name: match.place.name,
                relevant: true,
                confidence: 0.2,
                evidence: ''
            }))
        }), reviewMatches);
        assert.equal(allLowConfidence.filter((review) => isConfidentRecommendationReview(review)).length, 0, 'low confidence must allow zero recommendations');
        assert.equal(passesLocalRecommendationThreshold({ score: 0.57 }), false, 'local fallback should reject weak adjusted scores');
        assert.equal(passesLocalRecommendationThreshold({ score: 0.59 }), true, 'local fallback should retain sufficiently strong adjusted scores');

        // DSC-C09: recommendation sentences come only from fixed templates, place fields,
        // the user's own query and verbatim excerpts of the place description.
        assert.deepEqual(validateTemplates(), [], 'recommendationTemplates.json must pass the template checks');
        assert.ok(validateTemplates({ withExcerpt: ['「{name}」[{excerpt}]'], withoutExcerpt: ['{name}人均 {price} 元'] }).length >= 2,
            'an optional excerpt or an unbracketed optional slot must be reported');
        assert.ok(validateTemplates({ withExcerpt: ['「{name}」「{excerpt}」[[{price}]]'], withoutExcerpt: ['「{name}」{shop}'] }).length >= 2,
            'nested brackets and unknown slots must be reported');
        const nameProblems = validateTemplates({ withExcerpt: ['简介里写着「{excerpt}」。'], withoutExcerpt: ['去看看吧。'] });
        assert.ok(nameProblems.length === 1 && nameProblems[0].startsWith('withoutExcerpt[0]'),
            'only templates without an excerpt must name the place; excerpt templates may say 这家');
        assert.equal(reasonSlots('想吃牛排', { place: { name: '牛排馆', category: '牛排, 避雷, 其他, 西餐, 牛排, 待探索, 快餐, 烧烤' } }).category, '牛排、西餐、快餐',
            'tags drop 其他/避雷/待探索 and repeats, keep three and join with 、');
        assert.equal(reasonSlots('想吃牛排', { place: { name: '牛排馆', category: '其他' } }).category, '',
            'a place tagged only 其他 has no category in the sentence');
        assert.equal(reasonSlots('想吃牛排', { place: { name: '牛排馆' }, distance_km: 0.8 }).distance, '800 米', 'distance is spoken in metres below 1 km');
        assert.equal(reasonSlots('想吃牛排', { place: { name: '牛排馆' }, distance_km: 0.0003 }).distance, '', 'a place at the map centre has no distance to mention');
        const fishPlace = { name: '粥粥小馆', description: '**招牌**是新鲜的砂锅鱼片粥，晚上营业到两点。' };
        assert.equal(verifiedEvidence('招牌是新鲜的砂锅鱼片粥', fishPlace), '招牌是新鲜的砂锅鱼片粥', 'a verbatim excerpt of the plain description passes');
        assert.equal(verifiedEvidence('「招牌是新鲜的砂锅鱼片粥，」', fishPlace), '招牌是新鲜的砂锅鱼片粥', 'edge quotes and punctuation are trimmed');
        assert.equal(verifiedEvidence('招牌是很新鲜的砂锅鱼片粥', fishPlace), '', 'a paraphrased excerpt is dropped');
        assert.equal(verifiedEvidence('招牌', fishPlace), '', 'an excerpt shorter than four characters is dropped');
        assert.equal(verifiedEvidence('粥粥小馆', { name: '粥粥小馆', description: '粥粥小馆就在路口' }), '', 'an excerpt equal to the shop name is dropped');
        assert.equal(verifiedEvidence('新鲜的砂锅鱼片粥晚上营业到两点', fishPlace), '', 'pieces joined across the original text are dropped');

        assert.equal(renderTemplate('「{name}」[，人均 {price} 元][（{category}）]', { name: '{query}[x]', price: '', category: '粥' }),
            '「{query}[x]」（粥）', 'values are inserted once and empty optional segments disappear');
        const fishMatch = { place: { ...fishPlace, category: '粥铺', per_person_cost: 45 }, distance_km: 0.8 };
        const withExcerpt = recommendationReason('想吃鱼片粥', fishMatch, '招牌是新鲜的砂锅鱼片粥', 0);
        assert.ok(withExcerpt.includes('「招牌是新鲜的砂锅鱼片粥」'), 'the excerpt template quotes the verified text');
        assert.equal(recommendationReason('想吃鱼片粥', fishMatch, '招牌是新鲜的砂锅鱼片粥', 0), withExcerpt, 'the same query renders the same sentence');
        const withoutExcerpt = recommendationReason('想吃鱼片粥', { place: { name: '无名小店' } }, '', 0);
        assert.ok(withoutExcerpt.includes('无名小店') && !/[{}[\]]/.test(withoutExcerpt), 'a place without optional fields still renders cleanly');
        const cardTemplates = [0, 1, 2].map((index) => pickTemplate('withoutExcerpt', '想吃鱼片粥', index));
        assert.equal(new Set(cardTemplates).size, Math.min(3, recommendationTemplates.withoutExcerpt.length), 'cards of one search use different templates');

        // AI search needs a logged-in resident.
        const aiBodyText = JSON.stringify({
            q: '想吃新鲜的鱼粥',
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 }
        });
        const anonymous = await fetch(`${baseUrl}/api/places/search/ai`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: aiBodyText
        });
        assert.equal(anonymous.status, 401, 'AI search must require login');
        const userId = randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(userId, '搜索烟测住民', 'unused');
        const token = jwt.sign({ id: userId }, process.env.JWT_SECRET || 'yuyuko_secret_key');
        const aiResponse = await fetch(`${baseUrl}/api/places/search/ai`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: aiBodyText
        });
        const aiBody = await aiResponse.json();
        if (![200, 503].includes(aiResponse.status)
            || !Object.prototype.hasOwnProperty.call(aiBody, 'recommendation')
            || !Array.isArray(aiBody.recommendations)) {
            throw new Error('AI search returned an invalid response shape');
        }
        console.log(JSON.stringify({
            fastStatus: fastResponse.status,
            fastResultCount: fastBody.length,
            aiStatus: aiResponse.status,
            aiMode: aiBody.status
        }));
    } finally {
        await new Promise((resolve) => server.close(resolve));
        db._raw.exec('ROLLBACK');
        db.close();
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    try { db.close(); } catch (closeError) { }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    process.exitCode = 1;
});
