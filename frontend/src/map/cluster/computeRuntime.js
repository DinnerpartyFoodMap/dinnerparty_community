import { ClusterEngine, normalizePlaces, dataSignature } from './engine.js';
import { buildSnapshot, resolveMarkerZoom, stabilizeMarkerAnchors } from './snapshot.js';
import { planTransition } from './transitions.js';
import { revealZoom } from '../clusterZoom.js';

const stale = () => Object.assign(new Error('The map data has changed'), { code:'STALE_DATA' });

// Pure worker-side state, also exercised without a browser by protocol tests.
export function createComputeRuntime() {
    let engine = null, revision = null, active = null, candidate = null, snapshotId = 0, builds = 0, dataBounds = null;
    const findSnapshot = dataRevision => {
        const snapshot = [active,candidate].find(item=>item?.dataRevision === dataRevision);
        if (!snapshot) throw stale();
        return snapshot;
    };
    return {
        async handle(message) {
            const {op,payload = {},dataRevision} = message;
            if (op === 'dispose') { engine = active = candidate = null; revision = null; return {}; }
            if (op === 'commitAck') {
                if (candidate?.snapshotId === payload.snapshotId) { active = candidate; candidate = null; }
                return {};
            }
            if (op === 'compute') {
                const started = performance.now();
                let indexMs = 0;
                if (payload.data) {
                    const {keys,coordinates,aggregateCells,aggregates} = payload.data;
                    const normalized = normalizePlaces(keys.map((key,i)=>({
                        aggregateKey:key,longitude:coordinates[i*2],latitude:coordinates[i*2+1],
                        aggregate:!!aggregates[i],aggregateCell:aggregateCells[i]
                    })));
                    const signature = dataSignature(normalized);
                    if (!engine || engine.signature !== signature) {
                        const indexStarted = performance.now();
                        engine = new ClusterEngine(normalized,payload.options,signature); builds++;
                        indexMs = performance.now() - indexStarted;
                    } else engine.updatePlaces(normalized);
                    revision = dataRevision;
                    dataBounds = normalized.length ? {
                        minLng:180,maxLng:-180,minLat:90,maxLat:-90
                    } : null;
                    for (const item of normalized) {
                        dataBounds.minLng = Math.min(dataBounds.minLng,item.lng); dataBounds.maxLng = Math.max(dataBounds.maxLng,item.lng);
                        dataBounds.minLat = Math.min(dataBounds.minLat,item.lat); dataBounds.maxLat = Math.max(dataBounds.maxLat,item.lat);
                    }
                }
                if (!engine || revision !== dataRevision) throw stale();
                const preparedAt = performance.now();
                const previous = active;
                const logicalZoom = payload.refining && previous?.dataRevision === revision
                    ? previous.logicalZoom
                    : resolveMarkerZoom(payload.zoom,previous?.logicalZoom,engine,payload.markerBand,
                        Number.isFinite(payload.viewZoom) ? ()=>payload.viewZoom : undefined);
                if (logicalZoom === null) return { skipped:true };
                const next = buildSnapshot(engine,{...payload,logicalZoom});
                const queriedAt = performance.now();
                const plan = planTransition(previous,next);
                stabilizeMarkerAnchors(previous,next,plan,{
                    zoom:payload.zoom,refining:payload.refining,selectedKey:payload.selectedKey
                });
                Object.assign(next,{snapshotId:++snapshotId,dataRevision});
                candidate = next;
                const nodes = next.visibleNodes.map(({place,...node})=>node);
                return {snapshotId:next.snapshotId,dataRevision,logicalZoom,nodes,plan,
                    refineAfterZoom:next.refineAfterZoom,queryMode:next.queryMode,markerBand:next.markerBand,
                    zoomRange:{min:engine.minZoom,max:engine.maxZoom},dataBounds,
                    metrics:{builds,inputCount:engine.size,indexMs,prepareMs:preparedAt-started,
                        queryMs:queriedAt-preparedAt,transitionMs:performance.now()-queriedAt,ms:performance.now()-started}};
            }
            const snapshot = findSnapshot(dataRevision);
            const index = snapshot.engine;
            if (op === 'reveal') return {zoom:revealZoom({engine:index,...payload})};
            let node = snapshot.nodeByKey.get(payload.nodeKey);
            // A split can remove a cluster from the visible topology while its
            // camera request still needs the members from this same data generation.
            if (!node && op === 'members') {
                const match = /^cluster:(\d+):(\d+)$/.exec(payload.nodeKey || '');
                if (match && Number(match[1]) === index.generation) {
                    node = {kind:'cluster',key:payload.nodeKey,clusterId:Number(match[2])};
                }
            }
            if (!node) throw stale();
            if (op === 'clusterInfo') return {expansionZoom:index.expansionZoom(node),aggregateOnly:!!node.aggregateOnly};
            if (op === 'members') return {keys:index.memberKeys(node)};
            throw new Error('Unknown map computation operation');
        }
    };
}
