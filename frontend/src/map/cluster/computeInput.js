import { placeKey, isMappableCoordinate } from './engine.js';
import { forEachInSlices } from './cooperative.js';

// Keep display fields on the caller and transfer only the index input.
export async function prepareClusterInput(places, options) {
    const input = Array.isArray(places) ? places : [];
    const byKey = new Map();
    const keys = [], aggregateCells = [], aggregates = [];
    const coordinates = new Float64Array(input.length * 2);
    await forEachInSlices(input, (place) => {
        const key = placeKey(place);
        if (!key || byKey.has(key)) return;
        const lng = Number(place.longitude), lat = Number(place.latitude);
        if (!isMappableCoordinate(lng, lat)) return;
        const index = keys.length;
        coordinates[index * 2] = lng;
        coordinates[index * 2 + 1] = lat;
        byKey.set(key, place);
        keys.push(key);
        aggregateCells.push(place.aggregateCell ?? null);
        aggregates.push(!!place.aggregate);
    }, options);
    return { byKey, data: { keys, coordinates, aggregateCells, aggregates } };
}
