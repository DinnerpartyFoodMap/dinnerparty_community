import { useLayoutEffect, useRef, useState } from 'react';
import { createExternalSearchController, searchExternalPlaces } from '../externalSearch.js';

export function useExternalSearch(query, resetKey, base) {
    const [state, setState] = useState({ query: '', results: [], loading: false, loaded: false, error: '' });
    const baseRef = useRef(base); baseRef.current = base;
    const controllerRef = useRef(null);
    if (!controllerRef.current) controllerRef.current = createExternalSearchController(
        options => searchExternalPlaces(baseRef.current, options), setState
    );
    const controller = controllerRef.current;
    const contextKey = `${base}:${resetKey}`;
    useLayoutEffect(() => { controller.setContext(query, contextKey); }, [controller, query, contextKey]);
    useLayoutEffect(() => () => controller.dispose(), [controller]);
    return { ...state, search: options => { controller.setContext(query, contextKey); return controller.search(options); } };
}
